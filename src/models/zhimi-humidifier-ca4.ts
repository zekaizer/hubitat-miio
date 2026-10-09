import { readProps, writeProps } from './miot';
import type { Brightness, HumidifierMode, HumidifierModel, HumidifierState } from './types';

// Every one of these is a property the humidifier has: one it does not have would make others
// in the same request fail.
const PROPS = {
  power: [2, 1],
  fault: [2, 2],
  mode: [2, 5],
  targetHumidity: [2, 6],
  waterLevel: [2, 7],
  dry: [2, 8],
  temperature: [3, 7],
  humidity: [3, 9],
  buzzer: [4, 1],
  brightness: [5, 2],
  lock: [6, 1],
} as const;

const READ = Object.keys(PROPS) as Array<keyof typeof PROPS>;

// fan-level and screen brightness, by the value the device uses.
const MODES: HumidifierMode[] = ['auto', 'low', 'medium', 'high'];
const BRIGHTNESS: Brightness[] = ['off', 'dim', 'bright'];

function named<T>(what: string, names: T[], value: unknown): T {
  const name = names[value as number];
  if (name === undefined) {
    throw new Error(`unexpected ${what} value ${JSON.stringify(value)}`);
  }
  return name;
}

// miot dialect. The reads were measured on a real humidifier. The writes were not: they follow
// the published spec, urn:miot-spec-v2:device:humidifier:0000A00E:zhimi-ca4:2.
export const zhimiHumidifierCa4: HumidifierModel = {
  model: 'zhimi.humidifier.ca4',

  async read(client): Promise<HumidifierState> {
    const p = await readProps(client, PROPS, READ);
    const brightness = named('brightness', BRIGHTNESS, p.brightness);
    return {
      power: p.power === true,
      mode: named('mode', MODES, p.mode),
      targetHumidity: Number(p.targetHumidity),
      humidity: Number(p.humidity),
      temperature: Number(p.temperature),
      waterLevel: Number(p.waterLevel),
      dry: p.dry === true,
      fault: Number(p.fault),
      lock: p.lock === true,
      buzzer: p.buzzer === true,
      light: brightness !== 'off',
      brightness,
    };
  },

  setPower: (client, on) => writeProps(client, PROPS, [['power', on]]),
  setMode: (client, mode) => writeProps(client, PROPS, [['mode', MODES.indexOf(mode)]]),
  setTargetHumidity: (client, percent) => writeProps(client, PROPS, [['targetHumidity', percent]]),
  setLock: (client, on) => writeProps(client, PROPS, [['lock', on]]),
  setBuzzer: (client, on) => writeProps(client, PROPS, [['buzzer', on]]),
  // On is the brightest of the three levels.
  setLight: (client, on) =>
    writeProps(client, PROPS, [['brightness', BRIGHTNESS.indexOf(on ? 'bright' : 'off')]]),
};
