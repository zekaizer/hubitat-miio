import { type CallOptions, type MiioClient, MiioError } from '../miio/client';
import type { FanModel, FanState } from './types';

// siid, piid. level is 2/6: the spec calls it a read-only status, the fan takes 1-100 there.
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

type Prop = keyof typeof PROPS;

const READ: Prop[] = ['power', 'level', 'oscillation', 'mode', 'light', 'buzzer', 'lock'];

interface Item {
  did: string;
  code: number;
  value?: unknown;
}

const address = (name: Prop): { did: string; siid: number; piid: number } => ({
  did: name,
  siid: PROPS[name][0],
  piid: PROPS[name][1],
});

// Values must have their JSON type: the fan takes any string for a boolean as false. The fan
// applies the items in the order given.
async function write(
  client: MiioClient,
  values: Array<[Prop, boolean | number]>,
  options?: CallOptions,
): Promise<void> {
  const items = await client.call<Item[]>(
    'set_properties',
    values.map(([name, value]) => ({ ...address(name), value })),
    options,
  );
  const refused = items.find((item) => item.code !== 0);
  if (refused) {
    throw new MiioError(refused.code, `${refused.did} rejected`);
  }
}

// miot dialect: get_properties and set_properties, each item answered with its own code.
export const dmakerFanP33: FanModel = {
  model: 'dmaker.fan.p33',
  // Counted by eye as 27; the fan does not report the end of the range.
  moveSteps: 28,

  async read(client): Promise<FanState> {
    const items = await client.call<Item[]>('get_properties', READ.map(address));
    const p = Object.fromEntries(
      items.filter((item) => item.code === 0).map((item) => [item.did, item.value]),
    );
    const missing = READ.filter((name) => p[name] === undefined);
    if (missing.length > 0) {
      throw new Error(`the fan did not give ${missing.join(', ')}`);
    }
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

  setPower: (client, on) => write(client, [['power', on]]),

  // The power always goes with the level: a level alone is stored without turning the fan on.
  // Power first: the fan ignores a level written before the power in the same request.
  setLevel: (client, level) =>
    write(client, [
      ['power', true],
      ['level', level],
    ]),

  setOscillation: (client, on) => write(client, [['oscillation', on]]),
  setLock: (client, on) => write(client, [['lock', on]]),
  setBuzzer: (client, on) => write(client, [['buzzer', on]]),
  setLight: (client, on) => write(client, [['light', on]]),

  // Answers code 0 at the end of the range too.
  move: (client, direction) =>
    write(client, [['move', direction === 'left' ? 1 : 2]], { retry: false }),
};
