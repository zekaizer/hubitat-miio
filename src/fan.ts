import { Device, type DeviceOptions, type DeviceSnapshot } from './device';
import { type MiioClient, MiioTimeoutError } from './miio/client';
import type { Direction, FanModel, FanState } from './models';

export interface FanOptions extends DeviceOptions {
  /** Time from one head step to the next. */
  jogPeriodMs?: number;
}

export interface FanSnapshot extends DeviceSnapshot<FanState> {
  /** The direction the head is being turned in. */
  jog?: Direction;
}

// Time from one head step to the next. Not shorter: dmaker.fan.p33 answers steps sent 0.55 s
// apart with code 0 and skips some of them; 0.75 s apart it took every one.
const JOG_PERIOD_MS = 750;

export class Fan extends Device<FanState, FanModel> {
  private readonly jogPeriodMs: number;
  private queuedLevel?: number;
  private jog?: Direction;
  /** Goes up when a jog ends, so what is left of it knows. */
  private jogId = 0;
  private jogSteps = 0;
  private jogTimer?: NodeJS.Timeout;

  constructor(client: MiioClient, model: FanModel, options: FanOptions = {}) {
    super(client, model, 'the fan', options);
    this.jogPeriodMs = options.jogPeriodMs ?? JOG_PERIOD_MS;
  }

  override get snapshot(): FanSnapshot {
    return { ...super.snapshot, jog: this.jog };
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

  // A read between two steps of a jog would make the steps uneven.
  protected override busy(): boolean {
    return this.jog !== undefined;
  }

  protected override waiting(): boolean {
    return this.jogTimer !== undefined;
  }

  protected override halt(): void {
    this.endJog();
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
}
