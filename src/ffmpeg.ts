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

  constructor(ffmpegPath: string, args: string[], private readonly log: Logger, label: string, debug: boolean) {
    this.log.debug(`[${label}] Spawning: ${ffmpegPath} ${args.join(' ')}`);
    this.process = spawn(ffmpegPath, args, { env: process.env });

    this.process.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      if (debug) {
        this.log.debug(`[${label}] ${text.trim()}`);
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
      this.process.once('exit', (code, signal) => {
        if (code === null || code === 0 || signal === 'SIGKILL' || signal === 'SIGTERM') {
          resolve();
        } else {
          reject(new Error(`ffmpeg [${label}] exited with code ${code}:\n${this.stderrTail.join('')}`));
        }
      });
    });
  }

  stop(): void {
    if (this.process.exitCode === null && !this.process.killed) {
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
