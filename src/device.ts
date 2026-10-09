import { type MiioClient, MiioTimeoutError } from './miio/client';
import type { DeviceModel, DeviceState } from './models';

/** A setting the plugin keeps at a value, or leaves alone. */
export type Kept = 'unmanaged' | 'on' | 'off';
/** The value of a kept setting during the night; same: the day value. */
export type AtNight = 'same' | 'on' | 'off';

export interface DeviceLog {
  info(message: string): void;
  warn(message: string): void;
  debug(message: string): void;
}

/** What survives a restart. Changed in place. */
export interface DeviceMemory {
  beforeNight?: { buzzer?: boolean; light?: boolean };
}

export interface DeviceOptions {
  pollMs?: number;
  buzzer?: Kept;
  light?: Kept;
  buzzerAtNight?: AtNight;
  lightAtNight?: AtNight;
  isNight?: () => boolean;
  memory?: DeviceMemory;
  onMemoryChange?: () => void;
  enforceIntervalMs?: number;
  log?: DeviceLog;
}

export interface DeviceSnapshot<S> {
  /** undefined until the device answered or failed to answer for the first time. */
  online?: boolean;
  /** What to show: the last state read from the device, with the commands not yet confirmed. */
  state?: S;
}

const POLL_MS = 15000;
const ENFORCE_INTERVAL_MS = 10000;
const KEPT = ['buzzer', 'light'] as const;
type KeptKey = (typeof KEPT)[number];
const SILENT: DeviceLog = { info: () => undefined, warn: () => undefined, debug: () => undefined };

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// One device, independent of HomeKit. Commands return at once and show their effect in the
// snapshot before the device confirms it; the read that follows the last write confirms or
// corrects it. Requests go out one at a time, in the order they were asked for.
export abstract class Device<S extends DeviceState, M extends DeviceModel<S> = DeviceModel<S>> {
  protected readonly log: DeviceLog;
  private readonly pollMs: number;
  private readonly enforceIntervalMs: number;
  private readonly day: Record<KeptKey, Kept>;
  private readonly atNight: Record<KeptKey, AtNight>;
  private readonly isNight: () => boolean;
  private readonly memory: DeviceMemory;
  private readonly onMemoryChange: () => void;

  /** The last state read from the device, updated by the writes it accepted since. */
  protected confirmed?: S;
  /** Values asked for and not yet confirmed by a read. */
  private pending: Partial<S> = {};
  protected online?: boolean;

  private readonly listeners: Array<(snapshot: DeviceSnapshot<S>) => void> = [];
  private queue: Promise<void> = Promise.resolve();
  /** Tasks queued or running. */
  private tasks = 0;
  /** Writes queued or running. */
  private writes = 0;
  /** Goes up when the device stops answering. A write queued before that is not sent. */
  private epoch = 0;
  private readQueued = false;
  private pollTimer?: NodeJS.Timeout;
  private stopped = false;
  private keptAt = 0;

  // noun: what the device is called in the log, such as "the fan".
  protected constructor(
    protected readonly client: MiioClient,
    protected readonly model: M,
    private readonly noun: string,
    options: DeviceOptions,
  ) {
    this.pollMs = options.pollMs ?? POLL_MS;
    this.enforceIntervalMs = options.enforceIntervalMs ?? ENFORCE_INTERVAL_MS;
    this.log = options.log ?? SILENT;
    this.day = { buzzer: options.buzzer ?? 'unmanaged', light: options.light ?? 'unmanaged' };
    this.atNight = {
      buzzer: options.buzzerAtNight ?? 'same',
      light: options.lightAtNight ?? 'same',
    };
    this.isNight = options.isNight ?? (() => false);
    this.memory = options.memory ?? {};
    this.onMemoryChange = options.onMemoryChange ?? (() => undefined);
  }

  get snapshot(): DeviceSnapshot<S> {
    return {
      online: this.online,
      state: this.confirmed && { ...this.confirmed, ...this.pending },
    };
  }

  onChange(listener: (snapshot: this['snapshot']) => void): void {
    this.listeners.push(listener as (snapshot: DeviceSnapshot<S>) => void);
  }

  /** Reads the state now and keeps reading it every pollMs. */
  start(): void {
    this.refresh();
    this.pollTimer = setInterval(() => {
      if (!this.busy()) {
        this.refresh();
      }
    }, this.pollMs);
    this.pollTimer.unref();
  }

  /** Nothing is sent or reported after this. */
  stop(): void {
    this.stopped = true;
    clearInterval(this.pollTimer);
    this.halt();
  }

  /** Reads the state now. */
  refresh(): void {
    if (this.readQueued) {
      return;
    }
    this.readQueued = true;
    this.run(async () => {
      this.readQueued = false;
      await this.read();
    });
  }

  /** Resolves once every command and read asked for so far is done. */
  async idle(): Promise<void> {
    while (this.tasks > 0 || this.waiting()) {
      await (this.tasks > 0 ? this.queue : new Promise((resolve) => setTimeout(resolve, 1)));
    }
  }

  /** True while reads must stay out of the way of what the device is doing. */
  protected busy(): boolean {
    return false;
  }

  /** True while something is due that is not in the queue yet. */
  protected waiting(): boolean {
    return false;
  }

  /** Ends what is going on, when the device stops answering or the plugin stops. */
  protected halt(): void {}

  protected show(values: Partial<S>): void {
    Object.assign(this.pending, values);
    this.emit();
  }

  protected emit(): void {
    const snapshot = this.snapshot;
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }

  protected run(task: () => Promise<void>): void {
    this.tasks += 1;
    this.queue = this.queue
      .then(() => (this.stopped ? undefined : task()))
      .catch((error) => this.log.warn(`unexpected failure: ${describe(error)}`))
      .finally(() => {
        this.tasks -= 1;
      });
  }

  // send returns the values the device accepted.
  // begin runs when the write's turn comes, whether it is sent or not.
  // needsPower: the write is not sent while the device is off. The power held here can be one
  // poll interval old, so a device held to be off is read first.
  protected write(
    what: string,
    send: () => Promise<Partial<S>>,
    options: { begin?: () => void; needsPower?: boolean } = {},
  ): void {
    const epoch = this.epoch;
    this.writes += 1;
    this.run(async () => {
      options.begin?.();
      let sent = false;
      try {
        if (epoch === this.epoch && (!options.needsPower || (await this.isOn(what)))) {
          sent = true;
          const accepted = await send();
          this.log.debug(`${what} written: ${JSON.stringify(accepted)}`);
          if (this.confirmed) {
            Object.assign(this.confirmed, accepted);
          }
        }
      } catch (error) {
        this.failed(what, error);
      } finally {
        this.writes -= 1;
      }
      if (this.writes > 0 || this.online === false) {
        return;
      }
      if (sent) {
        // A write reply carries no state. It is read back once the last queued write is done,
        // or when what keeps the device busy ends.
        if (!this.busy()) {
          await this.read();
        }
      } else {
        // Nothing was written, so what was last read stands.
        this.pending = {};
        this.emit();
      }
    });
  }

  protected async isOn(what: string): Promise<boolean> {
    if (this.confirmed?.power) {
      return true;
    }
    await this.read();
    if (this.online === false) {
      return false;
    }
    if (!this.confirmed?.power) {
      this.log.warn(`${what} ignored: ${this.noun} is off`);
      return false;
    }
    return true;
  }

  protected async read(): Promise<void> {
    let state: S;
    try {
      state = await this.model.read(this.client);
    } catch (error) {
      this.failed('read', error);
      return;
    }
    if (this.online === false) {
      this.log.info(`${this.noun} answers again`);
    }
    this.online = true;
    this.confirmed = state;
    this.log.debug(`read: ${JSON.stringify(state)}`);
    // With a write still queued this reading is older than what was asked for.
    if (this.writes === 0) {
      this.pending = {};
    }
    this.emit();
    if (this.writes === 0) {
      this.keep(state);
    }
  }

  protected failed(what: string, error: unknown): void {
    if (this.stopped) {
      return;
    }
    if (!(error instanceof MiioTimeoutError)) {
      this.log.warn(`${what} failed: ${describe(error)}`);
      return;
    }
    // Said when the device stops answering, not again on every poll while it stays silent.
    if (this.online !== false) {
      this.log.warn(
        error.handshakeAnswered
          ? `${this.noun} answers the handshake but not requests: check the token`
          : `no reply from ${this.noun}`,
      );
    }
    this.online = false;
    this.epoch += 1;
    // The writes that were asked for did not happen.
    this.pending = {};
    this.halt();
    this.emit();
  }

  private wanted(key: KeptKey, night: boolean): boolean | undefined {
    const atNight = this.atNight[key];
    const value = night && atNight !== 'same' ? atNight : this.day[key];
    return value === 'unmanaged' ? undefined : value === 'on';
  }

  private keep(state: S): void {
    const night = this.isNight();
    this.trackNight(state, night);
    const off = KEPT.filter((key) => {
      const wanted = this.wanted(key, night);
      return wanted !== undefined && state[key] !== wanted;
    });
    // Not more often than enforceIntervalMs: the read after the write comes back at once, and a
    // device that refuses the value would be written to in a loop.
    if (off.length === 0 || Date.now() - this.keptAt < this.enforceIntervalMs) {
      return;
    }
    this.keptAt = Date.now();
    for (const key of off) {
      const value = this.wanted(key, night) as boolean;
      this.log.info(`keeping the ${key} ${value ? 'on' : 'off'}`);
      this.writeKept(key, value);
    }
  }

  // While it is night, remembers what the device had for each setting the night overrides and
  // no day value would put back. Those are written back when the night ends.
  private trackNight(state: S, night: boolean): void {
    const before = this.memory.beforeNight;
    if (night) {
      const added = KEPT.filter(
        (key) =>
          this.atNight[key] !== 'same' &&
          this.day[key] === 'unmanaged' &&
          before?.[key] === undefined,
      );
      if (added.length > 0) {
        this.memory.beforeNight = {
          ...before,
          ...Object.fromEntries(added.map((key) => [key, state[key]])),
        };
        this.onMemoryChange();
      }
      return;
    }
    if (!before) {
      return;
    }
    delete this.memory.beforeNight;
    this.onMemoryChange();
    for (const key of KEPT) {
      const value = before[key];
      if (value !== undefined && this.day[key] === 'unmanaged' && state[key] !== value) {
        this.log.info(`the night is over: putting the ${key} back ${value ? 'on' : 'off'}`);
        this.writeKept(key, value);
      }
    }
  }

  private writeKept(key: KeptKey, value: boolean): void {
    this.write(key, async () => {
      await (key === 'buzzer'
        ? this.model.setBuzzer(this.client, value)
        : this.model.setLight(this.client, value));
      return { [key]: value } as Partial<S>;
    });
  }
}
