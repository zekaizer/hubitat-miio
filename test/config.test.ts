import { describe, expect, it } from 'vitest';

import { isNightAt, parseConfig } from '../src/config';

const TOKEN = '00112233445566778899aabbccddeeff';
const at = (time: string): Date => new Date(`2026-10-09T${time}:00`);

function parse(raw: unknown): { config: ReturnType<typeof parseConfig>; warnings: string[] } {
  const warnings: string[] = [];
  return { config: parseConfig(raw, (message) => warnings.push(message)), warnings };
}

describe('config', () => {
  it('reads a device with its defaults', () => {
    const { config, warnings } = parse({
      devices: [{ name: 'Fan', address: '192.168.1.97', token: TOKEN }],
    });
    expect(config).toEqual({
      night: undefined,
      devices: [
        {
          name: 'Fan',
          address: '192.168.1.97',
          port: undefined,
          token: TOKEN,
          pollMs: undefined,
          moveSwitches: false,
          buzzer: 'unmanaged',
          light: 'unmanaged',
          buzzerAtNight: 'same',
          lightAtNight: 'same',
        },
      ],
    });
    expect(warnings).toEqual([]);
  });

  it('reads every setting of a device', () => {
    const { config } = parse({
      night: { start: '22:00', end: '07:30' },
      devices: [
        {
          name: 'Fan',
          address: '192.168.1.97',
          token: ` ${TOKEN.toUpperCase()} `,
          pollInterval: 30,
          moveSwitches: true,
          buzzer: 'off',
          light: 'on',
          buzzerAtNight: 'same',
          lightAtNight: 'off',
        },
      ],
    });
    expect(config.night).toEqual({ start: '22:00', end: '07:30' });
    expect(config.devices[0]).toMatchObject({
      token: TOKEN.toUpperCase(),
      pollMs: 30000,
      moveSwitches: true,
      buzzer: 'off',
      light: 'on',
      lightAtNight: 'off',
    });
  });

  it('leaves out a device without an address or with a bad token, and says which', () => {
    const { config, warnings } = parse({
      devices: [
        { name: 'No address', token: TOKEN },
        { name: 'Bad token', address: '192.168.1.98', token: 'secret-but-wrong' },
        { name: 'Good', address: '192.168.1.99', token: TOKEN },
      ],
    });
    expect(config.devices.map((d) => d.name)).toEqual(['Good']);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/No address.*address/);
    expect(warnings[1]).toMatch(/Bad token.*32 hex/);
    expect(warnings.join(' ')).not.toContain('secret-but-wrong');
  });

  it('leaves out a second device at the same address', () => {
    const { config, warnings } = parse({
      devices: [
        { name: 'One', address: '192.168.1.97', token: TOKEN },
        { name: 'Two', address: '192.168.1.97', token: TOKEN },
      ],
    });
    expect(config.devices.map((d) => d.name)).toEqual(['One']);
    expect(warnings[0]).toMatch(/Two.*192\.168\.1\.97/);
  });

  it('falls back to the default for a value it does not know', () => {
    const { config, warnings } = parse({
      devices: [
        { name: 'Fan', address: '192.168.1.97', token: TOKEN, light: 'dim', pollInterval: -5 },
      ],
    });
    expect(config.devices[0]).toMatchObject({ light: 'unmanaged', pollMs: undefined });
    expect(warnings).toHaveLength(2);
  });

  it('ignores a night that is not two times of day', () => {
    const { config, warnings } = parse({ night: { start: '25:00', end: '07:00' }, devices: [] });
    expect(config.night).toBeUndefined();
    expect(warnings[0]).toMatch(/night/);
  });

  it('has no devices when none are configured', () => {
    expect(parse({}).config.devices).toEqual([]);
    expect(parse(undefined).config.devices).toEqual([]);
  });
});

describe('night', () => {
  const overnight = { start: '22:00', end: '07:00' };

  it('runs across midnight', () => {
    expect(isNightAt(overnight, at('21:59'))).toBe(false);
    expect(isNightAt(overnight, at('22:00'))).toBe(true);
    expect(isNightAt(overnight, at('03:00'))).toBe(true);
    expect(isNightAt(overnight, at('06:59'))).toBe(true);
    expect(isNightAt(overnight, at('07:00'))).toBe(false);
    expect(isNightAt(overnight, at('12:00'))).toBe(false);
  });

  it('runs within one day', () => {
    const nap = { start: '13:00', end: '15:00' };
    expect(isNightAt(nap, at('12:59'))).toBe(false);
    expect(isNightAt(nap, at('13:00'))).toBe(true);
    expect(isNightAt(nap, at('15:00'))).toBe(false);
  });

  it('is never night without a schedule or with an empty one', () => {
    expect(isNightAt(undefined, at('03:00'))).toBe(false);
    expect(isNightAt({ start: '22:00', end: '22:00' }, at('22:00'))).toBe(false);
  });
});
