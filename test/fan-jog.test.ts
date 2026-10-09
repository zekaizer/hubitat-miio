import { afterEach, describe, expect, it } from 'vitest';

import { MODELS, Rig } from './support/fan-rig';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// The rig sends a step 10 ms after the reply to the one before.
describe.each(MODELS)('fan jog: %s', (name) => {
  let rig: Rig;

  afterEach(async () => {
    await rig.close();
  });

  // 'move', 'read' or the method, for each request the device got.
  const traffic = (): string[] =>
    rig.device.requests.map((r) => {
      const first = (r.params as Array<{ siid?: number; piid?: number }>)[0];
      if (r.method === 'set_move' || (first?.siid === 6 && first?.piid === 1)) {
        return 'move';
      }
      return r.method.startsWith('get_') ? 'read' : r.method;
    });

  it('turns the head step by step until it is told to stop', async () => {
    rig = await (await Rig.create(name)).started();
    rig.fan.startJog('left');
    expect(rig.fan.snapshot.jog).toBe('left');
    await sleep(70);
    rig.fan.stopJog('left');
    expect(rig.fan.snapshot.jog).toBeUndefined();
    const sent = rig.device.moves.length;
    expect(sent).toBeGreaterThanOrEqual(2);
    await rig.fan.idle();
    await sleep(40);
    // At most the step that was already on its way.
    expect(rig.device.moves.length).toBeLessThanOrEqual(sent + 1);
    expect(new Set(rig.device.moves)).toEqual(new Set(['left']));
  });

  it('stops by itself once the head has crossed its range', async () => {
    rig = await (await Rig.create(name, {}, { moveSteps: 3 })).started();
    rig.fan.startJog('right');
    await rig.fan.idle();
    expect(rig.device.moves).toEqual(['right', 'right', 'right']);
    expect(rig.fan.snapshot.jog).toBeUndefined();
    expect(rig.seen.at(-1)?.jog).toBeUndefined();
  });

  it('stops one direction when the other is started', async () => {
    rig = await (await Rig.create(name, {}, { moveSteps: 3 })).started();
    rig.fan.startJog('left');
    await sleep(15);
    rig.fan.startJog('right');
    expect(rig.fan.snapshot.jog).toBe('right');
    await rig.fan.idle();
    const moves = rig.device.moves.join(' ');
    expect(moves).toMatch(/^(left )+right right right$/);
  });

  it('does nothing when a direction that is not jogging is stopped', async () => {
    rig = await (await Rig.create(name, {}, { moveSteps: 3 })).started();
    rig.fan.startJog('left');
    rig.fan.stopJog('right');
    expect(rig.fan.snapshot.jog).toBe('left');
    await rig.fan.idle();
    expect(rig.device.moves).toHaveLength(3);
  });

  it('turns oscillation off before it moves the head', async () => {
    rig = await Rig.create(name, {}, { moveSteps: 2 });
    rig.atTheFan.swing(true);
    await rig.started();
    rig.fan.startJog('left');
    await rig.fan.idle();
    expect(rig.real.swing).toBe(false);
    expect(rig.device.moves).toHaveLength(2);
    expect(rig.fan.snapshot.state?.oscillation).toBe(false);
  });

  it('ignores a jog while the fan is off', async () => {
    rig = await Rig.create(name);
    rig.atTheFan.power(false);
    await rig.started();
    rig.fan.startJog('left');
    expect(rig.fan.snapshot.jog).toBe('left');
    await rig.fan.idle();
    expect(rig.fan.snapshot.jog).toBeUndefined();
    expect(rig.seen.at(-1)?.jog).toBeUndefined();
    expect(rig.device.moves).toEqual([]);
    expect(rig.log.matching(/warn move ignored: the fan is off/)).toHaveLength(1);
  });

  it('does not refuse on an old reading: the fan was turned on at the fan', async () => {
    rig = await Rig.create(name, {}, { moveSteps: 2 });
    rig.atTheFan.power(false);
    await rig.started();
    rig.atTheFan.power(true);
    rig.fan.startJog('left');
    await rig.fan.idle();
    expect(rig.device.moves).toHaveLength(2);
  });

  it('does not start a jog that was stopped while the state was being read', async () => {
    rig = await Rig.create(name);
    rig.atTheFan.power(false);
    await rig.started();
    rig.atTheFan.power(true);
    rig.device.delayMs = 30;
    rig.fan.startJog('left');
    await sleep(10);
    rig.fan.stopJog('left');
    await rig.fan.idle();
    await sleep(30);
    expect(rig.device.moves).toEqual([]);
  });

  it('does not read the state between two steps', async () => {
    rig = await (await Rig.create(name, { pollMs: 5 }, { moveSteps: 4 })).started();
    rig.fan.startJog('left');
    await rig.fan.idle();
    const seen = traffic();
    const during = seen.slice(seen.indexOf('move'), seen.lastIndexOf('move'));
    expect(during.filter((t) => t === 'move')).toHaveLength(3);
    expect(during).not.toContain('read');
  });

  it('ends the jog when a step gets no reply, and does not send that step again', async () => {
    rig = await (await Rig.create(name)).started();
    rig.fan.startJog('left');
    rig.device.dropReplies = 1;
    await rig.fan.idle();
    expect(rig.device.moves).toEqual(['left']);
    expect(rig.fan.snapshot).toMatchObject({ online: true });
    expect(rig.fan.snapshot.jog).toBeUndefined();
  });

  it('ends the jog when the fan is turned off', async () => {
    rig = await (await Rig.create(name)).started();
    rig.fan.startJog('left');
    await sleep(25);
    rig.fan.setPower(false);
    expect(rig.fan.snapshot.jog).toBeUndefined();
    await rig.fan.idle();
    const sent = rig.device.moves.length;
    await sleep(40);
    expect(rig.device.moves).toHaveLength(sent);
    expect(rig.real.power).toBe(false);
  });

  it('ends the jog when the fan stops answering', async () => {
    rig = await (await Rig.create(name)).started();
    rig.fan.startJog('left');
    await sleep(25);
    rig.device.silent = true;
    await rig.fan.idle();
    expect(rig.fan.snapshot).toMatchObject({ online: false });
    expect(rig.fan.snapshot.jog).toBeUndefined();
  });

  if (name === 'zhimi.fan.za1') {
    it('ends the jog when the fan refuses a step', async () => {
      rig = await (await Rig.create(name)).started();
      rig.fan.startJog('left');
      await sleep(25);
      // The fan answers device_busy to a move while it swings.
      rig.atTheFan.swing(true);
      await rig.fan.idle();
      expect(rig.fan.snapshot.jog).toBeUndefined();
      expect(rig.log.matching(/warn move failed: -6007/)).toHaveLength(1);
    });
  }
});
