import type { PlatformConfig } from 'homebridge';

/**
 * Which Reolink AI/alarm field is interpreted as the doorbell button press.
 * Reolink video doorbells report the button press as a "visitor" entry in the
 * GetAiState response. Older firmware / non-doorbell chimes may not expose it,
 * in which case falling back to the "people" AI detector is the closest match.
 */
export type RingTrigger = 'visitor' | 'people' | 'md';

export type StreamQuality = 'main' | 'sub' | 'ext';

export interface CameraConfig {
  /** Friendly name shown in HomeKit. */
  name: string;
  /** Hostname or IP address of the camera or the NVR the camera is connected to. */
  host: string;
  /** HTTP(S) API port. Defaults to 443 when useHttps is true, otherwise 80. */
  port?: number;
  username: string;
  password: string;
  /** Use HTTPS for the Reolink HTTP API. Defaults to true. */
  useHttps?: boolean;
  /** Disable TLS certificate validation (Reolink devices commonly use self-signed certificates). */
  allowInsecureHttps?: boolean;
  /** Channel index on the device/NVR. 0 for standalone cameras and doorbells. */
  channel?: number;
  /** RTSP port, defaults to 554. */
  rtspPort?: number;
  /** Expose the accessory as a HomeKit doorbell with a ring button. */
  isDoorbell?: boolean;
  /** Which Reolink event is treated as the doorbell button press. */
  ringTrigger?: RingTrigger;
  /** Expose a separate HomeKit motion sensor. */
  enableMotion?: boolean;
  /** Enable HomeKit Secure Video recording support for this camera. */
  enableHksv?: boolean;
  /** Stream substream used for the recording pipeline (should be low bandwidth enough to sustain continuous prebuffering). */
  recordingStream?: StreamQuality;
  /** Stream used for interactive live view. */
  liveStream?: StreamQuality;
  /** Length of the HKSV prebuffer in milliseconds. */
  prebufferLength?: number;
  /** Length of each HKSV recording fragment in milliseconds. */
  fragmentLength?: number;
  /** Include audio in HKSV recordings and live view. */
  enableAudio?: boolean;
  /** Interval in milliseconds used to poll the camera for motion/doorbell events. */
  pollInterval?: number;
  /** Maximum bitrate (kbps) requested from ffmpeg for the live view stream. */
  maxBitrate?: number;
  /** Extra ffmpeg output arguments appended to the live view command, e.g. for hardware acceleration. */
  videoFilter?: string;
}

export interface ReolinkPlatformConfig extends PlatformConfig {
  cameras?: CameraConfig[];
  /** Path to a custom ffmpeg binary. Defaults to the bundled ffmpeg-for-homebridge binary or "ffmpeg" from PATH. */
  ffmpegPath?: string;
  /** Enable verbose ffmpeg/debug logging. */
  debug?: boolean;
}
