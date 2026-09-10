import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Writable } from 'node:stream';
import type { Logger } from 'homebridge';

const IDLE_TIMEOUT_MS = 60000;
const MIN_STABLE_MS = 3000;
const BASE_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 30000;

/**
 * Keeps a single background ffmpeg process connected to the camera's RTSP/RTMP source and fans
 * its raw MPEG-TS output out to any number of live-view sessions, instead of every session
 * opening its own fresh connection.
 *
 * This mirrors what mature NVR-style implementations (e.g. Scrypted's rebroadcast) do, and for
 * good reason: establishing a brand new RTSP session and waiting for ffmpeg to analyze it takes
 * several real seconds on this class of camera even with tuned analyzeduration settings - often
 * long enough that HomeKit's own patience for the stream to start runs out before a single frame
 * gets through. Reusing one already-flowing, already-analyzed connection means a new live-view
 * session just has to pick up mid-stream, which ffmpeg does almost instantly since it doesn't
 * need to renegotiate anything - just find the next PAT/PMT and SPS, both of which repeat
 * constantly in a running MPEG-TS stream.
 */
export class LivePrebuffer {
  private process: ChildProcessWithoutNullStreams | undefined;
  private readonly sinks = new Set<Writable>();
  private idleTimer: NodeJS.Timeout | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private consecutiveFailures = 0;

  constructor(
    private readonly ffmpegPath: string,
    private readonly sourceUrl: string,
    private readonly isRtmp: boolean,
    private readonly log: Logger,
    private readonly label: string,
    private readonly debug: boolean,
  ) {}

  /** Registers a session's ffmpeg stdin as a destination for the prebuffered stream, starting the background connection if it isn't already running. */
  acquire(sink: Writable): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    // Without a handler here, a write to a sink whose process already exited (e.g. the session's
    // ffmpeg crashed but hasn't been released() yet) throws an unhandled 'error' that would crash
    // the whole child bridge process rather than just that one session.
    sink.on('error', () => this.sinks.delete(sink));
    this.sinks.add(sink);
    this.ensureRunning();
  }

  /** Unregisters a session. The background connection is kept warm for a short idle window in case another session starts soon, then torn down. */
  release(sink: Writable): void {
    this.sinks.delete(sink);
    if (this.sinks.size === 0 && !this.idleTimer) {
      this.idleTimer = setTimeout(() => this.stop(), IDLE_TIMEOUT_MS).unref();
    }
  }

  private ensureRunning(): void {
    if (this.process && !this.process.killed) {
      return;
    }
    // A reconnect is already scheduled (with backoff) after a recent failure - let it run on its
    // own timer rather than spawning immediately, or a burst of acquire() calls while the source
    // is unreachable would spawn ffmpeg processes as fast as Node can schedule them.
    if (this.reconnectTimer) {
      return;
    }

    this.spawnProcess();
  }

  private spawnProcess(): void {
    const args: string[] = ['-hide_banner', '-loglevel', this.debug ? 'verbose' : 'error'];
    args.push('-analyzeduration', '2000000', '-probesize', '1000000');
    if (this.isRtmp) {
      args.push('-i', this.sourceUrl);
    } else {
      args.push('-rtsp_transport', 'tcp', '-i', this.sourceUrl);
    }
    // Passthrough copy of both video and audio, regardless of the per-session codec/audio choice:
    // this stage only exists to keep one warm upstream connection, so sessions read whichever of
    // video/audio they need from this single relay. Re-encoding here would be redundant CPU work
    // (a transcoding session still decodes+encodes downstream from this pipe), and dump_extra
    // keeps SPS/PPS repeating before every keyframe so a session connecting mid-stream can decode
    // immediately instead of waiting for the next time the camera itself repeats them.
    args.push('-map', '0', '-codec', 'copy', '-bsf:v', 'dump_extra=freq=keyframe');
    args.push('-f', 'mpegts', 'pipe:1');

    this.log.info(`[${this.label}] Starting live view prebuffer connection`);
    const proc = spawn(this.ffmpegPath, args, { env: process.env });
    this.process = proc;
    const startedAt = Date.now();

    proc.stdout.on('data', (chunk: Buffer) => {
      for (const sink of this.sinks) {
        if (!sink.destroyed) {
          sink.write(chunk);
        }
      }
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      if (this.debug) {
        this.log.info(`[${this.label} prebuffer] ${chunk.toString().trim()}`);
      }
    });

    proc.once('error', (error) => {
      this.log.error(`[${this.label}] Live view prebuffer failed to start: ${error.message}`);
    });

    proc.once('close', () => {
      if (this.process === proc) {
        this.process = undefined;
      }
      if (this.sinks.size === 0) {
        return;
      }
      // Unexpected death while sessions are still watching: reconnect so they aren't left
      // hanging - but with escalating backoff, otherwise a source that's actually unreachable
      // (camera offline, network down) causes ffmpeg to be respawned in a tight loop as fast as
      // Node can schedule it, pegging CPU and burning file descriptors/ports on every attempt.
      // A connection that stayed up for a while before dying is treated as an unrelated, fresh
      // failure rather than compounding the backoff from before.
      if (Date.now() - startedAt >= MIN_STABLE_MS) {
        this.consecutiveFailures = 0;
      }
      const delay = Math.min(BASE_RECONNECT_DELAY_MS * 2 ** this.consecutiveFailures, MAX_RECONNECT_DELAY_MS);
      this.consecutiveFailures += 1;
      this.log.warn(`[${this.label}] Live view prebuffer connection lost, reconnecting in ${delay}ms`);
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = undefined;
        if (this.sinks.size > 0) {
          this.spawnProcess();
        }
      }, delay).unref();
    });
  }

  private stop(): void {
    this.idleTimer = undefined;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.consecutiveFailures = 0;
    if (this.process) {
      this.log.info(`[${this.label}] Stopping idle live view prebuffer connection`);
      this.process.kill('SIGTERM');
      this.process = undefined;
    }
  }
}
