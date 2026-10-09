import { Fan, type FanLog, type FanOptions, type FanSnapshot } from '../../src/fan';
import { MiioClient } from '../../src/miio/client';
import { type FanModel, fanModel } from '../../src/models';
import { FAKE_TOKEN, FakeDevice, type FakeModel } from './fake-device';

export class Log implements FanLog {
  readonly lines: string[] = [];
  info = (message: string): void => void this.lines.push(`info ${message}`);
  warn = (message: string): void => void this.lines.push(`warn ${message}`);
  debug = (): void => undefined;

  matching(pattern: RegExp): string[] {
    return this.lines.filter((line) => pattern.test(line));
  }
}

// A fake device, a client and a fan around them.
export class Rig {
  readonly log = new Log();
  readonly seen: FanSnapshot[] = [];
  fan!: Fan;
  private client!: MiioClient;

  private constructor(
    readonly device: FakeDevice,
    /** A copy: a test may replace a method. */
    readonly model: FanModel,
  ) {}

  static async create(
    name: FakeModel,
    options: FanOptions = {},
    model: Partial<FanModel> = {},
  ): Promise<Rig> {
    const rig = new Rig(await FakeDevice.start(name), {
      ...(fanModel(name) as FanModel),
      ...model,
    });
    rig.newFan(options);
    return rig;
  }

  /** Replaces the fan, as a restart of the plugin does. */
  newFan(options: FanOptions = {}): Fan {
    this.fan?.stop();
    this.client?.close();
    this.client = new MiioClient({
      address: this.device.address,
      port: this.device.port,
      token: FAKE_TOKEN,
      timeoutMs: 40,
    });
    this.fan = new Fan(this.client, this.model, {
      pollMs: 60_000,
      jogPeriodMs: 10,
      enforceIntervalMs: 0,
      log: this.log,
      ...options,
    });
    this.fan.onChange((snapshot) => this.seen.push(structuredClone(snapshot)));
    return this.fan;
  }

  /** Starts the fan and waits for the first read. */
  async started(): Promise<this> {
    this.fan.start();
    await this.fan.idle();
    return this;
  }

  async close(): Promise<void> {
    this.fan.stop();
    this.client.close();
    await this.device.close();
  }

  // What someone does at the fan itself, behind the plugin's back.
  atTheFan = {
    power: (on: boolean): void => {
      this.device.legacy.power = on ? 'on' : 'off';
      this.device.miot['2/1'] = on;
    },
    level: (level: number): void => {
      this.device.legacy.speed_level = level;
      this.device.miot['2/6'] = level;
    },
    swing: (on: boolean): void => {
      this.device.legacy.angle_enable = on ? 'on' : 'off';
      this.device.miot['2/4'] = on;
    },
    light: (on: boolean): void => {
      this.device.legacy.led_b = on ? 0 : 2;
      this.device.miot['4/1'] = on;
    },
    buzzer: (on: boolean): void => {
      this.device.legacy.buzzer = on ? 2 : 0;
      this.device.miot['5/1'] = on;
    },
  };

  /** The state the device really has. */
  get real(): {
    power: boolean;
    level: number;
    swing: boolean;
    light: boolean;
    buzzer: boolean;
    lock: boolean;
  } {
    const { legacy, miot } = this.device;
    return this.device.model === 'dmaker.fan.p33'
      ? {
          power: miot['2/1'] === true,
          level: miot['2/6'] as number,
          swing: miot['2/4'] === true,
          light: miot['4/1'] === true,
          buzzer: miot['5/1'] === true,
          lock: miot['7/1'] === true,
        }
      : {
          power: legacy.power === 'on',
          level: legacy.speed_level as number,
          swing: legacy.angle_enable === 'on',
          light: legacy.led_b !== 2,
          buzzer: legacy.buzzer !== 0,
          lock: legacy.child_lock === 'on',
        };
  }

  /** Requests that wrote something, as "method" or "method siid/piid,...". */
  get writes(): string[] {
    return this.device.requests
      .filter((r) => r.method.startsWith('set_'))
      .map((r) =>
        r.method === 'set_properties'
          ? `set ${(r.params as Array<{ siid: number; piid: number }>).map((i) => `${i.siid}/${i.piid}`).join(',')}`
          : r.method,
      );
  }

  get reads(): number {
    return this.device.methods.filter((m) => m === 'get_prop' || m === 'get_properties').length;
  }
}

export const MODELS: FakeModel[] = ['zhimi.fan.za1', 'dmaker.fan.p33'];
