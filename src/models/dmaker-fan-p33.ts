import { readProps, writeProps } from './miot';
import type { FanModel, FanState } from './types';

// level is 2/6: the spec calls it a read-only status, the fan takes 1-100 there.
const PROPS = {
  power: [2, 1],
  level: [2, 6],
  oscillation: [2, 4],
  mode: [2, 3],
  light: [4, 1],
  buzzer: [5, 1],
  move: [6, 1],
  lock: [7, 1],
} as const;

const READ = ['power', 'level', 'oscillation', 'mode', 'light', 'buzzer', 'lock'] as const;

// miot dialect: get_properties and set_properties, each item answered with its own code.
export const dmakerFanP33: FanModel = {
  model: 'dmaker.fan.p33',
  // Counted by eye as 27; the fan does not report the end of the range.
  moveSteps: 28,

  async read(client): Promise<FanState> {
    const p = await readProps(client, PROPS, READ);
    return {
      power: p.power === true,
      level: Number(p.level),
      oscillation: p.oscillation === true,
      natural: p.mode === 1,
      lock: p.lock === true,
      buzzer: p.buzzer === true,
      light: p.light === true,
    };
  },

  setPower: (client, on) => writeProps(client, PROPS, [['power', on]]),

  // The power always goes with the level: a level alone is stored without turning the fan on.
  // Power first: the fan ignores a level written before the power in the same request.
  setLevel: (client, level) =>
    writeProps(client, PROPS, [
      ['power', true],
      ['level', level],
    ]),

  setOscillation: (client, on) => writeProps(client, PROPS, [['oscillation', on]]),
  setLock: (client, on) => writeProps(client, PROPS, [['lock', on]]),
  setBuzzer: (client, on) => writeProps(client, PROPS, [['buzzer', on]]),
  setLight: (client, on) => writeProps(client, PROPS, [['light', on]]),

  // Answers code 0 at the end of the range too.
  move: (client, direction) =>
    writeProps(client, PROPS, [['move', direction === 'left' ? 1 : 2]], { retry: false }),
};
