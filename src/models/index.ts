import { dmakerFanP33 } from './dmaker-fan-p33';
import type { FanModel, HumidifierModel } from './types';
import { zhimiFanZa1 } from './zhimi-fan-za1';
import { zhimiHumidifierCa4 } from './zhimi-humidifier-ca4';

const FANS: FanModel[] = [zhimiFanZa1, dmakerFanP33];
const HUMIDIFIERS: HumidifierModel[] = [zhimiHumidifierCa4];

export function fanModel(model: string): FanModel | undefined {
  return FANS.find((fan) => fan.model === model);
}

export function humidifierModel(model: string): HumidifierModel | undefined {
  return HUMIDIFIERS.find((humidifier) => humidifier.model === model);
}

export type {
  Brightness,
  DeviceModel,
  DeviceState,
  Direction,
  FanModel,
  FanState,
  HumidifierMode,
  HumidifierModel,
  HumidifierState,
} from './types';
