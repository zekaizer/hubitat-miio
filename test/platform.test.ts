import type { Logging, PlatformAccessory, PlatformConfig } from 'homebridge';
import { HomebridgeAPI } from 'homebridge/lib/api';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MiioLocalPlatform } from '../src/platform';
import { PLATFORM_NAME, PLUGIN_NAME } from '../src/settings';
import { FAKE_TOKEN, FakeDevice, type FakeModel } from './support/fake-device';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean, what: string): Promise<void> {
  for (let waited = 0; !condition(); waited += 5) {
    if (waited > 1500) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await sleep(5);
  }
}

class Home {
  readonly api = new HomebridgeAPI();
  readonly lines: string[] = [];
  readonly registered: PlatformAccessory[] = [];
  readonly unregistered: PlatformAccessory[] = [];
  readonly updated: PlatformAccessory[] = [];
  readonly devices: FakeDevice[] = [];

  constructor() {
    vi.spyOn(this.api, 'registerPlatformAccessories').mockImplementation((_p, _n, list) => {
      this.registered.push(...list);
    });
    vi.spyOn(this.api, 'unregisterPlatformAccessories').mockImplementation((_p, _n, list) => {
      this.unregistered.push(...list);
    });
    vi.spyOn(this.api, 'updatePlatformAccessories').mockImplementation((list) => {
      this.updated.push(...list);
    });
  }

  async device(model: FakeModel): Promise<FakeDevice> {
    const device = await FakeDevice.start(model);
    this.devices.push(device);
    return device;
  }

  /** Starts the plugin as Homebridge does: cached accessories first, then the launch. */
  launch(config: object, cached: PlatformAccessory[] = []): MiioLocalPlatform {
    const log = Object.assign((message: string) => this.lines.push(`info ${message}`), {
      info: (message: string) => this.lines.push(`info ${message}`),
      warn: (message: string) => this.lines.push(`warn ${message}`),
      error: (message: string) => this.lines.push(`error ${message}`),
      debug: (message: string) => this.lines.push(`debug ${message}`),
    }) as unknown as Logging;
    const platform = new MiioLocalPlatform(
      log,
      { platform: PLATFORM_NAME, ...config } as PlatformConfig,
      this.api,
      { timeoutMs: 40, identifyRetryMs: 20 },
    );
    for (const accessory of cached) {
      platform.configureAccessory(accessory);
    }
    this.api.signalFinished();
    return platform;
  }

  entry(device: FakeDevice, extra: object = {}): object {
    return {
      name: 'Bedroom fan',
      address: device.address,
      port: device.port,
      token: FAKE_TOKEN,
      ...extra,
    };
  }

  async close(): Promise<void> {
    this.api.signalShutdown();
    await Promise.all(this.devices.map((device) => device.close()));
  }
}

describe('platform', () => {
  const homes: Home[] = [];
  const home = (): Home => {
    const created = new Home();
    homes.push(created);
    return created;
  };
  const { Service: S, Characteristic: C, Categories, HAPStatus } = new HomebridgeAPI().hap;
  const speed = (accessory: PlatformAccessory): unknown =>
    accessory.getService(S.Fanv2)?.getCharacteristic(C.RotationSpeed).value;

  afterEach(async () => {
    await Promise.all(homes.splice(0).map((h) => h.close()));
  });

  it.each<FakeModel>(['zhimi.fan.za1', 'dmaker.fan.p33'])(
    'adds a fan accessory for %s once the device has said what it is',
    async (model) => {
      const h = home();
      const device = await h.device(model);
      device.legacy.speed_level = 40;
      device.miot['2/6'] = 40;
      h.launch({ devices: [h.entry(device)] });
      await until(() => h.registered.length === 1, 'the accessory');
      const accessory = h.registered[0] as PlatformAccessory;
      expect(accessory.displayName).toBe('Bedroom fan');
      expect(accessory.category).toBe(Categories.FAN);
      expect(accessory.getService(S.AccessoryInformation)?.getCharacteristic(C.Model).value).toBe(
        model,
      );
      await until(() => speed(accessory) === 40, 'the first reading');
    },
  );

  it('never logs the token, which the device sends back in its description', async () => {
    const h = home();
    const device = await h.device('zhimi.fan.za1');
    h.launch({ devices: [h.entry(device)] });
    await until(() => h.registered.length === 1, 'the accessory');
    expect(device.methods).toContain('miIO.info');
    expect(h.lines.join('\n')).not.toContain(FAKE_TOKEN);
  });

  it('adds one accessory for each device', async () => {
    const h = home();
    const one = await h.device('zhimi.fan.za1');
    const two = await h.device('dmaker.fan.p33');
    h.launch({ devices: [h.entry(one, { name: 'One' }), h.entry(two, { name: 'Two' })] });
    await until(() => h.registered.length === 2, 'both accessories');
    expect(h.registered.map((a) => a.displayName).sort()).toEqual(['One', 'Two']);
    expect(new Set(h.registered.map((a) => a.UUID)).size).toBe(2);
  });

  it('adds the move switches when the device is configured with them', async () => {
    const h = home();
    const device = await h.device('zhimi.fan.za1');
    h.launch({ devices: [h.entry(device, { moveSwitches: true })] });
    await until(() => h.registered.length === 1, 'the accessory');
    expect(h.registered[0]?.getServiceById(S.Switch, 'move-left')).toBeDefined();
  });

  it('keeps asking a device that does not answer at first, and says so once', async () => {
    const h = home();
    const device = await h.device('zhimi.fan.za1');
    device.silent = true;
    h.launch({ devices: [h.entry(device)] });
    await sleep(400);
    expect(h.registered).toEqual([]);
    expect(h.lines.filter((line) => /warn Bedroom fan: .*no reply/.test(line))).toHaveLength(1);
    device.silent = false;
    await until(() => h.registered.length === 1, 'the accessory');
  });

  it('does not add a device it has no support for', async () => {
    const h = home();
    const device = await h.device('zhimi.humidifier.ca4' as FakeModel);
    h.launch({ devices: [h.entry(device)] });
    await until(
      () =>
        h.lines.some((line) =>
          /warn Bedroom fan: .*zhimi.humidifier.ca4.*not supported/.test(line),
        ),
      'the warning',
    );
    expect(h.registered).toEqual([]);
  });

  describe('with an accessory Homebridge has kept', () => {
    async function kept(h: Home, device: FakeDevice): Promise<PlatformAccessory> {
      const first = home();
      first.devices.push(device);
      first.launch({ devices: [first.entry(device)] });
      await until(() => first.registered.length === 1, 'the accessory');
      first.api.signalShutdown();
      first.devices.pop();
      h.devices.push(device);
      return first.registered[0] as PlatformAccessory;
    }

    it('uses it again without adding another', async () => {
      const h = home();
      const device = await FakeDevice.start('dmaker.fan.p33');
      const accessory = await kept(h, device);
      device.miot['2/6'] = 55;
      h.launch({ devices: [h.entry(device)] }, [accessory]);
      await until(() => speed(accessory) === 55, 'a reading');
      expect(h.registered).toEqual([]);
    });

    it('shows it as not responding when the device is gone at start', async () => {
      const h = home();
      const device = await FakeDevice.start('dmaker.fan.p33');
      const accessory = await kept(h, device);
      device.silent = true;
      h.launch({ devices: [h.entry(device)] }, [accessory]);
      const active = accessory.getService(S.Fanv2)?.getCharacteristic(C.Active);
      await until(() => h.lines.some((line) => /warn Bedroom fan: no reply/.test(line)), 'offline');
      await expect(active?.handleGetRequest()).rejects.toBe(
        HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    });

    it('removes it when its device is no longer configured', async () => {
      const h = home();
      const device = await FakeDevice.start('dmaker.fan.p33');
      const accessory = await kept(h, device);
      h.launch({ devices: [] }, [accessory]);
      expect(h.unregistered).toEqual([accessory]);
    });

    it('saves what the fan had before the night, for the next start', async () => {
      const h = home();
      const device = await FakeDevice.start('dmaker.fan.p33');
      const accessory = await kept(h, device);
      h.launch(
        {
          night: { start: '00:00', end: '23:59' },
          devices: [h.entry(device, { lightAtNight: 'off' })],
        },
        [accessory],
      );
      await until(() => device.miot['4/1'] === false, 'the night value');
      expect(accessory.context.memory).toEqual({ beforeNight: { light: true } });
      expect(h.updated).toContain(accessory);
    });
  });

  it('stops talking to the devices when Homebridge shuts down', async () => {
    const h = home();
    const device = await h.device('zhimi.fan.za1');
    h.launch({ devices: [h.entry(device, { pollInterval: 1 })] });
    await until(() => h.registered.length === 1, 'the accessory');
    await sleep(50);
    h.api.signalShutdown();
    await sleep(60);
    const before = device.requests.length;
    await sleep(1200);
    expect(device.requests).toHaveLength(before);
  });

  it('registers under the names in the package and the schema', () => {
    const pkg = require('../package.json') as { name: string };
    const schema = require('../config.schema.json') as { pluginAlias: string };
    expect(PLUGIN_NAME).toBe(pkg.name);
    expect(PLATFORM_NAME).toBe(schema.pluginAlias);
  });
});
