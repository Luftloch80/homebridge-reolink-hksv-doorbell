import type { PlatformConfig } from 'homebridge';

/**
 * Which source is interpreted as the doorbell button press.
 * Reolink video doorbells report the button press as a "visitor" entry in the
 * GetAiState response. Older firmware / non-doorbell chimes may not expose it,
 * in which case falling back to the "people" AI detector is the closest match.
 * "mqtt" is for cameras with no physical doorbell button at all: the ring is
 * triggered externally (e.g. a dummy switch in Home Assistant/Scrypted) by
 * publishing to an MQTT topic instead of being derived from the camera itself.
 */
export type RingTrigger = 'visitor' | 'people' | 'md' | 'mqtt';

export type StreamQuality = 'main' | 'sub' | 'ext';

export interface CameraConfig {
  /** Friendly name shown in HomeKit. */
  name: string;
  /**
   * Hostname or IP address of the camera or the NVR the camera is connected to.
   * May include a trailing ":port" (e.g. "192.168.1.50:8443"); if present it is
   * split into `host`/`port` before this config is used elsewhere.
   */
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
  /** Which event is treated as the doorbell button press. */
  ringTrigger?: RingTrigger;
  /** MQTT topic to subscribe to for the ring event. Required when ringTrigger is "mqtt". */
  mqttRingTopic?: string;
  /**
   * Exact payload (after trimming) that counts as a ring on `mqttRingTopic`.
   * Leave empty to treat every (non-retained) message on the topic as a ring,
   * which fits a momentary "press" style dummy switch/automation.
   */
  mqttRingPayload?: string;
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
  /**
   * Re-encode the live view video with libx264 instead of passing the camera's H.264 stream
   * through unchanged. Off by default: passthrough avoids the real-time software transcode CPU
   * load that can cause decode corruption on constrained hardware (e.g. a Raspberry Pi) with
   * higher-resolution cameras. Enable only if exact control over profile/level/bitrate is needed.
   */
  liveViewTranscode?: boolean;
  /**
   * Publish this camera as its own standalone HomeKit accessory instead of bridging it under the
   * shared Homebridge bridge ("Steuerzentrale"/hub in the Home app). Requires pairing it
   * separately in the Home app (Add Accessory, using the Homebridge PIN) the first time it's
   * enabled; if the camera was previously bridged, its old tile must be removed from the Home
   * app once, since it's a distinct HomeKit identity from this point on.
   */
  standaloneAccessory?: boolean;
  /**
   * Use Reolink's own RTMP-based "BCS" protocol instead of RTSP as the live view source. Off by
   * default (RTSP). Reolink's RTSP server is built on an old LIVE555 fork known for slow/flaky
   * session startup; BCS/RTMP is Reolink's own more modern streaming path, also used internally
   * by their own apps, and has been reported to establish a live session more reliably.
   */
  liveViewRtmp?: boolean;
}

export interface MqttBrokerConfig {
  /** Enable the shared MQTT connection used for `ringTrigger: "mqtt"` cameras. */
  enabled?: boolean;
  /** Broker hostname/IP, optionally with a trailing ":port" (e.g. "192.168.1.20:1883"). */
  host: string;
  /** Defaults to 1883 (or 8883 when `useTls` is set) if not given and not embedded in `host`. */
  port?: number;
  username?: string;
  password?: string;
  /** Connect using MQTTS (TLS) instead of plain MQTT. Defaults to false. */
  useTls?: boolean;
}

export interface ReolinkPlatformConfig extends PlatformConfig {
  cameras?: CameraConfig[];
  /** Path to a custom ffmpeg binary. Defaults to the bundled ffmpeg-for-homebridge binary or "ffmpeg" from PATH. */
  ffmpegPath?: string;
  /** Enable verbose ffmpeg/debug logging. */
  debug?: boolean;
  /** Shared MQTT broker connection used by cameras with `ringTrigger: "mqtt"`. */
  mqtt?: MqttBrokerConfig;
}
