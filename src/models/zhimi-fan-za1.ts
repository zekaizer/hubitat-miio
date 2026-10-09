import { type MiioClient, MiioError } from '../miio/client';
import type { FanModel, FanState } from './types';

const PROPS = [
  'power',
  'speed_level',
  'angle_enable',
  'mode',
  'child_lock',
  'buzzer',
  'led_b',
] as const;

const POWERED_OFF = -6011;

const onOff = (on: boolean): string => (on ? 'on' : 'off');

async function set(client: MiioClient, method: string, value: string | number): Promise<void> {
  await client.call(method, [value]);
}

// Legacy miio dialect: get_prop and one set_* method per property.
export const zhimiFanZa1: FanModel = {
  model: 'zhimi.fan.za1',
  // Counted by eye as 22; the fan does not report the end of the range.
  moveSteps: 24,

  async read(client): Promise<FanState> {
    const values = await client.call<unknown[]>('get_prop', PROPS);
    const p = Object.fromEntries(PROPS.map((name, i) => [name, values[i]]));
    // A property the fan does not have reads as the string "null".
    const missing = PROPS.filter((name) => p[name] === undefined || p[name] === 'null');
    if (missing.length > 0) {
      throw new Error(`the fan did not give ${missing.join(', ')}`);
    }
    return {
      power: p.power === 'on',
      level: Number(p.speed_level),
      oscillation: p.angle_enable === 'on',
      natural: p.mode === 'natural',
      lock: p.child_lock === 'on',
      buzzer: p.buzzer !== 0,
      light: p.led_b !== 2,
    };
  },

  // Only the lowercase strings are accepted.
  setPower: (client, on) => set(client, 'set_power', onOff(on)),

  async setLevel(client, level, known): Promise<void> {
    // set_speed_level leaves natural wind; set_natural_level keeps it.
    const method = known?.natural ? 'set_natural_level' : 'set_speed_level';
    // The fan refuses a speed while it is off.
    if (known && !known.power) {
      await set(client, 'set_power', 'on');
    }
    try {
      await set(client, method, level);
    } catch (error) {
      if (!(error instanceof MiioError) || error.code !== POWERED_OFF) {
        throw error;
      }
      // Switched off since the last read.
      await set(client, 'set_power', 'on');
      await set(client, method, level);
    }
  },

  // Any value other than "on" turns the swing off without an error.
  setOscillation: (client, on) => set(client, 'set_angle_enable', onOff(on)),
  setLock: (client, on) => set(client, 'set_child_lock', onOff(on)),
  // Value meanings follow python-miio (buzzer 2 on; led_b 0 bright, 2 off); not checked by eye.
  setBuzzer: (client, on) => set(client, 'set_buzzer', on ? 2 : 0),
  setLight: (client, on) => set(client, 'set_led_b', on ? 0 : 2),

  // Answers -6007 device_busy while the fan swings.
  async move(client, direction): Promise<void> {
    await client.call('set_move', [direction], { retry: false });
  },
};
