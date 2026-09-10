import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Writable } from 'node:stream';
import type { Logger } from 'homebridge';

const IDLE_TIMEOUT_MS = 60000;
const MIN_STABLE_MS = 3000;
const BASE_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 30000;
const TS_PACKET_SIZE = 188;
// How much recently-seen output to *keep available* so a newly-joining session can be handed a
// running start instead of whatever byte happens to be flowing right now - this needs to reliably
// span at least one full GOP, since `dump_extra=freq=keyframe` only re-inserts SPS/PPS before every
// keyframe. This window is intentionally generous (matching Scrypted's rebroadcast plugin, which
// keeps 10s) because - unlike an earlier version of this class - it no longer determines how much
// gets *replayed*: see lastKeyframeBytePos below and getBacklogSinceLastKeyframe(). A wide window
// mainly guards against unusually long GOP configurations; it doesn't cost a longer catch-up burst.
const BACKLOG_MAX_AGE_MS = 8000;
// Absolute safety net regardless of age, in case of an unexpectedly high-bitrate source - not the
// normal way this trims.
const BACKLOG_MAX_BYTES = 6 * 1024 * 1024;

interface BacklogEntry {
  chunk: Buffer;
  at: number;
  /** Byte offset of this chunk's first byte within the connection's continuous output stream. */
  startByte: number;
}

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
 *
 * A newly-joining session is handed the backlog *since the most recently seen keyframe* rather
 * than the whole backlog window - found by scanning the MPEG-TS stream's own packet headers for
 * the random_access_indicator flag (matching what Scrypted's rebroadcast plugin does via NAL
 * parsing, adapted here to the TS container ffmpeg wraps this output in). Without this, a session
 * joining a connection that's been kept warm for a while gets the *entire* multi-second window
 * dumped on it at once, which its own ffmpeg then races through far faster than real time before
 * settling to live - visible in HomeKit as a blurry fast-forward instant rather than a clean start.
 */
export class LivePrebuffer {
  private process: ChildProcessWithoutNullStreams | undefined;
  private readonly sinks = new Set<Writable>();
  private idleTimer: NodeJS.Timeout | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private consecutiveFailures = 0;
  private readonly backlog: BacklogEntry[] = [];
  private backlogBytes = 0;
  private totalBytes = 0;
  /** Leftover bytes (< one TS packet) carried over between stdout chunks so packet parsing stays aligned regardless of how the OS happens to chunk the pipe. */
  private tsCarry: Buffer = Buffer.alloc(0);
  /** Absolute byte offset (in the same coordinate space as BacklogEntry.startByte) of the start of the most recently seen keyframe's TS packet, or -1 if none has been seen yet on this connection. */
  private lastKeyframeBytePos = -1;

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
    // Hand the new sink the backlog since the last known keyframe before it starts receiving live
    // chunks, so it gets a running start (a keyframe+SPS/PPS right at the beginning of what it
    // receives) instead of having to wait, live, for the next one to come around. This happens
    // synchronously with no await in between, so no live chunk can slip in between the backlog
    // replay and the sink being added to `sinks` below - no gap, no duplicate delivery.
    const replay = this.getBacklogSinceLastKeyframe();
    if (replay.length > 0) {
      sink.write(replay);
    }
    this.sinks.add(sink);
    this.ensureRunning();
  }

  /**
   * Returns the backlog trimmed to start at the most recently detected keyframe, so a joining
   * session gets the smallest amount of "past" data that still reliably includes one. Falls back
   * to the full backlog if no keyframe has been located yet (e.g. right at connection start) -
   * the same behavior this class had before keyframe-precise trimming existed.
   */
  private getBacklogSinceLastKeyframe(): Buffer {
    if (this.backlog.length === 0) {
      return Buffer.alloc(0);
    }
    if (this.lastKeyframeBytePos < 0) {
      return Buffer.concat(this.backlog.map((entry) => entry.chunk), this.backlogBytes);
    }
    const parts: Buffer[] = [];
    let total = 0;
    for (const entry of this.backlog) {
      if (entry.startByte + entry.chunk.length <= this.lastKeyframeBytePos) {
        continue;
      }
      const sliceStart = Math.max(0, this.lastKeyframeBytePos - entry.startByte);
      const piece = sliceStart > 0 ? entry.chunk.subarray(sliceStart) : entry.chunk;
      parts.push(piece);
      total += piece.length;
    }
    return Buffer.concat(parts, total);
  }

  /**
   * Scans a chunk of MPEG-TS output for packets that mark the start of a keyframe access unit,
   * updating lastKeyframeBytePos when one is found. TS packets are a fixed 188 bytes, but stdout
   * delivers arbitrary byte chunks with no relation to that boundary, so leftover bytes from an
   * incomplete trailing packet are carried over (via tsCarry) and prepended to the next chunk.
   *
   * A packet marks a keyframe start when its payload_unit_start_indicator is set (a new access
   * unit begins here) and its adaptation field's random_access_indicator is set - ffmpeg's mpegts
   * muxer sets this for the video stream specifically at each keyframe, which - combined with
   * `dump_extra=freq=keyframe` upstream guaranteeing SPS/PPS immediately follows - is exactly the
   * point a joining session needs to start reading from.
   */
  private scanForKeyframes(chunk: Buffer, chunkStartByte: number): void {
    const buf = this.tsCarry.length > 0 ? Buffer.concat([this.tsCarry, chunk]) : chunk;
    const bufStartByte = chunkStartByte - this.tsCarry.length;
    let offset = 0;
    while (offset + TS_PACKET_SIZE <= buf.length) {
      if (buf[offset] !== 0x47) {
        // Lost sync with the 188-byte packet grid - shouldn't normally happen against ffmpeg's own
        // mpegts output, but resync defensively rather than misreading adaptation field flags from
        // the wrong byte offset for the rest of the stream.
        offset += 1;
        continue;
      }
      const payloadUnitStart = (buf[offset + 1] & 0x40) !== 0;
      const adaptationFieldControl = (buf[offset + 3] & 0x30) >> 4;
      const hasAdaptationField = adaptationFieldControl === 2 || adaptationFieldControl === 3;
      if (payloadUnitStart && hasAdaptationField) {
        const adaptationFieldLength = buf[offset + 4];
        if (adaptationFieldLength > 0 && (buf[offset + 5] & 0x40) !== 0) {
          this.lastKeyframeBytePos = bufStartByte + offset;
        }
      }
      offset += TS_PACKET_SIZE;
    }
    this.tsCarry = buf.subarray(offset);
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
    // do more harm than good, so start the new connection with a clean slate. The byte-offset
    // tracking and keyframe scan state reset the same way, since they're only meaningful relative
    // to a single connection's continuous output stream.
    this.backlog.length = 0;
    this.backlogBytes = 0;
    this.totalBytes = 0;
    this.tsCarry = Buffer.alloc(0);
    this.lastKeyframeBytePos = -1;

    this.log.info(`[${this.label}] Starting live view prebuffer connection`);
    const proc = spawn(this.ffmpegPath, args, { env: process.env });
    this.process = proc;
    const startedAt = Date.now();

    proc.stdout.on('data', (chunk: Buffer) => {
      const now = Date.now();
      const startByte = this.totalBytes;
      this.totalBytes += chunk.length;
      this.scanForKeyframes(chunk, startByte);

      this.backlog.push({ chunk, at: now, startByte });
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
