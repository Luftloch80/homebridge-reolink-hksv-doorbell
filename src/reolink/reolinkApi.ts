import https from 'node:https';
import axios, { AxiosInstance } from 'axios';
import type { Logger } from 'homebridge';
import type { CameraConfig, RingTrigger, StreamQuality } from '../configTypes';
import type {
  AiStateValue,
  DevInfoValue,
  LoginResponseValue,
  MdStateValue,
  ReolinkCommandRequest,
  ReolinkCommandResponse,
} from './types';

export interface ReolinkEventState {
  motion: boolean;
  ring: boolean;
}

/**
 * Thin client around the Reolink `api.cgi` HTTP interface.
 *
 * Reolink devices accept batched commands as a JSON array in a single POST request,
 * which keeps event polling (motion + AI state) to one round trip.
 */
export class ReolinkApi {
  private readonly http: AxiosInstance;
  private token: string | undefined;
  private tokenExpiresAt = 0;
  private loginPromise: Promise<void> | undefined;

  constructor(private readonly config: CameraConfig, private readonly log: Logger) {
    const useHttps = config.useHttps !== false;
    const port = config.port ?? (useHttps ? 443 : 80);

    this.http = axios.create({
      baseURL: `${useHttps ? 'https' : 'http'}://${config.host}:${port}`,
      timeout: 10000,
      // Reolink devices almost always use a self-signed certificate, so insecure HTTPS is
      // accepted by default; only an explicit `false` opts back into certificate validation.
      httpsAgent: useHttps ? new https.Agent({ rejectUnauthorized: config.allowInsecureHttps === false }) : undefined,
    });
  }

  private get channel(): number {
    return this.config.channel ?? 0;
  }

  async ensureLoggedIn(): Promise<void> {
    if (this.token && Date.now() < this.tokenExpiresAt) {
      return;
    }
    if (!this.loginPromise) {
      this.loginPromise = this.login().finally(() => {
        this.loginPromise = undefined;
      });
    }
    return this.loginPromise;
  }

  private async login(): Promise<void> {
    const body: ReolinkCommandRequest[] = [
      {
        cmd: 'Login',
        action: 0,
        param: {
          User: {
            Version: '0',
            userName: this.config.username,
            password: this.config.password,
          },
        },
      },
    ];

    // Reolink's firmware expects an explicit "token=null" query param on the Login request
    // itself (matching what every other Reolink client library sends), alongside "cmd=Login".
    const response = await this.http.post<ReolinkCommandResponse<LoginResponseValue>[]>('/api.cgi', body, {
      params: { cmd: 'Login', token: 'null' },
    });
    const result = response.data?.[0];

    if (!result || result.code !== 0 || !result.value) {
      throw new Error(
        `Reolink login failed for ${this.config.host}: ${JSON.stringify(result?.error ?? result ?? 'no response')}`,
      );
    }

    this.token = result.value.Token.name;
    // Renew a bit ahead of the actual lease expiry to avoid racing token expiry mid-request.
    const leaseMs = Math.max(result.value.Token.leaseTime - 30, 30) * 1000;
    this.tokenExpiresAt = Date.now() + leaseMs;
    this.log.debug(`[${this.config.name}] Reolink login successful, token valid for ${result.value.Token.leaseTime}s`);
  }

  async logout(): Promise<void> {
    if (!this.token) {
      return;
    }
    const token = this.token;
    this.token = undefined;
    this.tokenExpiresAt = 0;
    try {
      await this.http.post('/api.cgi', [{ cmd: 'Logout', action: 0, param: {} }], { params: { token } });
    } catch (error) {
      this.log.debug(`[${this.config.name}] Reolink logout failed (ignored): ${(error as Error).message}`);
    }
  }

  private async send<T>(commands: ReolinkCommandRequest[]): Promise<ReolinkCommandResponse<T>[]> {
    await this.ensureLoggedIn();
    const response = await this.http.post<ReolinkCommandResponse<T>[]>('/api.cgi', commands, {
      params: { token: this.token },
    });

    const authError = response.data?.some((entry) => entry.error?.rspCode === -6 || entry.error?.rspCode === -1);
    if (authError) {
      // Token expired or was invalidated server-side; force a fresh login and retry once.
      this.token = undefined;
      this.tokenExpiresAt = 0;
      await this.ensureLoggedIn();
      const retry = await this.http.post<ReolinkCommandResponse<T>[]>('/api.cgi', commands, {
        params: { token: this.token },
      });
      return retry.data;
    }

    return response.data;
  }

  async getDeviceInfo(): Promise<DevInfoValue['DevInfo']> {
    const [result] = await this.send<DevInfoValue>([{ cmd: 'GetDevInfo', action: 0, param: {} }]);
    if (!result || result.code !== 0 || !result.value) {
      throw new Error(`Reolink GetDevInfo failed for ${this.config.host}: ${JSON.stringify(result?.error ?? result)}`);
    }
    return result.value.DevInfo;
  }

  async getEventState(ringTrigger: RingTrigger): Promise<ReolinkEventState> {
    const commands: ReolinkCommandRequest[] = [
      { cmd: 'GetMdState', action: 0, param: { channel: this.channel } },
      { cmd: 'GetAiState', action: 0, param: { channel: this.channel } },
    ];
    const results = await this.send<MdStateValue | AiStateValue>(commands);

    const mdResult = results.find((entry) => entry.cmd === 'GetMdState');
    const aiResult = results.find((entry) => entry.cmd === 'GetAiState');

    const motionFromMd = (mdResult?.value as MdStateValue | undefined)?.state === 1;
    const aiValue = aiResult?.value as AiStateValue | undefined;

    let ring = false;
    if (ringTrigger === 'md') {
      ring = motionFromMd;
    } else if (ringTrigger === 'mqtt') {
      // Ring is driven externally via MQTT in this mode; the Reolink poll never reports it.
      ring = false;
    } else {
      const entry = aiValue?.[ringTrigger];
      ring = entry?.alarm_state === 1;
    }

    // Consider any supported AI class as "motion" so the HomeKit motion sensor
    // reacts to people/vehicle/pet detection in addition to plain PIR motion.
    const motionFromAi = aiValue
      ? Object.values(aiValue).some(
        (entry) => typeof entry === 'object' && entry !== null && 'alarm_state' in entry && entry.alarm_state === 1,
      )
      : false;

    return {
      motion: motionFromMd || motionFromAi,
      ring,
    };
  }

  async getSnapshot(): Promise<Buffer> {
    await this.ensureLoggedIn();
    const response = await this.http.get<ArrayBuffer>('/cgi-bin/api.cgi', {
      params: {
        cmd: 'Snap',
        channel: this.channel,
        rs: Math.random().toString(36).slice(2),
        token: this.token,
      },
      responseType: 'arraybuffer',
      timeout: 10000,
    });
    return Buffer.from(response.data);
  }

  /** Builds the RTSP source URL for the requested stream quality. Credentials are embedded and must be kept out of logs. */
  getRtspUrl(quality: StreamQuality): string {
    const rtspPort = this.config.rtspPort ?? 554;
    const channelSegment = String(this.channel + 1).padStart(2, '0');
    const user = encodeURIComponent(this.config.username);
    const pass = encodeURIComponent(this.config.password);
    return `rtsp://${user}:${pass}@${this.config.host}:${rtspPort}/h264Preview_${channelSegment}_${quality}`;
  }

  /**
   * Builds the source URL for Reolink's own RTMP-based "BCS" streaming protocol, an alternative
   * to RTSP that some Reolink setups find noticeably more reliable to establish a live session
   * with - Reolink's RTSP server is built on an old LIVE555 fork known for slow/flaky session
   * startup, while BCS/RTMP is Reolink's own more modern streaming path (also used internally by
   * their own apps). Credentials are passed as query params rather than embedded in the URL
   * authority, per Reolink's documented BCS URL format.
   */
  getRtmpUrl(quality: StreamQuality): string {
    const streamIndex = { main: 0, sub: 1, ext: 2 }[quality];
    const user = encodeURIComponent(this.config.username);
    const pass = encodeURIComponent(this.config.password);
    return (
      `rtmp://${this.config.host}:1935/bcs/channel0_${quality}.bcs` +
      `?channel=${this.channel}&stream=${streamIndex}&user=${user}&password=${pass}`
    );
  }
}
