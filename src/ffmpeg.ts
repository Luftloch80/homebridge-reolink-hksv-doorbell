import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Logger } from 'homebridge';

let bundledFfmpegPath: string | undefined;
try {
  // Optional dependency: static ffmpeg binaries for platforms it ships builds for.
  // A dynamic require (rather than a static import) is required so a missing/failed
  // install of this optional dependency doesn't prevent the plugin itself from loading.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  bundledFfmpegPath = require('ffmpeg-for-homebridge') as string | undefined;
} catch {
  bundledFfmpegPath = undefined;
}

export function resolveFfmpegPath(configuredPath: string | undefined): string {
  return configuredPath || bundledFfmpegPath || 'ffmpeg';
}

/**
 * Thin wrapper around a spawned ffmpeg process that logs stderr (ffmpeg's progress/diagnostic
 * channel) and exposes a promise that settles when the process exits.
 */
export class FfmpegProcess {
  readonly process: ChildProcessWithoutNullStreams;
  readonly exited: Promise<void>;
  private stderrTail: string[] = [];
  private stopRequested = false;

  constructor(ffmpegPath: string, args: string[], private readonly log: Logger, label: string, debug: boolean) {
    // `log.debug()` is gated by Homebridge's own global debug mode, which is a separate switch
    // from this plugin's "Debug-Logging" setting - using it here meant the plugin's own debug
    // toggle silently did nothing unless Homebridge itself was also launched in debug mode.
    // `log.info()` always prints, so it's used here to make the plugin's own toggle self-contained.
    if (debug) {
      this.log.info(`[${label}] Spawning: ${ffmpegPath} ${args.join(' ')}`);
    }
    this.process = spawn(ffmpegPath, args, { env: process.env });

    this.process.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      if (debug) {
        this.log.info(`[${label}] ${text.trim()}`);
      }
      this.stderrTail.push(text);
      if (this.stderrTail.length > 50) {
        this.stderrTail.shift();
      }
    });

    this.exited = new Promise((resolve, reject) => {
      this.process.once('error', (error) => {
        reject(error);
      });
      // 'close' (not 'exit') is used deliberately: 'exit' can fire before the stderr stream has
      // finished delivering its buffered 'data' events, which previously produced error messages
      // with an empty stderr tail even though ffmpeg had actually logged the real failure reason.
      this.process.once('close', (code, signal) => {
        // ffmpeg installs its own SIGTERM handler and, after cleaning up, calls exit(255) itself
        // rather than dying "by" the signal - so Node reports a plain code=255/signal=null close
        // here, not signal='SIGTERM', for what is actually the graceful shutdown we asked for via
        // stop(). Without tracking that we requested the stop, this looked identical to a crash.
        if (this.stopRequested || code === null || code === 0 || signal === 'SIGKILL' || signal === 'SIGTERM') {
          resolve();
        } else {
          reject(new Error(`ffmpeg [${label}] exited with code ${code}:\n${this.stderrTail.join('')}`));
        }
      });
    });
  }

  stop(): void {
    if (this.process.exitCode === null && !this.process.killed) {
      this.stopRequested = true;
      this.process.stdin.end();
      // Give ffmpeg a chance to shut down its streams gracefully before force-killing it.
      setTimeout(() => {
        if (this.process.exitCode === null && !this.process.killed) {
          this.process.kill('SIGKILL');
        }
      }, 3000).unref();
      this.process.kill('SIGTERM');
    }
  }
}
