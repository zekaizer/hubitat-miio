import { type MiioClient, MiioTimeoutError } from './miio/client';
import type { Direction, FanModel, FanState } from './models';

/** A setting the plugin keeps at a value, or leaves alone. */
export type Kept = 'unmanaged' | 'on' | 'off';
/** The value of a kept setting during the night; same: the day value. */
export type AtNight = 'same' | 'on' | 'off';

export interface FanLog {
  info(message: string): void;
  warn(message: string): void;
  debug(message: string): void;
}

/** What survives a restart. Changed in place. */
export interface FanMemory {
  beforeNight?: { buzzer?: boolean; light?: boolean };
}

export interface FanOptions {
  pollMs?: number;
  buzzer?: Kept;
  light?: Kept;
  buzzerAtNight?: AtNight;
  lightAtNight?: AtNight;
  isNight?: () => boolean;
  memory?: FanMemory;
  onMemoryChange?: () => void;
  /** Time from one head step to the next. */
  jogPeriodMs?: number;
  enforceIntervalMs?: number;
  log?: FanLog;
}

export interface FanSnapshot {
  /** undefined until the fan answered or failed to answer for the first time. */
  online?: boolean;
  /** What to show: the last state read from the fan, with the commands not yet confirmed. */
  state?: FanState;
  /** The direction the head is being turned in. */
  jog?: Direction;
}

const POLL_MS = 15000;
const ENFORCE_INTERVAL_MS = 10000;
// Time from one head step to the next. Not shorter: dmaker.fan.p33 answers steps sent 0.55 s
// apart with code 0 and skips some of them; 0.75 s apart it took every one.
const JOG_PERIOD_MS = 750;
const KEPT = ['buzzer', 'light'] as const;
type KeptKey = (typeof KEPT)[number];
const SILENT: FanLog = { info: () => undefined, warn: () => undefined, debug: () => undefined };

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// One fan, independent of HomeKit. Commands return at once and show their effect in the snapshot
// before the fan confirms it; the read that follows the last write confirms or corrects it.
export class Fan {
  private readonly pollMs: number;
  private readonly enforceIntervalMs: number;
  private readonly jogPeriodMs: number;
  private readonly log: FanLog;
  private readonly day: Record<KeptKey, Kept>;
  private readonly atNight: Record<KeptKey, AtNight>;
  private readonly isNight: () => boolean;
  private readonly memory: FanMemory;
  private readonly onMemoryChange: () => void;

  /** The last state read from the fan, updated by the writes the fan accepted since. */
  private confirmed?: FanState;
  /** Values asked for and not yet confirmed by a read. */
  private pending: Partial<FanState> = {};
  private online?: boolean;
  private jog?: Direction;

  private readonly listeners: Array<(snapshot: FanSnapshot) => void> = [];
  private queue: Promise<void> = Promise.resolve();
  /** Tasks queued or running. */
  private tasks = 0;
  /** Writes queued or running. */
  private writes = 0;
  /** Goes up when the fan stops answering. A write queued before that is not sent. */
  private epoch = 0;
  private queuedLevel?: number;
  private readQueued = false;
  private pollTimer?: NodeJS.Timeout;
  private stopped = false;
  private keptAt = 0;
  /** Goes up when a jog ends, so what is left of it knows. */
  private jogId = 0;
  private jogSteps = 0;
  private jogTimer?: NodeJS.Timeout;

  constructor(
    private readonly client: MiioClient,
    private readonly model: FanModel,
    options: FanOptions = {},
  ) {
    this.pollMs = options.pollMs ?? POLL_MS;
    this.enforceIntervalMs = options.enforceIntervalMs ?? ENFORCE_INTERVAL_MS;
    this.jogPeriodMs = options.jogPeriodMs ?? JOG_PERIOD_MS;
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

  get snapshot(): FanSnapshot {
    return {
      online: this.online,
      state: this.confirmed && { ...this.confirmed, ...this.pending },
      jog: this.jog,
    };
  }

  onChange(listener: (snapshot: FanSnapshot) => void): void {
    this.listeners.push(listener);
  }

  /** Reads the state now and keeps reading it every pollMs. */
  start(): void {
    this.refresh();
    this.pollTimer = setInterval(() => {
      // A read between two steps of a jog would make the steps uneven.
      if (!this.jog) {
        this.refresh();
      }
    }, this.pollMs);
    this.pollTimer.unref();
  }

  /** Nothing is sent or reported after this. */
  stop(): void {
    this.stopped = true;
    clearInterval(this.pollTimer);
    this.endJog();
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
    while (this.tasks > 0 || this.jogTimer) {
      await (this.tasks > 0 ? this.queue : new Promise((resolve) => setTimeout(resolve, 1)));
    }
  }

  setPower(on: boolean): void {
    if (!on) {
      this.endJog();
    }
    this.show({ power: on });
    this.write('power', async () => {
      await this.model.setPower(this.client, on);
      return { power: on };
    });
  }

  /** 0 turns the fan off; any other level turns it on. */
  setLevel(level: number): void {
    const value = Math.min(100, Math.round(level));
    if (!(value >= 1)) {
      this.setPower(false);
      return;
    }
    this.show({ power: true, level: value });
    // A write that has not started yet takes the newest level.
    const waiting = this.queuedLevel !== undefined;
    this.queuedLevel = value;
    if (waiting) {
      return;
    }
    let target = value;
    this.write(
      'speed',
      async () => {
        await this.model.setLevel(this.client, target, this.confirmed);
        return { power: true, level: target };
      },
      {
        begin: () => {
          target = this.queuedLevel ?? target;
          this.queuedLevel = undefined;
        },
      },
    );
  }

  /** Ignored while the fan is off. */
  setOscillation(on: boolean): void {
    this.show({ oscillation: on });
    this.write(
      'oscillation',
      async () => {
        await this.model.setOscillation(this.client, on);
        return { oscillation: on };
      },
      { needsPower: true },
    );
  }

  setLock(on: boolean): void {
    this.show({ lock: on });
    this.write('lock', async () => {
      await this.model.setLock(this.client, on);
      return { lock: on };
    });
  }

  /**
   * Turns the head step by step until stopJog, or until it has crossed its whole range. Ignored
   * while the fan is off. Starting one direction stops the other.
   */
  startJog(direction: Direction): void {
    this.endJog();
    this.jog = direction;
    this.jogSteps = 0;
    const id = this.jogId;
    this.emit();
    this.run(async () => {
      // The jog can end at any await below; nothing of it may go on after that.
      if (id !== this.jogId) {
        return;
      }
      const on = await this.isOn('move');
      if (id !== this.jogId) {
        return;
      }
      if (!on) {
        this.endJog();
        this.emit();
        return;
      }
      // zhimi.fan.za1 answers device_busy to a move while it swings.
      if (this.confirmed?.oscillation) {
        try {
          await this.model.setOscillation(this.client, false);
          this.confirmed.oscillation = false;
        } catch (error) {
          this.failed('oscillation', error);
          this.endJog();
          this.emit();
          return;
        }
      }
      await this.jogStep(id, direction);
    });
  }

  /** The head stops after at most the step that was already sent. */
  stopJog(direction: Direction): void {
    if (this.jog !== direction) {
      return;
    }
    this.endJog();
    this.emit();
    this.refresh();
  }

  // The next step is never queued ahead: it is sent after the reply to this one, and no sooner
  // than jogPeriodMs after this one was sent.
  private async jogStep(id: number, direction: Direction): Promise<void> {
    if (id !== this.jogId) {
      return;
    }
    // The head is at the end of its range by now: a jog left on ends by itself.
    if (this.jogSteps >= this.model.moveSteps) {
      this.endJog();
      this.emit();
      await this.read();
      return;
    }
    this.jogSteps += 1;
    const sentAt = Date.now();
    try {
      await this.model.move(this.client, direction);
    } catch (error) {
      // A step is relative: sent again after a lost reply it could turn the head twice. The
      // read tells whether the fan is still there.
      if (error instanceof MiioTimeoutError) {
        this.log.debug('no reply to a move: the head may or may not have turned');
      } else {
        this.failed('move', error);
      }
      if (id === this.jogId) {
        this.endJog();
        this.emit();
      }
      await this.read();
      return;
    }
    if (id !== this.jogId) {
      return;
    }
    this.jogTimer = setTimeout(
      () => {
        this.jogTimer = undefined;
        this.run(() => this.jogStep(id, direction));
      },
      Math.max(0, this.jogPeriodMs - (Date.now() - sentAt)),
    );
  }

  private endJog(): void {
    clearTimeout(this.jogTimer);
    this.jogTimer = undefined;
    this.jog = undefined;
    this.jogId += 1;
  }

  private show(values: Partial<FanState>): void {
    Object.assign(this.pending, values);
    this.emit();
  }

  private emit(): void {
    const snapshot = this.snapshot;
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }

  private run(task: () => Promise<void>): void {
    this.tasks += 1;
    this.queue = this.queue
      .then(() => (this.stopped ? undefined : task()))
      .catch((error) => this.log.warn(`unexpected failure: ${describe(error)}`))
      .finally(() => {
        this.tasks -= 1;
      });
  }

  // send returns the values the fan accepted.
  // begin runs when the write's turn comes, whether it is sent or not.
  // needsPower: the write is not sent while the fan is off. The power held here can be one poll
  // interval old, so a fan held to be off is read first.
  private write(
    what: string,
    send: () => Promise<Partial<FanState>>,
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
        // or when the jog that is running ends.
        if (!this.jog) {
          await this.read();
        }
      } else {
        // Nothing was written, so what was last read stands.
        this.pending = {};
        this.emit();
      }
    });
  }

  private async isOn(what: string): Promise<boolean> {
    if (this.confirmed?.power) {
      return true;
    }
    await this.read();
    if (this.online === false) {
      return false;
    }
    if (!this.confirmed?.power) {
      this.log.warn(`${what} ignored: the fan is off`);
      return false;
    }
    return true;
  }

  private async read(): Promise<void> {
    let state: FanState;
    try {
      state = await this.model.read(this.client);
    } catch (error) {
      this.failed('read', error);
      return;
    }
    if (this.online === false) {
      this.log.info('the fan answers again');
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

  private wanted(key: KeptKey, night: boolean): boolean | undefined {
    const atNight = this.atNight[key];
    const value = night && atNight !== 'same' ? atNight : this.day[key];
    return value === 'unmanaged' ? undefined : value === 'on';
  }

  private keep(state: FanState): void {
    const night = this.isNight();
    this.trackNight(state, night);
    const off = KEPT.filter((key) => {
      const wanted = this.wanted(key, night);
      return wanted !== undefined && state[key] !== wanted;
    });
    // Not more often than enforceIntervalMs: the read after the write comes back at once, and a
    // fan that refuses the value would be written to in a loop.
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

  // While it is night, remembers what the fan had for each setting the night overrides and no
  // day value would put back. Those are written back when the night ends.
  private trackNight(state: FanState, night: boolean): void {
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
      return { [key]: value };
    });
  }

  private failed(what: string, error: unknown): void {
    if (this.stopped) {
      return;
    }
    if (!(error instanceof MiioTimeoutError)) {
      this.log.warn(`${what} failed: ${describe(error)}`);
      return;
    }
    // Said when the fan stops answering, not again on every poll while it stays silent.
    if (this.online !== false) {
      this.log.warn(
        error.handshakeAnswered
          ? 'the fan answers the handshake but not requests: check the token'
          : 'no reply from the fan',
      );
    }
    this.online = false;
    this.epoch += 1;
    // The writes that were asked for did not happen.
    this.pending = {};
    this.endJog();
    this.emit();
  }
}
