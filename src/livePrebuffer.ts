import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Writable } from 'node:stream';
import type { Logger } from 'homebridge';

const IDLE_TIMEOUT_MS = 60000;
const MIN_STABLE_MS = 3000;
const BASE_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 30000;
// How much recently-seen output to keep around so a newly-joining session can be handed a running
// start instead of whatever byte happens to be flowing right now. This needs to reliably span at
// least one full GOP: `dump_extra=freq=keyframe` re-inserts SPS/PPS before every keyframe, but a
// session that joins live right after one was sent has to wait for the *next* one, which can be
// several seconds out - long enough that the session's own (deliberately short) analyzeduration
// gives up first, with ffmpeg unable to determine dimensions at all.
//
// Bounded by *time*, not size: the whole backlog gets replayed to a new sink in one instantaneous
// burst, which the session's own ffmpeg then races through many times faster than real time before
// it catches up to the live edge (observed at up to 30-40x in practice) - visible in HomeKit as a
// blurry fast-forward instant before playback settles, not a smooth stream start. A byte-based cap
// sized generously enough to survive a low-bitrate substream (some tens of KB/s) ends up holding
// many tens of seconds of history once the connection has been kept warm for a while, making that
// burst long enough to be clearly visible. A few seconds of history reliably covers a camera's GOP
// interval (typically 1-2s) while keeping the catch-up burst itself brief enough to be unnoticeable.
const BACKLOG_MAX_AGE_MS = 3000;
// Absolute safety net regardless of age, in case of an unexpectedly high-bitrate source - not the
// normal way this trims.
const BACKLOG_MAX_BYTES = 2 * 1024 * 1024;

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
  private readonly backlog: { chunk: Buffer; at: number }[] = [];
  private backlogBytes = 0;

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
    // Hand the new sink everything buffered so far before it starts receiving live chunks, so it
    // gets a running start (almost certainly including at least one keyframe+SPS/PPS) instead of
    // having to wait, live, for the next one to come around. This happens synchronously with no
    // await in between, so no live chunk can slip in between the backlog replay and the sink being
    // added to `sinks` below - no gap, no duplicate delivery.
    if (this.backlog.length > 0) {
      sink.write(Buffer.concat(this.backlog.map((entry) => entry.chunk), this.backlogBytes));
    }
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

    // Any previously buffered backlog belongs to the old connection - once it's gone, replaying
    // its (now stale, discontinuous) bytes to a session joining against the new connection would
    // do more harm than good, so start the new connection with a clean slate.
    this.backlog.length = 0;
    this.backlogBytes = 0;

    this.log.info(`[${this.label}] Starting live view prebuffer connection`);
    const proc = spawn(this.ffmpegPath, args, { env: process.env });
    this.process = proc;
    const startedAt = Date.now();

    proc.stdout.on('data', (chunk: Buffer) => {
      const now = Date.now();
      this.backlog.push({ chunk, at: now });
      this.backlogBytes += chunk.length;
      while (
        this.backlog.length > 1 &&
        (now - this.backlog[0].at > BACKLOG_MAX_AGE_MS || this.backlogBytes > BACKLOG_MAX_BYTES)
      ) {
        const dropped = this.backlog.shift();
        if (dropped) {
          this.backlogBytes -= dropped.chunk.length;
        }
      }
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
