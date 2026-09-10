import { createSocket } from 'node:dgram';
import type { Writable } from 'node:stream';
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
import { LivePrebuffer } from './livePrebuffer';
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

const VIDEO_RTCP_WAIT_TIMEOUT_MS = 1500;

/**
 * Waits briefly for the first inbound packet on the local video RTCP port before any video is
 * sent - a documented HomeKit compatibility workaround (used by e.g. Scrypted's HomeKit plugin,
 * particularly for clients without a Home Hub): starting to send video before the client's own
 * RTP/SRTP receiver has finished setting up can leave some HomeKit clients showing no image at
 * all, even though the video is being sent and received without any transport-level error.
 *
 * This briefly binds its own probe socket to the port ffmpeg will use for `-localrtcpport`, since
 * that's the only way to observe traffic on it before ffmpeg itself binds the same port. Best
 * effort only: if nothing arrives before the timeout, streaming proceeds anyway rather than
 * risking a client that never sends RTCP at all (e.g. one that only does so after receiving the
 * first video packet).
 */
function waitForFirstRtcp(port: number, log: Logger, label: string): Promise<void> {
  return new Promise((resolve) => {
    const socket = createSocket('udp4');
    let settled = false;

    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.close(() => resolve());
    };

    const timer = setTimeout(finish, VIDEO_RTCP_WAIT_TIMEOUT_MS);
    // unref() so this timer alone can't keep the process/tests alive if something else
    // (e.g. the port being unavailable) short-circuits the flow before it fires.
    timer.unref?.();

    socket.once('error', (error) => {
      log.warn(`[${label}] Video RTCP readiness probe failed, proceeding without it: ${error.message}`);
      finish();
    });
    socket.once('message', finish);
    socket.bind(port);
  });
}

interface OngoingSession {
  ffmpeg: FfmpegProcess;
  localVideoPort: number;
  localAudioPort: number;
  prebufferSink: Writable;
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
  private readonly cancelledSessions = new Set<string>();
  private prebuffer: LivePrebuffer | undefined;

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

    // Acknowledge the start request immediately - HomeKit expects a prompt response here, and the
    // rest of streaming setup (including the RTCP readiness wait below) happens asynchronously
    // afterwards, matching how other mature HomeKit integrations (e.g. Scrypted) structure this.
    callback();
    this.startStreamAsync(request, pending).catch((error: Error) => {
      this.log.error(`[${this.cameraConfig.name}] Failed to start live stream: ${error.message}`);
    });
  }

  private async startStreamAsync(request: StartStreamRequest, pending: PendingSession): Promise<void> {
    const { request: prepareRequest, localVideoPort, localAudioPort } = pending;
    // In copy mode we send whatever resolution the selected stream actually is, regardless of
    // what HomeKit negotiated - the main stream is commonly well above the highest resolution we
    // advertise (e.g. 2048x1536 vs. our advertised max of 1920x1080), a mismatch that can leave
    // HomeKit unable to decode a single frame. The substream is low enough resolution to reliably
    // fall within what we advertise either way.
    const quality = this.cameraConfig.liveStream ?? 'sub';

    // A background connection to the camera is kept warm by a single shared prebuffer instead of
    // each session opening (and fully re-analyzing) its own fresh RTSP/RTMP connection - that
    // full renegotiation was observed taking several real seconds even with tuned analyzeduration
    // settings, plausibly outlasting HomeKit's own patience for the stream to start. A session
    // connecting mid-stream to the prebuffer's already-flowing, already-analyzed MPEG-TS output
    // picks up almost immediately instead.
    if (!this.prebuffer) {
      const sourceUrl = this.cameraConfig.liveViewRtmp ? this.reolink.getRtmpUrl(quality) : this.reolink.getRtspUrl(quality);
      this.prebuffer = new LivePrebuffer(
        this.ffmpegPath,
        sourceUrl,
        this.cameraConfig.liveViewRtmp === true,
        this.log,
        `${this.cameraConfig.name} live`,
        this.debug,
      );
    }

    const videoSrtpSuite = srtpSuiteToFfmpeg(this.hap, prepareRequest.video.srtpCryptoSuite);
    const videoSrtpParams = Buffer.concat([prepareRequest.video.srtp_key, prepareRequest.video.srtp_salt]).toString('base64');

    const args: string[] = ['-hide_banner', '-loglevel', this.debug ? 'verbose' : 'error'];
    args.push('-analyzeduration', '2000000', '-probesize', '1000000');
    args.push('-i', 'pipe:0');

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
        // `fastdecode` (not `zerolatency`) deliberately: this trades a bit of encode latency for
        // a simpler bitstream (e.g. disables in-loop deblocking) that's easier for the receiving
        // decoder to handle - a documented (if imperfect) community workaround for Reolink
        // cameras specifically getting stuck showing a loading spinner in HomeKit indefinitely,
        // matching this camera's symptom exactly.
        '-tune', 'fastdecode',
        '-r', String(request.video.fps),
        '-b:v', `${videoBitrate}k`,
        '-bufsize', `${videoBitrate * 2}k`,
        '-maxrate', `${videoBitrate}k`,
      );
    } else {
      // Default: the camera already sends H.264, which HomeKit accepts directly, so the
      // stream is passed through untouched instead of being decoded and re-encoded. Relies on
      // the RTCP port fix above (not a resolution/profile mismatch) for reliable playback. SPS/PPS
      // re-insertion before every keyframe is already handled once, upstream, by the prebuffer.
      args.push('-codec:v', 'copy');
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
      //
      // The packet size is capped to 1200 rather than trusting HomeKit's own negotiated MTU
      // (commonly ~1378): that value is documented as unreliable in practice (Scrypted's HomeKit
      // plugin applies the same 1200-byte cap for the same reason) - a payload that's actually too
      // large for the real network path gets silently dropped rather than fragmented, which looks
      // identical from ffmpeg's side (packets successfully muxed and sent) to a client that never
      // renders any image.
      `srtp://${prepareRequest.targetAddress}:${prepareRequest.video.port}` +
        `?rtcpport=${prepareRequest.video.port}&localrtcpport=${localVideoPort}&pkt_size=${Math.min(request.video.mtu, 1200)}`,
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

    // Best-effort wait for the client's own RTP/RTCP receiver to signal readiness before any video
    // is actually sent - see waitForFirstRtcp() for why. HomeKit was already acknowledged above, so
    // this delay is invisible to the START request itself.
    await waitForFirstRtcp(localVideoPort, this.log, this.cameraConfig.name);

    if (this.cancelledSessions.delete(request.sessionID)) {
      // The client already stopped this stream (e.g. closed the Home app) while we were still
      // waiting on RTCP - stopStream() found nothing to tear down at the time since this session
      // hadn't been added to ongoingSessions yet, so it's on us to not spawn ffmpeg at all now.
      return;
    }

    const ffmpeg = new FfmpegProcess(this.ffmpegPath, args, this.log, `${this.cameraConfig.name} live`, this.debug);
    ffmpeg.exited.catch((error: Error) => {
      this.log.error(`[${this.cameraConfig.name}] Live stream ffmpeg process ended unexpectedly: ${error.message}`);
    });

    const prebufferSink = ffmpeg.process.stdin;
    this.prebuffer.acquire(prebufferSink);

    this.ongoingSessions.set(request.sessionID, { ffmpeg, localVideoPort, localAudioPort, prebufferSink });
  }

  private stopStream(sessionID: string): void {
    const session = this.ongoingSessions.get(sessionID);
    if (session) {
      this.prebuffer?.release(session.prebufferSink);
      session.ffmpeg.stop();
      this.ongoingSessions.delete(sessionID);
    } else {
      // The session may still be mid-startup (e.g. inside the RTCP readiness wait in
      // startStreamAsync(), which hasn't populated ongoingSessions yet) - flag it as cancelled so
      // that code notices and skips spawning ffmpeg instead of leaking a process for a stream
      // nobody's watching anymore.
      this.cancelledSessions.add(sessionID);
    }
    this.pendingSessions.delete(sessionID);
  }
}
