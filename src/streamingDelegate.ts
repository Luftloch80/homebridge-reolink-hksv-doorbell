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
  ffmpeg: FfmpegProcess;
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
      };

      // `audio` is optional on the response - HomeKit always sends audio SRTP parameters in the
      // request regardless of what the accessory declared, but answering with a negotiated audio
      // channel here promises HomeKit that packets will actually arrive on it. When audio is
      // disabled, startStream() never sends any, so including this anyway left HomeKit waiting on
      // an audio stream that would never start, observed as live view showing one video frame and
      // then buffering indefinitely.
      if (this.cameraConfig.enableAudio !== false) {
        response.audio = {
          port: localAudioPort,
          ssrc: this.hap.CameraController.generateSynchronisationSource(),
          srtp_key: request.audio.srtp_key,
          srtp_salt: request.audio.srtp_salt,
        };
      }

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
    // In copy mode we send whatever resolution the selected stream actually is, regardless of
    // what HomeKit negotiated - the main stream is commonly well above the highest resolution we
    // advertise (e.g. 2048x1536 vs. our advertised max of 1920x1080), a mismatch that can leave
    // HomeKit unable to decode a single frame. The substream is low enough resolution to reliably
    // fall within what we advertise either way.
    const rtspUrl = this.reolink.getRtspUrl(this.cameraConfig.liveStream ?? 'sub');

    const videoSrtpSuite = srtpSuiteToFfmpeg(this.hap, prepareRequest.video.srtpCryptoSuite);
    const videoSrtpParams = Buffer.concat([prepareRequest.video.srtp_key, prepareRequest.video.srtp_salt]).toString('base64');

    // Video and audio share a single ffmpeg process (one RTSP connection to the camera).
    // Reolink cameras commonly cap total concurrent connections (RTSP + HTTP API combined);
    // running two separate RTSP sessions here was observed to destabilize both the video
    // feed and the HTTP API login on such cameras, so a single connection is used instead.
    const args: string[] = ['-hide_banner', '-loglevel', this.debug ? 'verbose' : 'error'];
    // ffmpeg's RTSP demuxer defaults to just 1s of stream analysis (vs. 5s generally), which can
    // end before the first SPS/keyframe arrives. That's harmless when re-encoding (the decoder
    // parses the SPS itself as it decodes), but with `-codec:v copy` the output muxer relies
    // entirely on dimensions already probed from the input, so without enough time here it can
    // fail with "dimensions not set" / "Could not write header" as soon as the stream is opened.
    // 10s (tried previously) is overkill - the SDP already carries the SPS/PPS via
    // sprop-parameter-sets, so ffmpeg has what it needs almost immediately - and actually made
    // things worse, observed adding ~8s of pure startup latency before any output was produced,
    // plausibly long enough for HomeKit's own patience for the stream to start to run out first.
    args.push('-analyzeduration', '2000000', '-probesize', '1000000');
    args.push('-rtsp_transport', 'tcp', '-i', rtspUrl);

    args.push('-map', '0:v:0', '-an', '-sn', '-dn');

    if (this.cameraConfig.liveViewTranscode) {
      // Re-encoding gives exact control over the negotiated profile/level/resolution/bitrate,
      // at the cost of real-time software decode+encode CPU load - noticeably heavy on boards
      // like a Raspberry Pi for higher camera resolutions.
      const videoBitrate = this.cameraConfig.maxBitrate ?? Math.min(request.video.max_bit_rate, 2000);
      args.push(
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
      );
    } else {
      // Default: the camera already sends H.264, which HomeKit accepts directly, so the
      // stream is passed through untouched instead of being decoded and re-encoded. Relies on
      // the RTCP port fix above (not a resolution/profile mismatch) for reliable playback.
      // `dump_extra` re-inserts the stream's SPS/PPS before every keyframe rather than only
      // once at the very start of the RTSP session - HomeKit has no SDP exchange to fall back
      // on to learn these parameters, so if it doesn't catch that first, one-time copy it can
      // never decode a single frame, which looks exactly like indefinite buffering.
      args.push('-codec:v', 'copy', '-bsf:v', 'dump_extra=freq=keyframe');
    }

    args.push(
      '-payload_type', String(request.video.pt),
      '-ssrc', String(toFfmpegSsrc(request.video.ssrc)),
      '-f', 'rtp',
      '-srtp_out_suite', videoSrtpSuite,
      '-srtp_out_params', videoSrtpParams,
      // `rtcpport` is the *remote* RTCP port (HomeKit's own single `port` covers both RTP and
      // RTCP), while `localrtcpport` is where we listen for RTCP locally - previously both were
      // set to our own local port, which sent RTCP reports nowhere HomeKit was listening and left
      // the live view stuck showing one frame and buffering indefinitely.
      `srtp://${prepareRequest.targetAddress}:${prepareRequest.video.port}` +
        `?rtcpport=${prepareRequest.video.port}&localrtcpport=${localVideoPort}&pkt_size=${Math.min(request.video.mtu, 1378)}`,
    );

    if (this.cameraConfig.enableAudio !== false) {
      const audioSrtpSuite = srtpSuiteToFfmpeg(this.hap, prepareRequest.audio.srtpCryptoSuite);
      const audioSrtpParams = Buffer.concat([prepareRequest.audio.srtp_key, prepareRequest.audio.srtp_salt]).toString('base64');

      args.push(
        '-map', '0:a:0?',
        '-vn', '-sn', '-dn',
        '-codec:a', 'libfdk_aac',
        '-profile:a', 'aac_eld',
        '-ar', String(request.audio.sample_rate * 1000),
        '-b:a', `${request.audio.max_bit_rate}k`,
        '-ac', String(request.audio.channel),
        '-flags', '+global_header',
        '-payload_type', String(request.audio.pt),
        '-ssrc', String(toFfmpegSsrc(request.audio.ssrc)),
        '-f', 'rtp',
        '-srtp_out_suite', audioSrtpSuite,
        '-srtp_out_params', audioSrtpParams,
        `srtp://${prepareRequest.targetAddress}:${prepareRequest.audio.port}` +
          `?rtcpport=${prepareRequest.audio.port}&localrtcpport=${localAudioPort}&pkt_size=188`,
      );
    }

    const ffmpeg = new FfmpegProcess(this.ffmpegPath, args, this.log, `${this.cameraConfig.name} live`, this.debug);
    ffmpeg.exited.catch((error: Error) => {
      this.log.error(`[${this.cameraConfig.name}] Live stream ffmpeg process ended unexpectedly: ${error.message}`);
    });

    this.ongoingSessions.set(request.sessionID, { ffmpeg, localVideoPort, localAudioPort });
    callback();
  }

  private stopStream(sessionID: string): void {
    const session = this.ongoingSessions.get(sessionID);
    if (session) {
      session.ffmpeg.stop();
      this.ongoingSessions.delete(sessionID);
    }
    this.pendingSessions.delete(sessionID);
  }
}
