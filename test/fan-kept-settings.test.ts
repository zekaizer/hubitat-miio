import { afterEach, describe, expect, it } from 'vitest';

import type { DeviceMemory } from '../src/device';
import { MiioError } from '../src/miio/client';
import { MODELS, Rig } from './support/fan-rig';

const KEPT_WRITES = /set_buzzer|set_led_b|set (4|5)\/1/;

describe.each(MODELS)('fan kept settings: %s', (name) => {
  let rig: Rig;

  afterEach(async () => {
    await rig.close();
  });

  it('leaves the buzzer and the light alone unless told otherwise', async () => {
    rig = await (await Rig.create(name)).started();
    rig.atTheFan.light(false);
    rig.atTheFan.buzzer(true);
    rig.fan.refresh();
    await rig.fan.idle();
    expect(rig.writes.filter((w) => KEPT_WRITES.test(w))).toEqual([]);
    expect(rig.real).toMatchObject({ light: false, buzzer: true });
  });

  it('puts a kept setting at its value when it starts', async () => {
    rig = await (await Rig.create(name, { light: 'off', buzzer: 'on' })).started();
    expect(rig.real).toMatchObject({ light: false, buzzer: true });
  });

  it('puts back a kept setting that was changed at the fan', async () => {
    rig = await (await Rig.create(name, { light: 'off' })).started();
    rig.atTheFan.light(true);
    rig.fan.refresh();
    await rig.fan.idle();
    expect(rig.real.light).toBe(false);
    expect(rig.log.matching(/info keeping the light off/)).toHaveLength(2);
  });

  it('keeps a setting while the fan is off', async () => {
    rig = await Rig.create(name, { buzzer: 'on' });
    rig.atTheFan.power(false);
    await rig.started();
    expect(rig.real).toMatchObject({ power: false, buzzer: true });
  });

  it('does not write again and again to a fan that refuses the value', async () => {
    rig = await Rig.create(name, { light: 'off', enforceIntervalMs: 60_000 });
    let attempts = 0;
    rig.model.setLight = async () => {
      attempts += 1;
      throw new MiioError(-5001, 'invalid arg');
    };
    await rig.started();
    rig.fan.refresh();
    await rig.fan.idle();
    rig.fan.refresh();
    await rig.fan.idle();
    expect(attempts).toBe(1);
  });

  describe('at night', () => {
    it('uses the night value at night and the day value in the day', async () => {
      let night = true;
      rig = await Rig.create(name, { light: 'on', lightAtNight: 'off', isNight: () => night });
      await rig.started();
      expect(rig.real.light).toBe(false);
      night = false;
      rig.fan.refresh();
      await rig.fan.idle();
      expect(rig.real.light).toBe(true);
    });

    it('keeps the day value at night when the night value is "same"', async () => {
      rig = await Rig.create(name, { light: 'off', lightAtNight: 'same', isNight: () => true });
      await rig.started();
      expect(rig.real.light).toBe(false);
    });

    it('gives back what the fan had before the night when the day value is unmanaged', async () => {
      let night = true;
      rig = await Rig.create(name, { lightAtNight: 'off', isNight: () => night });
      await rig.started();
      expect(rig.real.light).toBe(false);
      night = false;
      rig.fan.refresh();
      await rig.fan.idle();
      expect(rig.real.light).toBe(true);
    });

    it('does not turn on in the morning what was off before the night', async () => {
      let night = true;
      rig = await Rig.create(name, { lightAtNight: 'off', isNight: () => night });
      rig.atTheFan.light(false);
      await rig.started();
      night = false;
      rig.fan.refresh();
      await rig.fan.idle();
      expect(rig.real.light).toBe(false);
      expect(rig.writes.filter((w) => KEPT_WRITES.test(w))).toEqual([]);
    });

    it('leaves a change made by hand in the day alone', async () => {
      rig = await Rig.create(name, { lightAtNight: 'off', isNight: () => false });
      await rig.started();
      rig.atTheFan.light(false);
      rig.fan.refresh();
      await rig.fan.idle();
      expect(rig.real.light).toBe(false);
      expect(rig.writes.filter((w) => KEPT_WRITES.test(w))).toEqual([]);
    });

    it('remembers what to give back across a restart', async () => {
      const memory: DeviceMemory = {};
      let saved = 0;
      const options = { lightAtNight: 'off' as const, memory, onMemoryChange: () => saved++ };
      rig = await Rig.create(name, { ...options, isNight: () => true });
      await rig.started();
      expect(memory.beforeNight).toEqual({ light: true });
      expect(saved).toBe(1);

      rig.newFan({ ...options, isNight: () => false });
      await rig.started();
      expect(rig.real.light).toBe(true);
      expect(memory.beforeNight).toBeUndefined();
      expect(saved).toBe(2);
    });
  });
});
