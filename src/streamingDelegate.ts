import type {
  CameraStreamingDelegate,
  HAP,
  Logger,
  PrepareStreamCallback,
  PrepareStreamRequest,
  PrepareStreamResponse,
  SnapshotRequest,
  SnapshotRequestCallback,
  StartStreamRequest,
  StreamingRequest,
  StreamRequestCallback,
} from 'homebridge';
import type { CameraConfig } from './configTypes';
import { FfmpegProcess } from './ffmpeg';
import { reservePorts } from './ports';
import type { ReolinkApi } from './reolink/reolinkApi';

function h264ProfileToFfmpeg(hap: HAP, profile: number): string {
  switch (profile) {
    case hap.H264Profile.HIGH:
      return 'high';
    case hap.H264Profile.MAIN:
      return 'main';
    default:
      return 'baseline';
  }
}

function h264LevelToFfmpeg(hap: HAP, level: number): string {
  switch (level) {
    case hap.H264Level.LEVEL4_0:
      return '4.0';
    case hap.H264Level.LEVEL3_2:
      return '3.2';
    default:
      return '3.1';
  }
}

function srtpSuiteToFfmpeg(hap: HAP, suite: number): string {
  return suite === hap.SRTPCryptoSuites.AES_CM_256_HMAC_SHA1_80 ? 'AES_CM_256_HMAC_SHA1_80' : 'AES_CM_128_HMAC_SHA1_80';
}

/**
 * HomeKit's SSRC is an unsigned 32-bit value, but ffmpeg's `-ssrc` option parses it as a
 * signed 32-bit integer and rejects anything above INT32_MAX ("out of range"). The RTP
 * SSRC field itself is just 32 raw bits with no sign, so converting to the equivalent
 * signed two's-complement representation keeps the exact same bits on the wire while
 * satisfying ffmpeg's range check.
 */
function toFfmpegSsrc(ssrc: number): number {
  return ssrc > 0x7fffffff ? ssrc - 0x100000000 : ssrc;
}

interface OngoingSession {
  videoFfmpeg: FfmpegProcess;
  audioFfmpeg: FfmpegProcess | undefined;
  localVideoPort: number;
  localAudioPort: number;
}

/**
 * Handles HomeKit's interactive live view requests by transcoding the camera's RTSP
 * stream into SRTP with ffmpeg, and jpeg snapshots by fetching them directly from the
 * Reolink Snap.cgi endpoint.
 */
interface PendingSession {
  request: PrepareStreamRequest;
  localVideoPort: number;
  localAudioPort: number;
}

export class StreamingDelegate implements CameraStreamingDelegate {
  private readonly pendingSessions = new Map<string, PendingSession>();
  private readonly ongoingSessions = new Map<string, OngoingSession>();

  constructor(
    private readonly hap: HAP,
    private readonly log: Logger,
    private readonly cameraConfig: CameraConfig,
    private readonly reolink: ReolinkApi,
    private readonly ffmpegPath: string,
    private readonly debug: boolean,
  ) {}

  handleSnapshotRequest(_request: SnapshotRequest, callback: SnapshotRequestCallback): void {
    this.reolink
      .getSnapshot()
      .then((buffer) => callback(undefined, buffer))
      .catch((error: Error) => {
        this.log.error(`[${this.cameraConfig.name}] Snapshot request failed: ${error.message}`);
        callback(error);
      });
  }

  async prepareStream(request: PrepareStreamRequest, callback: PrepareStreamCallback): Promise<void> {
    try {
      const [localVideoPort, localAudioPort] = await reservePorts(2);

      // Ports are stashed under the session so `handleStreamRequest` can bind ffmpeg's
      // RTCP sockets to the exact ports advertised here.
      this.pendingSessions.set(request.sessionID, { request, localVideoPort, localAudioPort });

      const response: PrepareStreamResponse = {
        video: {
          port: localVideoPort,
          ssrc: this.hap.CameraController.generateSynchronisationSource(),
          srtp_key: request.video.srtp_key,
          srtp_salt: request.video.srtp_salt,
        },
        audio: {
          port: localAudioPort,
          ssrc: this.hap.CameraController.generateSynchronisationSource(),
          srtp_key: request.audio.srtp_key,
          srtp_salt: request.audio.srtp_salt,
        },
      };

      callback(undefined, response);
    } catch (error) {
      this.log.error(`[${this.cameraConfig.name}] Failed to prepare stream: ${(error as Error).message}`);
      callback(error as Error);
    }
  }

  handleStreamRequest(request: StreamingRequest, callback: StreamRequestCallback): void {
    switch (request.type) {
      case this.hap.StreamRequestTypes.START:
        this.startStream(request, callback);
        break;
      case this.hap.StreamRequestTypes.RECONFIGURE:
        // Bitrate/resolution changes mid-stream are not applied; acknowledge to keep HomeKit happy.
        callback();
        break;
      case this.hap.StreamRequestTypes.STOP:
        this.stopStream(request.sessionID);
        callback();
        break;
    }
  }

  private startStream(request: StartStreamRequest, callback: StreamRequestCallback): void {
    const pending = this.pendingSessions.get(request.sessionID);
    this.pendingSessions.delete(request.sessionID);

    if (!pending) {
      callback(new Error('No pending session found for sessionID'));
      return;
    }

    const { request: prepareRequest, localVideoPort, localAudioPort } = pending;
    const rtspUrl = this.reolink.getRtspUrl(this.cameraConfig.liveStream ?? 'main');

    const videoBitrate = this.cameraConfig.maxBitrate ?? Math.min(request.video.max_bit_rate, 2000);
    const videoSrtpSuite = srtpSuiteToFfmpeg(this.hap, prepareRequest.video.srtpCryptoSuite);
    const videoSrtpParams = Buffer.concat([prepareRequest.video.srtp_key, prepareRequest.video.srtp_salt]).toString('base64');

    // Video and audio are transcoded by two independent ffmpeg processes (each with its own
    // RTSP connection to the camera) so that an audio encoder failure can never take the live
    // view's video down with it, and vice versa.
    const videoArgs: string[] = ['-hide_banner', '-loglevel', this.debug ? 'verbose' : 'error'];
    videoArgs.push('-rtsp_transport', 'tcp', '-i', rtspUrl);
    videoArgs.push(
      '-map', '0:v:0',
      '-an', '-sn', '-dn',
      '-codec:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-profile:v', h264ProfileToFfmpeg(this.hap, request.video.profile),
      '-level:v', h264LevelToFfmpeg(this.hap, request.video.level),
      '-preset', 'ultrafast',
      '-tune', 'zerolatency',
      '-r', String(request.video.fps),
      '-b:v', `${videoBitrate}k`,
      '-bufsize', `${videoBitrate * 2}k`,
      '-maxrate', `${videoBitrate}k`,
      '-payload_type', String(request.video.pt),
      '-ssrc', String(toFfmpegSsrc(request.video.ssrc)),
      '-f', 'rtp',
      '-srtp_out_suite', videoSrtpSuite,
      '-srtp_out_params', videoSrtpParams,
      `srtp://${prepareRequest.targetAddress}:${prepareRequest.video.port}` +
        `?rtcpport=${localVideoPort}&localrtcpport=${localVideoPort}&pkt_size=${Math.min(request.video.mtu, 1378)}`,
    );

    const videoFfmpeg = new FfmpegProcess(this.ffmpegPath, videoArgs, this.log, `${this.cameraConfig.name} live video`, this.debug);
    videoFfmpeg.exited.catch((error: Error) => {
      this.log.error(`[${this.cameraConfig.name}] Live video ffmpeg process ended unexpectedly: ${error.message}`);
    });

    let audioFfmpeg: FfmpegProcess | undefined;
    if (this.cameraConfig.enableAudio !== false) {
      const audioSrtpSuite = srtpSuiteToFfmpeg(this.hap, prepareRequest.audio.srtpCryptoSuite);
      const audioSrtpParams = Buffer.concat([prepareRequest.audio.srtp_key, prepareRequest.audio.srtp_salt]).toString('base64');

      const audioArgs: string[] = ['-hide_banner', '-loglevel', this.debug ? 'verbose' : 'error'];
      audioArgs.push('-rtsp_transport', 'tcp', '-i', rtspUrl);
      audioArgs.push(
        '-map', '0:a:0?',
        '-vn', '-sn', '-dn',
        '-codec:a', 'libfdk_aac',
        '-profile:a', 'aac_eld',
        '-ar', String(request.audio.sample_rate * 1000),
        '-b:a', `${request.audio.max_bit_rate}k`,
        '-ac', '1',
        '-flags', '+global_header',
        '-payload_type', String(request.audio.pt),
        '-ssrc', String(toFfmpegSsrc(request.audio.ssrc)),
        '-f', 'rtp',
        '-srtp_out_suite', audioSrtpSuite,
        '-srtp_out_params', audioSrtpParams,
        `srtp://${prepareRequest.targetAddress}:${prepareRequest.audio.port}` +
          `?rtcpport=${localAudioPort}&localrtcpport=${localAudioPort}&pkt_size=188`,
      );

      audioFfmpeg = new FfmpegProcess(this.ffmpegPath, audioArgs, this.log, `${this.cameraConfig.name} live audio`, this.debug);
      audioFfmpeg.exited.catch((error: Error) => {
        this.log.error(
          `[${this.cameraConfig.name}] Live audio ffmpeg process ended unexpectedly (video is unaffected): ${error.message}`,
        );
      });
    }

    this.ongoingSessions.set(request.sessionID, { videoFfmpeg, audioFfmpeg, localVideoPort, localAudioPort });
    callback();
  }

  private stopStream(sessionID: string): void {
    const session = this.ongoingSessions.get(sessionID);
    if (session) {
      session.videoFfmpeg.stop();
      session.audioFfmpeg?.stop();
      this.ongoingSessions.delete(sessionID);
    }
    this.pendingSessions.delete(sessionID);
  }
}
