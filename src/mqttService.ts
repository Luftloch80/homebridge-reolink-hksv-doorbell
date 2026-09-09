import mqtt, { type MqttClient } from 'mqtt';
import type { Logger } from 'homebridge';
import type { MqttBrokerConfig } from './configTypes';

export type MqttMessageHandler = (payload: Buffer, retained: boolean) => void;

/**
 * A single shared connection to an MQTT broker, used to trigger the doorbell ring for cameras
 * configured with `ringTrigger: "mqtt"` (e.g. a dummy switch in Home Assistant/Scrypted
 * publishing to a topic when pressed, for cameras with no physical doorbell button of their own).
 */
export class MqttService {
  private readonly client: MqttClient;
  private readonly subscribers = new Map<string, Set<MqttMessageHandler>>();

  constructor(config: MqttBrokerConfig, private readonly log: Logger) {
    const protocol = config.useTls ? 'mqtts' : 'mqtt';
    const url = `${protocol}://${config.host}:${config.port ?? 1883}`;

    this.client = mqtt.connect(url, {
      username: config.username || undefined,
      password: config.password || undefined,
      reconnectPeriod: 5000,
      clientId: `homebridge-reolink-hksv-doorbell-${Math.random().toString(16).slice(2)}`,
    });

    this.client.on('connect', () => this.log.info(`MQTT: connected to ${url}`));
    this.client.on('reconnect', () => this.log.debug('MQTT: reconnecting...'));
    this.client.on('close', () => this.log.debug('MQTT: connection closed'));
    this.client.on('error', (error: Error) => this.log.error(`MQTT: connection error: ${error.message}`));

    this.client.on('message', (topic, payload, packet) => {
      const handlers = this.subscribers.get(topic);
      if (!handlers) {
        return;
      }
      for (const handler of handlers) {
        handler(payload, Boolean(packet.retain));
      }
    });
  }

  subscribe(topic: string, handler: MqttMessageHandler): void {
    let handlers = this.subscribers.get(topic);
    if (!handlers) {
      handlers = new Set();
      this.subscribers.set(topic, handlers);
      this.client.subscribe(topic, { qos: 0 }, (error) => {
        if (error) {
          this.log.error(`MQTT: failed to subscribe to "${topic}": ${error.message}`);
        } else {
          this.log.debug(`MQTT: subscribed to "${topic}"`);
        }
      });
    }
    handlers.add(handler);
  }

  unsubscribe(topic: string, handler: MqttMessageHandler): void {
    const handlers = this.subscribers.get(topic);
    if (!handlers) {
      return;
    }
    handlers.delete(handler);
    if (handlers.size === 0) {
      this.subscribers.delete(topic);
      this.client.unsubscribe(topic);
    }
  }

  destroy(): void {
    this.client.end(true);
  }
}
