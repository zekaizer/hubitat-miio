import { Device, type DeviceOptions } from './device';
import type { MiioClient } from './miio/client';
import type { HumidifierMode, HumidifierModel, HumidifierState } from './models';

const MIN_TARGET = 30;
const MAX_TARGET = 80;

export class Humidifier extends Device<HumidifierState, HumidifierModel> {
  private queuedTarget?: number;

  constructor(client: MiioClient, model: HumidifierModel, options: DeviceOptions = {}) {
    super(client, model, 'the humidifier', options);
  }

  setPower(on: boolean): void {
    this.show({ power: on });
    this.write('power', async () => {
      await this.model.setPower(this.client, on);
      return { power: on };
    });
  }

  setMode(mode: HumidifierMode): void {
    this.show({ mode });
    this.write('mode', async () => {
      await this.model.setMode(this.client, mode);
      return { mode };
    });
  }

  /** Kept within 30-80 %. */
  setTargetHumidity(percent: number): void {
    const value = Math.min(MAX_TARGET, Math.max(MIN_TARGET, Math.round(percent)));
    this.show({ targetHumidity: value });
    // A write that has not started yet takes the newest value.
    const waiting = this.queuedTarget !== undefined;
    this.queuedTarget = value;
    if (waiting) {
      return;
    }
    let target = value;
    this.write(
      'target humidity',
      async () => {
        await this.model.setTargetHumidity(this.client, target);
        return { targetHumidity: target };
      },
      {
        begin: () => {
          target = this.queuedTarget ?? target;
          this.queuedTarget = undefined;
        },
      },
    );
  }

  setLock(on: boolean): void {
    this.show({ lock: on });
    this.write('lock', async () => {
      await this.model.setLock(this.client, on);
      return { lock: on };
    });
  }
}
