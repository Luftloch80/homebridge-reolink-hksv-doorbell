import { EventEmitter, on, once } from 'node:events';
import type { CameraRecordingConfiguration, CameraRecordingDelegate, HAP, Logger, RecordingPacket } from 'homebridge';
import type { CameraConfig } from './configTypes';
import { FfmpegProcess } from './ffmpeg';
import { Mp4BoxReader } from './mp4Parser';
import type { ReolinkApi } from './reolink/reolinkApi';

const RESTART_DELAY_MS = 5000;

/**
 * Implements HomeKit Secure Video recording.
 *
 * Runs a single continuous ffmpeg transcode of the camera's RTSP stream into fragmented mp4
 * whenever recording is active, keeping the most recent fragments (covering
 * `CameraRecordingOptions.prebufferLength`) in memory. When a motion/doorbell event triggers a
 * HomeKit recording request, `handleRecordingStreamRequest` replays the buffered prebuffer
 * fragments first and then continues forwarding newly produced fragments live, so the resulting
 * clip includes footage from just before the triggering event.
 */
export class RecordingDelegate implements CameraRecordingDelegate {
  private readonly emitter = new EventEmitter();
  private active = false;
  private configuration: CameraRecordingConfiguration | undefined;
  private ffmpeg: FfmpegProcess | undefined;
  private initSegment: Buffer | undefined;
  private prebuffer: Buffer[] = [];
  private restartTimer: NodeJS.Timeout | undefined;
  private includesAudio = false;
  private maxFragments = 3;
  private getAudioActive: () => boolean = () => true;

  constructor(
    private readonly hap: HAP,
    private readonly log: Logger,
    private readonly cameraConfig: CameraConfig,
    private readonly reolink: ReolinkApi,
    private readonly ffmpegPath: string,
    private readonly debug: boolean,
  ) {}

  /** Wired up by the accessory once the CameraController's operating-mode service exists. */
  setAudioActiveGetter(getter: () => boolean): void {
    this.getAudioActive = getter;
  }

  /** Called by the accessory when `Characteristic.RecordingAudioActive` changes while active. */
  refreshAudioActive(): void {
    if (this.active && this.getAudioActive() !== this.includesAudio) {
      this.restartPipeline();
    }
  }

  updateRecordingActive(active: boolean): void {
    this.active = active;
    if (active) {
      this.startPipeline();
    } else {
      this.stopPipeline();
    }
  }

  updateRecordingConfiguration(configuration: CameraRecordingConfiguration | undefined): void {
    this.configuration = configuration;
    if (this.active) {
      this.restartPipeline();
    }
  }

  private restartPipeline(): void {
    this.stopPipeline();
    if (this.active) {
      this.startPipeline();
    }
  }

  private startPipeline(): void {
    if (this.ffmpeg || !this.configuration) {
      return;
    }

    this.includesAudio = this.getAudioActive() && this.cameraConfig.enableAudio !== false;
    this.initSegment = undefined;
    this.prebuffer = [];

    const fragmentMs = this.configuration.mediaContainerConfiguration.fragmentLength;
    const fragmentSeconds = fragmentMs / 1000;
    const capacity = Math.max(1, Math.ceil(this.configuration.prebufferLength / fragmentMs) + 1);
    this.maxFragments = capacity;

    const rtspUrl = this.reolink.getRtspUrl(this.cameraConfig.recordingStream ?? 'sub');
    const resolution = this.configuration.videoCodec.resolution;
    const bitRate = this.configuration.videoCodec.parameters.bitRate;

    const args: string[] = ['-hide_banner', '-loglevel', this.debug ? 'verbose' : 'error'];
    args.push('-rtsp_transport', 'tcp', '-i', rtspUrl);
    args.push(
      '-map', '0:v:0',
      '-codec:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-preset', 'veryfast',
      '-sc_threshold', '0',
      '-force_key_frames', `expr:gte(t,n_forced*${fragmentSeconds})`,
      '-r', String(resolution[2]),
      '-s', `${resolution[0]}x${resolution[1]}`,
      '-b:v', `${bitRate}k`,
      '-bufsize', `${bitRate * 2}k`,
    );

    if (this.includesAudio) {
      const audioCodec = this.configuration.audioCodec;
      args.push(
        '-map', '0:a:0?',
        '-codec:a', 'aac',
        '-ar', String(this.sampleRateToHz(audioCodec.samplerate)),
        '-b:a', `${audioCodec.bitrate}k`,
        '-ac', String(audioCodec.audioChannels ?? 1),
      );
    } else {
      args.push('-an');
    }

    args.push(
      '-f', 'mp4',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      '-min_frag_duration', String(Math.round(fragmentMs * 1000)),
      'pipe:1',
    );

    const proc = new FfmpegProcess(this.ffmpegPath, args, this.log, `${this.cameraConfig.name} recording`, this.debug);
    this.ffmpeg = proc;
    this.parseOutput(proc);

    proc.exited
      .catch((error: Error) => {
        this.log.error(`[${this.cameraConfig.name}] HKSV ffmpeg pipeline ended: ${error.message}`);
      })
      .finally(() => {
        // Only react if `proc` is still the pipeline we're tracking; stopPipeline()/restartPipeline()
        // may already have replaced or cleared it by the time this process actually exits.
        if (this.ffmpeg !== proc) {
          return;
        }
        this.ffmpeg = undefined;
        if (this.active) {
          this.restartTimer = setTimeout(() => this.startPipeline(), RESTART_DELAY_MS);
        }
      });
  }

  private sampleRateToHz(samplerate: number): number {
    switch (samplerate) {
      case this.hap.AudioRecordingSamplerate.KHZ_48:
        return 48000;
      case this.hap.AudioRecordingSamplerate.KHZ_44_1:
        return 44100;
      case this.hap.AudioRecordingSamplerate.KHZ_32:
        return 32000;
      case this.hap.AudioRecordingSamplerate.KHZ_24:
        return 24000;
      case this.hap.AudioRecordingSamplerate.KHZ_16:
        return 16000;
      default:
        return 8000;
    }
  }

  private async parseOutput(ffmpeg: FfmpegProcess): Promise<void> {
    const reader = new Mp4BoxReader(ffmpeg.process.stdout);
    const initChunks: Buffer[] = [];
    let fragmentChunks: Buffer[] = [];

    try {
      for await (const box of reader.boxes()) {
        if (!this.initSegment) {
          initChunks.push(box.raw);
          if (box.type === 'moov') {
            this.initSegment = Buffer.concat(initChunks);
            this.emitter.emit('init');
          }
          continue;
        }

        fragmentChunks.push(box.raw);
        if (box.type === 'mdat') {
          const fragment = Buffer.concat(fragmentChunks);
          fragmentChunks = [];
          this.pushFragment(fragment);
        }
      }
    } catch (error) {
      this.log.debug(`[${this.cameraConfig.name}] HKSV fragment parser stopped: ${(error as Error).message}`);
    }
  }

  private pushFragment(fragment: Buffer): void {
    this.prebuffer.push(fragment);
    while (this.prebuffer.length > this.maxFragments) {
      this.prebuffer.shift();
    }
    this.emitter.emit('fragment', fragment);
  }

  private stopPipeline(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    this.ffmpeg?.stop();
    this.ffmpeg = undefined;
    this.initSegment = undefined;
    this.prebuffer = [];
  }

  async *handleRecordingStreamRequest(streamId: number, signal?: AbortSignal): AsyncGenerator<RecordingPacket> {
    this.log.debug(`[${this.cameraConfig.name}] HKSV recording stream ${streamId} requested`);

    const eventsOptions = signal ? { signal } : {};
    // Register both subscriptions synchronously, before touching any buffered state, so nothing
    // the pipeline produces concurrently (fragments, or the init segment itself) can be lost or
    // double-delivered. `pushFragment` only ever runs after `initSegment` is set (see
    // `parseOutput`), so if the init segment isn't ready yet the prebuffer is guaranteed empty.
    const liveFragments = on(this.emitter, 'fragment', eventsOptions);
    const initReady = this.initSegment ? undefined : once(this.emitter, 'init', eventsOptions);
    const prebufferSnapshot = this.initSegment ? [...this.prebuffer] : [];

    let initSegment = this.initSegment;
    if (!initSegment) {
      try {
        await Promise.race([
          initReady,
          new Promise((_resolve, reject) => setTimeout(() => reject(new Error('timed out')), 15000)),
        ]);
      } catch (error) {
        if ((error as Error).name === 'AbortError') {
          return;
        }
        throw new Error('HKSV pipeline did not produce an initialization segment in time');
      }
      initSegment = this.initSegment;
    }
    if (!initSegment) {
      throw new Error('HKSV pipeline did not produce an initialization segment');
    }

    yield { data: initSegment, isLast: false };
    for (const fragment of prebufferSnapshot) {
      yield { data: fragment, isLast: false };
    }

    try {
      for await (const [fragment] of liveFragments) {
        yield { data: fragment as Buffer, isLast: false };
      }
    } catch (error) {
      if ((error as Error).name !== 'AbortError') {
        throw error;
      }
    }
  }

  acknowledgeStream(streamId: number): void {
    this.closeRecordingStream(streamId);
  }

  closeRecordingStream(streamId: number): void {
    this.log.debug(`[${this.cameraConfig.name}] HKSV recording stream ${streamId} closed`);
  }
}
