import type { MiioClient } from '../miio/client';

export interface FanState {
  power: boolean;
  /** Speed in percent, 1-100. Kept while the fan is off. */
  level: number;
  oscillation: boolean;
  /** Natural wind mode. */
  natural: boolean;
  lock: boolean;
  buzzer: boolean;
  light: boolean;
}

export type Direction = 'left' | 'right';

// What both fan models can do, with the differences between their dialects hidden. Every method
// rejects with MiioError when the fan refuses and with MiioTimeoutError when it does not answer.
export interface FanModel {
  readonly model: string;
  /** Move steps that take the head across its whole range. */
  readonly moveSteps: number;
  read(client: MiioClient): Promise<FanState>;
  setPower(client: MiioClient, on: boolean): Promise<void>;
  /**
   * Sets the speed and turns the fan on. known is the last state read from the fan, which may be
   * out of date.
   */
  setLevel(client: MiioClient, level: number, known?: FanState): Promise<void>;
  setOscillation(client: MiioClient, on: boolean): Promise<void>;
  setLock(client: MiioClient, on: boolean): Promise<void>;
  setBuzzer(client: MiioClient, on: boolean): Promise<void>;
  setLight(client: MiioClient, on: boolean): Promise<void>;
  /** Turns the head one step. Not sent again when the reply is lost. */
  move(client: MiioClient, direction: Direction): Promise<void>;
}
