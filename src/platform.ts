import type { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig } from 'homebridge';
import type { CameraConfig, ReolinkPlatformConfig } from './configTypes';
import { DoorbellAccessory } from './doorbellAccessory';
import { splitHostPort } from './hostPort';
import { MqttService } from './mqttService';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings';

export class ReolinkHksvDoorbellPlatform implements DynamicPlatformPlugin {
  public readonly accessories: PlatformAccessory[] = [];
  private readonly activeAccessories = new Map<string, DoorbellAccessory>();
  private mqttService: MqttService | undefined;

  constructor(
    private readonly log: Logger,
    private readonly config: PlatformConfig,
    private readonly api: API,
  ) {
    this.api.on('didFinishLaunching', () => {
      this.discoverDevices();
    });

    this.api.on('shutdown', () => {
      for (const instance of this.activeAccessories.values()) {
        instance.destroy();
      }
      this.mqttService?.destroy();
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.log.info(`Loading accessory from cache: ${accessory.displayName}`);
    this.accessories.push(accessory);
  }

  private discoverDevices(): void {
    const platformConfig = this.config as ReolinkPlatformConfig;
    const cameras = platformConfig.cameras ?? [];

    if (cameras.length === 0) {
      this.log.warn('No cameras configured. Add at least one camera in the Homebridge UI plugin settings.');
    }

    // The UI offers a single "address" field for both the camera and the MQTT broker
    // (optionally "host:port"); split that into host/port here before anything else uses it.
    for (const cameraConfig of cameras) {
      if (cameraConfig.host && cameraConfig.port === undefined) {
        const { host, port } = splitHostPort(cameraConfig.host);
        cameraConfig.host = host;
        cameraConfig.port = port;
      }
    }
    if (platformConfig.mqtt?.host && platformConfig.mqtt.port === undefined) {
      const { host, port } = splitHostPort(platformConfig.mqtt.host);
      platformConfig.mqtt.host = host;
      platformConfig.mqtt.port = port;
    }

    const needsMqtt = cameras.some((camera) => camera.ringTrigger === 'mqtt');
    if (needsMqtt && platformConfig.mqtt?.enabled !== false && platformConfig.mqtt?.host && !this.mqttService) {
      this.mqttService = new MqttService(platformConfig.mqtt, this.log);
    } else if (needsMqtt && !platformConfig.mqtt?.host) {
      this.log.error(
        'At least one camera uses ringTrigger "mqtt", but no MQTT broker is configured in the platform settings.',
      );
    }

    const configuredUuids = new Set<string>();

    for (const cameraConfig of cameras) {
      if (!this.validateCameraConfig(cameraConfig)) {
        continue;
      }

      const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}-${cameraConfig.host}-${cameraConfig.channel ?? 0}`);
      configuredUuids.add(uuid);

      const existingAccessory = this.accessories.find((accessory) => accessory.UUID === uuid);

      let accessory: PlatformAccessory;
      if (existingAccessory) {
        this.log.info(`Restoring accessory from cache: ${cameraConfig.name}`);
        existingAccessory.displayName = cameraConfig.name;
        existingAccessory.context.cameraConfig = cameraConfig;
        accessory = existingAccessory;
      } else {
        this.log.info(`Adding new accessory: ${cameraConfig.name}`);
        accessory = new this.api.platformAccessory(cameraConfig.name, uuid);
        accessory.context.cameraConfig = cameraConfig;
        const category = cameraConfig.isDoorbell !== false ? this.api.hap.Categories.VIDEO_DOORBELL : this.api.hap.Categories.CAMERA;
        accessory.category = category;
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.push(accessory);
      }

      this.activeAccessories.get(uuid)?.destroy();
      const instance = new DoorbellAccessory(
        this.api,
        this.log,
        accessory,
        cameraConfig,
        platformConfig.ffmpegPath,
        platformConfig.debug === true,
        this.mqttService,
      );
      this.activeAccessories.set(uuid, instance);
    }

    const staleAccessories = this.accessories.filter((accessory) => !configuredUuids.has(accessory.UUID));
    if (staleAccessories.length > 0) {
      for (const accessory of staleAccessories) {
        this.log.info(`Removing stale accessory: ${accessory.displayName}`);
        this.activeAccessories.get(accessory.UUID)?.destroy();
        this.activeAccessories.delete(accessory.UUID);
      }
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, staleAccessories);
      for (const accessory of staleAccessories) {
        const index = this.accessories.indexOf(accessory);
        if (index >= 0) {
          this.accessories.splice(index, 1);
        }
      }
    }
  }

  private validateCameraConfig(cameraConfig: CameraConfig): boolean {
    if (!cameraConfig.name || !cameraConfig.host || !cameraConfig.username || !cameraConfig.password) {
      this.log.error(
        `Skipping camera with incomplete configuration (name/host/username/password required): ${JSON.stringify({
          name: cameraConfig.name,
          host: cameraConfig.host,
        })}`,
      );
      return false;
    }

    if (cameraConfig.ringTrigger === 'mqtt') {
      if (!cameraConfig.mqttRingTopic) {
        this.log.error(`[${cameraConfig.name}] ringTrigger is "mqtt" but no mqttRingTopic is configured.`);
        return false;
      }
      if (cameraConfig.isDoorbell === false) {
        this.log.warn(
          `[${cameraConfig.name}] ringTrigger is "mqtt" but "Als Türklingel anzeigen" is disabled, so ring events have no Doorbell service to trigger.`,
        );
      }
    }

    return true;
  }
}
