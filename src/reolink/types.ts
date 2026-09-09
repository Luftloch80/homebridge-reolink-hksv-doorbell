export interface ReolinkCommandRequest {
  cmd: string;
  action: 0 | 1;
  param?: Record<string, unknown>;
}

export interface ReolinkCommandResponse<T = Record<string, unknown>> {
  cmd: string;
  code: number;
  value?: T;
  error?: {
    rspCode: number;
    detail?: string;
  };
}

export interface LoginResponseValue {
  Token: {
    leaseTime: number;
    name: string;
  };
}

export interface AiStateEntry {
  alarm_state: 0 | 1;
  support: 0 | 1;
}

export interface AiStateValue {
  channel: number;
  visitor?: AiStateEntry;
  people?: AiStateEntry;
  face?: AiStateEntry;
  vehicle?: AiStateEntry;
  dog_cat?: AiStateEntry;
}

export interface MdStateValue {
  channel: number;
  state: 0 | 1;
}

export interface DevInfoValue {
  DevInfo: {
    channelNum: number;
    model: string;
    name: string;
    firmVer: string;
    type?: string;
  };
}
