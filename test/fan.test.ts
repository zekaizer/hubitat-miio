import { afterEach, describe, expect, it } from 'vitest';

import { MODELS, Rig } from './support/fan-rig';

describe.each(MODELS)('fan: %s', (name) => {
  let rig: Rig;

  afterEach(async () => {
    await rig.close();
  });

  describe('state and commands', () => {
    it('shows the state read from the fan once it is started', async () => {
      rig = await (await Rig.create(name)).started();
      expect(rig.fan.snapshot).toEqual({
        online: true,
        state: {
          power: true,
          level: 25,
          oscillation: false,
          natural: false,
          lock: false,
          buzzer: false,
          light: true,
        },
      });
      expect(rig.seen.at(-1)).toEqual(rig.fan.snapshot);
    });

    it('shows a new speed at once and gives it to the fan', async () => {
      rig = await (await Rig.create(name)).started();
      rig.fan.setLevel(60);
      expect(rig.fan.snapshot.state).toMatchObject({ power: true, level: 60 });
      await rig.fan.idle();
      expect(rig.real).toMatchObject({ power: true, level: 60 });
      expect(rig.fan.snapshot.state).toMatchObject({ power: true, level: 60 });
    });

    it('turns the fan on when a speed is set while it is off', async () => {
      rig = await Rig.create(name);
      rig.atTheFan.power(false);
      await rig.started();
      rig.fan.setLevel(40);
      await rig.fan.idle();
      expect(rig.real).toMatchObject({ power: true, level: 40 });
    });

    it('turns the fan off for speed 0', async () => {
      rig = await (await Rig.create(name)).started();
      rig.fan.setLevel(0);
      expect(rig.fan.snapshot.state).toMatchObject({ power: false, level: 25 });
      await rig.fan.idle();
      expect(rig.real).toMatchObject({ power: false, level: 25 });
    });

    it('ends on with the speed when HomeKit sends power and speed together', async () => {
      rig = await Rig.create(name);
      rig.atTheFan.power(false);
      await rig.started();
      rig.fan.setPower(true);
      rig.fan.setLevel(100);
      await rig.fan.idle();
      expect(rig.real).toMatchObject({ power: true, level: 100 });
      expect(rig.fan.snapshot.state).toMatchObject({ power: true, level: 100 });
    });

    it('writes only the last speed when several come in a row', async () => {
      rig = await (await Rig.create(name)).started();
      rig.fan.setLevel(10);
      rig.fan.setLevel(20);
      rig.fan.setLevel(30);
      await rig.fan.idle();
      expect(rig.real.level).toBe(30);
      expect(rig.writes).toHaveLength(1);
    });

    it('never shows the old speed again while a write is on its way', async () => {
      rig = await (await Rig.create(name)).started();
      rig.fan.refresh();
      rig.fan.setLevel(60);
      const from = rig.seen.length - 1;
      await rig.fan.idle();
      expect(rig.seen.slice(from).map((s) => s.state?.level)).not.toContain(25);
    });

    it('picks up what was changed at the fan', async () => {
      rig = await (await Rig.create(name)).started();
      rig.atTheFan.level(80);
      rig.atTheFan.swing(true);
      rig.fan.refresh();
      await rig.fan.idle();
      expect(rig.fan.snapshot.state).toMatchObject({ level: 80, oscillation: true });
    });

    it('reads the fan again every poll interval', async () => {
      rig = await (await Rig.create(name, { pollMs: 20 })).started();
      await new Promise((resolve) => setTimeout(resolve, 90));
      expect(rig.reads).toBeGreaterThanOrEqual(3);
    });

    it('sets the child lock, also while the fan is off', async () => {
      rig = await Rig.create(name);
      rig.atTheFan.power(false);
      await rig.started();
      rig.fan.setLock(true);
      expect(rig.fan.snapshot.state?.lock).toBe(true);
      await rig.fan.idle();
      expect(rig.real).toMatchObject({ power: false, lock: true });
    });

    it('never asks the fan for a speed above 100', async () => {
      rig = await (await Rig.create(name)).started();
      rig.fan.setLevel(500);
      expect(rig.fan.snapshot.state?.level).toBe(100);
      await rig.fan.idle();
      expect(rig.real.level).toBe(100);
    });

    it('shows what the fan has when the fan refuses a value', async () => {
      rig = await Rig.create(name);
      const setLevel = rig.model.setLevel;
      rig.model.setLevel = (client, _level, known) => setLevel(client, 101, known);
      await rig.started();
      rig.fan.setLevel(60);
      expect(rig.fan.snapshot.state?.level).toBe(60);
      await rig.fan.idle();
      expect(rig.fan.snapshot.state?.level).toBe(25);
      expect(rig.log.matching(/warn .*speed/)).toHaveLength(1);
    });
  });

  describe('a fan that stops answering', () => {
    it('goes offline, says so once, and shows the last state it read', async () => {
      rig = await (await Rig.create(name)).started();
      rig.device.silent = true;
      rig.fan.setLevel(80);
      expect(rig.fan.snapshot.state?.level).toBe(80);
      await rig.fan.idle();
      expect(rig.fan.snapshot).toMatchObject({ online: false, state: { level: 25 } });
      rig.fan.refresh();
      await rig.fan.idle();
      expect(rig.log.matching(/warn .*no reply/)).toHaveLength(1);
    });

    it('comes back online when the fan answers again', async () => {
      rig = await (await Rig.create(name)).started();
      rig.device.silent = true;
      rig.fan.refresh();
      await rig.fan.idle();
      rig.device.silent = false;
      rig.atTheFan.level(70);
      rig.fan.refresh();
      await rig.fan.idle();
      expect(rig.fan.snapshot).toMatchObject({ online: true, state: { level: 70 } });
      expect(rig.log.matching(/info .*answers again/)).toHaveLength(1);
    });

    it('points at the token when the fan answers the handshake only', async () => {
      rig = await Rig.create(name);
      rig.device.dropRequests = true;
      await rig.started();
      expect(rig.fan.snapshot.online).toBe(false);
      expect(rig.log.matching(/warn .*token/)).toHaveLength(1);
    });

    it('drops the commands that were waiting, instead of timing out on each', async () => {
      rig = await (await Rig.create(name)).started();
      rig.device.dropRequests = true;
      const before = rig.device.hellos;
      rig.fan.setLevel(80);
      rig.fan.setLock(true);
      rig.fan.setPower(false);
      await rig.fan.idle();
      // One request sent three times: first with the handshake it had, then after two new ones.
      expect(rig.device.hellos - before).toBe(2);
      expect(rig.fan.snapshot).toMatchObject({ online: false, state: { level: 25, lock: false } });
    });
  });
});
