import type {
  API,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
} from 'homebridge';

import { type Config, type DeviceConfig, endpoint, isNightAt, parseConfig } from './config';
import type { DeviceMemory } from './device';
import { Fan } from './fan';
import { type DeviceInfo, FanAccessory } from './fan-accessory';
import { Humidifier } from './humidifier';
import { HumidifierAccessory } from './humidifier-accessory';
import { MiioClient, MiioTimeoutError } from './miio/client';
import { fanModel, humidifierModel } from './models';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings';

/** Timings, for tests. */
export interface Tuning {
  timeoutMs?: number;
  identifyRetryMs?: number;
}

/** Kept by Homebridge with the accessory. */
interface Context {
  info?: DeviceInfo;
  memory?: DeviceMemory;
}

const IDENTIFY_RETRY_MS = 30000;

const supported = (model: string): boolean =>
  fanModel(model) !== undefined || humidifierModel(model) !== undefined;

export class MiioLocalPlatform implements DynamicPlatformPlugin {
  private readonly config: Config;
  private readonly cached = new Map<string, PlatformAccessory>();
  private readonly devices: Array<{ stop(): void }> = [];
  private readonly clients: MiioClient[] = [];
  private readonly wake = new Set<() => void>();
  private stopped = false;

  constructor(
    private readonly log: Logging,
    config: PlatformConfig,
    private readonly api: API,
    private readonly tuning: Tuning = {},
  ) {
    this.config = parseConfig(config, (message) => log.warn(message));
    api.on('didFinishLaunching', () => this.launch());
    api.on('shutdown', () => this.shutdown());
  }

  // Called by Homebridge for each accessory it has kept, before didFinishLaunching.
  configureAccessory(accessory: PlatformAccessory): void {
    this.cached.set(accessory.UUID, accessory);
  }

  private launch(): void {
    const configured = new Set<string>();
    for (const device of this.config.devices) {
      // The address identifies the accessory: a device that gets another address is a new one.
      const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${endpoint(device)}`);
      configured.add(uuid);
      this.setUp(device, uuid).catch((error) =>
        this.log.error(`${device.name}: could not be set up: ${String(error)}`),
      );
    }
    const gone = [...this.cached.values()].filter((accessory) => !configured.has(accessory.UUID));
    if (gone.length > 0) {
      this.log.info(`removing ${gone.map((accessory) => accessory.displayName).join(', ')}`);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, gone);
    }
  }

  private async setUp(device: DeviceConfig, uuid: string): Promise<void> {
    const client = new MiioClient({
      address: device.address,
      port: device.port,
      token: device.token,
      timeoutMs: this.tuning.timeoutMs,
    });
    this.clients.push(client);

    // An accessory Homebridge has kept is shown at once, also when its device is not there.
    const kept = this.cached.get(uuid);
    const known = (kept?.context as Context | undefined)?.info;
    const shown = kept !== undefined && known !== undefined && supported(known.model);
    if (shown) {
      this.build(device, client, kept, known);
    }

    // A device that is shown already says so itself when it does not answer.
    const info = await this.identify(device, client, shown);
    if (!info) {
      return;
    }
    if (!supported(info.model)) {
      this.log.warn(`${device.name}: the model ${info.model} is not supported`);
      return;
    }
    if (shown) {
      (kept.context as Context).info = info;
      return;
    }
    const { Categories } = this.api.hap;
    const category = fanModel(info.model) ? Categories.FAN : Categories.AIR_HUMIDIFIER;
    const accessory = kept ?? new this.api.platformAccessory(device.name, uuid, category);
    (accessory.context as Context).info = info;
    this.build(device, client, accessory, info);
    if (kept) {
      this.api.updatePlatformAccessories([accessory]);
    } else {
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }
  }

  // Asks the device what it is, again and again until it answers or Homebridge shuts down.
  private async identify(
    device: DeviceConfig,
    client: MiioClient,
    quiet: boolean,
  ): Promise<DeviceInfo | undefined> {
    let said = quiet;
    while (!this.stopped) {
      try {
        // The reply holds the token in clear. Only these fields are taken from it, and it is
        // never logged.
        const reply = await client.call<Record<string, unknown>>('miIO.info', []);
        return {
          model: String(reply.model),
          firmware: typeof reply.fw_ver === 'string' ? reply.fw_ver : undefined,
          serial: typeof reply.mac === 'string' ? reply.mac : undefined,
        };
      } catch (error) {
        if (!said && !this.stopped) {
          said = true;
          const why =
            error instanceof MiioTimeoutError && error.handshakeAnswered
              ? 'it answers the handshake but not requests: check the token'
              : error instanceof MiioTimeoutError
                ? 'no reply'
                : String(error);
          this.log.warn(
            `${device.name}: ${why} (${device.address}); asking again until it answers`,
          );
        }
        await this.sleep(this.tuning.identifyRetryMs ?? IDENTIFY_RETRY_MS);
      }
    }
    return undefined;
  }

  private build(
    device: DeviceConfig,
    client: MiioClient,
    accessory: PlatformAccessory,
    info: DeviceInfo,
  ): void {
    const context = accessory.context as Context;
    context.memory ??= {};
    const options = {
      pollMs: device.pollMs,
      buzzer: device.buzzer,
      light: device.light,
      buzzerAtNight: device.buzzerAtNight,
      lightAtNight: device.lightAtNight,
      isNight: () => isNightAt(this.config.night, new Date()),
      memory: context.memory,
      onMemoryChange: () => this.api.updatePlatformAccessories([accessory]),
      log: {
        info: (message: string) => this.log.info(`${device.name}: ${message}`),
        warn: (message: string) => this.log.warn(`${device.name}: ${message}`),
        debug: (message: string) => this.log.debug(`${device.name}: ${message}`),
      },
    };
    const fan = fanModel(info.model);
    const humidifier = humidifierModel(info.model);
    let started: Fan | Humidifier;
    if (fan) {
      started = new Fan(client, fan, options);
      new FanAccessory(this.api.hap, accessory, started, {
        name: device.name,
        moveSwitches: device.moveSwitches,
        info,
      });
    } else if (humidifier) {
      started = new Humidifier(client, humidifier, options);
      new HumidifierAccessory(this.api.hap, accessory, started, { name: device.name, info });
    } else {
      return;
    }
    this.devices.push(started);
    this.log.info(`${device.name}: ${info.model} at ${device.address}`);
    started.start();
  }

  private shutdown(): void {
    this.stopped = true;
    for (const device of this.devices) {
      device.stop();
    }
    for (const client of this.clients) {
      client.close();
    }
    for (const wake of this.wake) {
      wake();
    }
  }

  // Ends early at shutdown.
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const wake = (): void => {
        clearTimeout(timer);
        this.wake.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, ms);
      this.wake.add(wake);
    });
  }
}
