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

export type HumidifierMode = 'auto' | 'low' | 'medium' | 'high';
export type Brightness = 'off' | 'dim' | 'bright';

export interface HumidifierState extends DeviceState {
  mode: HumidifierMode;
  /** Percent, 30-80. */
  targetHumidity: number;
  /** Percent. */
  humidity: number;
  /** Degrees Celsius. */
  temperature: number;
  /** As the device reports it, 0-128. What the scale means was not measured. */
  waterLevel: number;
  dry: boolean;
  /** 0: no fault. */
  fault: number;
  lock: boolean;
  /** Of the screen. light is whether it is anything but off. */
  brightness: Brightness;
}

// The writes follow the published spec. They were not measured on a real humidifier.
export interface HumidifierModel extends DeviceModel<HumidifierState> {
  setPower(client: MiioClient, on: boolean): Promise<void>;
  setMode(client: MiioClient, mode: HumidifierMode): Promise<void>;
  /** Percent, 30-80. */
  setTargetHumidity(client: MiioClient, percent: number): Promise<void>;
  setLock(client: MiioClient, on: boolean): Promise<void>;
}

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
