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
import { MiioClient, MiioTimeoutError } from './miio/client';
import { fanModel } from './models';
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

export class MiioLocalPlatform implements DynamicPlatformPlugin {
  private readonly config: Config;
  private readonly cached = new Map<string, PlatformAccessory>();
  private readonly fans: Fan[] = [];
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
    const shown = kept !== undefined && known !== undefined && fanModel(known.model) !== undefined;
    if (shown) {
      this.build(device, client, kept, known);
    }

    // The fan that is shown already says so itself when its device does not answer.
    const info = await this.identify(device, client, shown);
    if (!info) {
      return;
    }
    if (!fanModel(info.model)) {
      this.log.warn(`${device.name}: the model ${info.model} is not supported`);
      return;
    }
    if (shown) {
      (kept.context as Context).info = info;
      return;
    }
    const accessory =
      kept ?? new this.api.platformAccessory(device.name, uuid, this.api.hap.Categories.FAN);
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
    const model = fanModel(info.model);
    if (!model) {
      return;
    }
    const context = accessory.context as Context;
    context.memory ??= {};
    const fan = new Fan(client, model, {
      pollMs: device.pollMs,
      buzzer: device.buzzer,
      light: device.light,
      buzzerAtNight: device.buzzerAtNight,
      lightAtNight: device.lightAtNight,
      isNight: () => isNightAt(this.config.night, new Date()),
      memory: context.memory,
      onMemoryChange: () => this.api.updatePlatformAccessories([accessory]),
      log: {
        info: (message) => this.log.info(`${device.name}: ${message}`),
        warn: (message) => this.log.warn(`${device.name}: ${message}`),
        debug: (message) => this.log.debug(`${device.name}: ${message}`),
      },
    });
    new FanAccessory(this.api.hap, accessory, fan, {
      name: device.name,
      moveSwitches: device.moveSwitches,
      info,
    });
    this.fans.push(fan);
    this.log.info(`${device.name}: ${info.model} at ${device.address}`);
    fan.start();
  }

  private shutdown(): void {
    this.stopped = true;
    for (const fan of this.fans) {
      fan.stop();
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
