import type { MiioClient } from '../miio/client';

/** What every device has. */
export interface DeviceState {
  power: boolean;
  buzzer: boolean;
  light: boolean;
}

// What the plugin needs from every model. Every method rejects with MiioError when the device
// refuses and with MiioTimeoutError when it does not answer.
export interface DeviceModel<S extends DeviceState> {
  readonly model: string;
  read(client: MiioClient): Promise<S>;
  setBuzzer(client: MiioClient, on: boolean): Promise<void>;
  setLight(client: MiioClient, on: boolean): Promise<void>;
}

export interface FanState extends DeviceState {
  /** Speed in percent, 1-100. Kept while the fan is off. */
  level: number;
  oscillation: boolean;
  /** Natural wind mode. */
  natural: boolean;
  lock: boolean;
}

export type Direction = 'left' | 'right';

// What both fan models can do, with the differences between their dialects hidden.
export interface FanModel extends DeviceModel<FanState> {
  /** Move steps that take the head across its whole range. */
  readonly moveSteps: number;
  setPower(client: MiioClient, on: boolean): Promise<void>;
  /**
   * Sets the speed and turns the fan on. known is the last state read from the fan, which may be
   * out of date.
   */
  setLevel(client: MiioClient, level: number, known?: FanState): Promise<void>;
  setOscillation(client: MiioClient, on: boolean): Promise<void>;
  setLock(client: MiioClient, on: boolean): Promise<void>;
  /** Turns the head one step. Not sent again when the reply is lost. */
  move(client: MiioClient, direction: Direction): Promise<void>;
}
