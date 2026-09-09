import type { API, CameraController, CameraControllerOptions, DoorbellController, HAP, Logger, PlatformAccessory } from 'homebridge';
import type { CameraConfig } from './configTypes';
import { resolveFfmpegPath } from './ffmpeg';
import type { MqttMessageHandler, MqttService } from './mqttService';
import { RecordingDelegate } from './recordingDelegate';
import { ReolinkApi } from './reolink/reolinkApi';
import { StreamingDelegate } from './streamingDelegate';

const DEFAULT_POLL_INTERVAL_MS = 2000;

export class DoorbellAccessory {
  private readonly hap: HAP;
  private readonly reolink: ReolinkApi;
  private readonly streamingDelegate: StreamingDelegate;
  private readonly recordingDelegate: RecordingDelegate | undefined;
  private readonly controller: CameraController;
  private readonly doorbellController: DoorbellController | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private lastRingState = false;
  private polling = false;
  private mqttSubscription: { topic: string; handler: MqttMessageHandler } | undefined;

  constructor(
    api: API,
    private readonly log: Logger,
    private readonly accessory: PlatformAccessory,
    private readonly cameraConfig: CameraConfig,
    ffmpegPathOverride: string | undefined,
    debug: boolean,
    private readonly mqttService: MqttService | undefined,
  ) {
    this.hap = api.hap;
    this.reolink = new ReolinkApi(cameraConfig, log);
    const ffmpegPath = resolveFfmpegPath(ffmpegPathOverride);

    this.setupAccessoryInformation();

    this.streamingDelegate = new StreamingDelegate(this.hap, log, cameraConfig, this.reolink, ffmpegPath, debug);

    let controllerOptions: CameraControllerOptions = {
      cameraStreamCount: 2,
      delegate: this.streamingDelegate,
      streamingOptions: {
        supportedCryptoSuites: [this.hap.SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80],
        video: {
          codec: {
            profiles: [this.hap.H264Profile.BASELINE, this.hap.H264Profile.MAIN, this.hap.H264Profile.HIGH],
            levels: [this.hap.H264Level.LEVEL3_1, this.hap.H264Level.LEVEL3_2, this.hap.H264Level.LEVEL4_0],
          },
          resolutions: [
            [1920, 1080, 30],
            [1280, 720, 30],
            [1024, 768, 30],
            [640, 480, 30],
            [640, 360, 30],
            [480, 270, 30],
            [320, 240, 15],
          ],
        },
        audio:
          cameraConfig.enableAudio !== false
            ? {
              twoWayAudio: false,
              codecs: [
                {
                  type: this.hap.AudioStreamingCodecType.AAC_ELD,
                  samplerate: [this.hap.AudioStreamingSamplerate.KHZ_16, this.hap.AudioStreamingSamplerate.KHZ_24],
                },
              ],
            }
            : undefined,
      },
      sensors: {
        motion: cameraConfig.enableMotion !== false,
      },
    };

    if (cameraConfig.enableHksv !== false) {
      this.recordingDelegate = new RecordingDelegate(this.hap, log, cameraConfig, this.reolink, ffmpegPath, debug);
      controllerOptions = {
        ...controllerOptions,
        recording: {
          options: {
            prebufferLength: cameraConfig.prebufferLength ?? 4000,
            mediaContainerConfiguration: {
              type: this.hap.MediaContainerType.FRAGMENTED_MP4,
              fragmentLength: cameraConfig.fragmentLength ?? 4000,
            },
            video: {
              type: this.hap.VideoCodecType.H264,
              parameters: {
                levels: [this.hap.H264Level.LEVEL3_1, this.hap.H264Level.LEVEL3_2, this.hap.H264Level.LEVEL4_0],
                profiles: [this.hap.H264Profile.MAIN, this.hap.H264Profile.HIGH],
              },
              resolutions: [
                [1920, 1080, 30],
                [1280, 720, 30],
                [640, 360, 30],
              ],
            },
            audio: {
              codecs: [
                {
                  type: this.hap.AudioRecordingCodecType.AAC_LC,
                  audioChannels: 1,
                  samplerate:
                    cameraConfig.enableAudio !== false
                      ? [
                        this.hap.AudioRecordingSamplerate.KHZ_24,
                        this.hap.AudioRecordingSamplerate.KHZ_32,
                        this.hap.AudioRecordingSamplerate.KHZ_48,
                      ]
                      : this.hap.AudioRecordingSamplerate.KHZ_24,
                },
              ],
            },
          },
          delegate: this.recordingDelegate,
        },
      };
    }

    if (cameraConfig.isDoorbell !== false) {
      this.doorbellController = new this.hap.DoorbellController({ ...controllerOptions, name: cameraConfig.name });
      this.controller = this.doorbellController;
    } else {
      this.controller = new this.hap.CameraController(controllerOptions);
    }

    accessory.configureController(this.controller);

    if (this.recordingDelegate && this.controller.recordingManagement) {
      const operatingModeService = this.controller.recordingManagement.operatingModeService;
      const audioActiveCharacteristic = operatingModeService.getCharacteristic(this.hap.Characteristic.RecordingAudioActive);
      this.recordingDelegate.setAudioActiveGetter(() => Boolean(audioActiveCharacteristic.value));
      audioActiveCharacteristic.on('change', () => this.recordingDelegate?.refreshAudioActive());
    }

    const needsReolinkRingPolling = this.doorbellController && cameraConfig.ringTrigger !== 'mqtt';
    if (needsReolinkRingPolling || cameraConfig.enableMotion !== false) {
      this.startPolling();
    }

    if (cameraConfig.ringTrigger === 'mqtt' && cameraConfig.mqttRingTopic && mqttService) {
      this.setupMqttRing(mqttService, cameraConfig.mqttRingTopic);
    }
  }

  private setupMqttRing(mqttService: MqttService, topic: string): void {
    const expectedPayload = this.cameraConfig.mqttRingPayload;

    const handler: MqttMessageHandler = (payload, retained) => {
      // Ignore retained messages: they replay the topic's last-known value on every
      // (re)subscribe/reconnect and would otherwise trigger a phantom ring on startup.
      if (retained) {
        return;
      }
      if (expectedPayload && payload.toString('utf8').trim() !== expectedPayload) {
        return;
      }
      this.log.info(`[${this.cameraConfig.name}] Doorbell ring via MQTT (topic "${topic}")`);
      this.doorbellController?.ringDoorbell();
    };

    mqttService.subscribe(topic, handler);
    this.mqttSubscription = { topic, handler };
  }

  private setupAccessoryInformation(): void {
    const info = this.accessory.getService(this.hap.Service.AccessoryInformation);
    if (!info) {
      return;
    }
    info
      .setCharacteristic(this.hap.Characteristic.Manufacturer, 'Reolink')
      .setCharacteristic(this.hap.Characteristic.Model, 'Reolink Camera')
      .setCharacteristic(this.hap.Characteristic.SerialNumber, `${this.cameraConfig.host}:${this.cameraConfig.channel ?? 0}`)
      .setCharacteristic(this.hap.Characteristic.FirmwareRevision, '1.0.0');

    this.reolink
      .getDeviceInfo()
      .then((deviceInfo) => {
        info
          .setCharacteristic(this.hap.Characteristic.Model, deviceInfo.model || 'Reolink Camera')
          .setCharacteristic(this.hap.Characteristic.FirmwareRevision, deviceInfo.firmVer || '1.0.0');
      })
      .catch((error: Error) => {
        this.log.warn(`[${this.cameraConfig.name}] Could not read device info: ${error.message}`);
      });
  }

  private startPolling(): void {
    const interval = this.cameraConfig.pollInterval ?? DEFAULT_POLL_INTERVAL_MS;
    const ringTrigger = this.cameraConfig.ringTrigger ?? 'visitor';

    this.pollTimer = setInterval(() => {
      void this.pollOnce(ringTrigger);
    }, interval);
  }

  private async pollOnce(ringTrigger: NonNullable<CameraConfig['ringTrigger']>): Promise<void> {
    if (this.polling) {
      return;
    }
    this.polling = true;
    try {
      const state = await this.reolink.getEventState(ringTrigger);

      if (this.cameraConfig.enableMotion !== false && this.controller.motionService) {
        this.controller.motionService.updateCharacteristic(this.hap.Characteristic.MotionDetected, state.motion);
      }

      if (this.doorbellController && state.ring && !this.lastRingState) {
        this.log.info(`[${this.cameraConfig.name}] Doorbell ring detected`);
        this.doorbellController.ringDoorbell();
      }
      this.lastRingState = state.ring;
    } catch (error) {
      this.log.debug(`[${this.cameraConfig.name}] Event polling failed: ${(error as Error).message}`);
    } finally {
      this.polling = false;
    }
  }

  destroy(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    if (this.mqttSubscription && this.mqttService) {
      this.mqttService.unsubscribe(this.mqttSubscription.topic, this.mqttSubscription.handler);
      this.mqttSubscription = undefined;
    }
    void this.reolink.logout();
  }
}
