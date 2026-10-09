import { dmakerFanP33 } from './dmaker-fan-p33';
import type { FanModel } from './types';
import { zhimiFanZa1 } from './zhimi-fan-za1';

const FANS: FanModel[] = [zhimiFanZa1, dmakerFanP33];

export function fanModel(model: string): FanModel | undefined {
  return FANS.find((fan) => fan.model === model);
}

export type { DeviceModel, DeviceState, Direction, FanModel, FanState } from './types';
