import type { API } from 'homebridge';
import { ReolinkHksvDoorbellPlatform } from './platform';
import { PLATFORM_NAME } from './settings';

export default (api: API): void => {
  api.registerPlatform(PLATFORM_NAME, ReolinkHksvDoorbellPlatform);
};
