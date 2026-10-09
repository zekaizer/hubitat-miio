import { afterEach, describe, expect, it } from 'vitest';

import { MODELS, Rig } from './support/fan-rig';

// Both models are made to refuse oscillation while off; only zhimi.fan.za1 does so by itself.
describe.each(MODELS)('fan off state: %s', (name) => {
  let rig: Rig;

  afterEach(async () => {
    await rig.close();
  });

  it('turns oscillation on and off while the fan is on', async () => {
    rig = await (await Rig.create(name)).started();
    rig.fan.setOscillation(true);
    expect(rig.fan.snapshot.state?.oscillation).toBe(true);
    await rig.fan.idle();
    expect(rig.real.swing).toBe(true);
    rig.fan.setOscillation(false);
    await rig.fan.idle();
    expect(rig.real.swing).toBe(false);
    expect(rig.fan.snapshot.state?.oscillation).toBe(false);
  });

  it('ignores oscillation while the fan is off and shows it is still off', async () => {
    rig = await Rig.create(name);
    rig.atTheFan.power(false);
    await rig.started();
    rig.fan.setOscillation(true);
    expect(rig.fan.snapshot.state?.oscillation).toBe(true);
    await rig.fan.idle();
    expect(rig.fan.snapshot.state).toMatchObject({ power: false, oscillation: false });
    expect(rig.seen.at(-1)?.state?.oscillation).toBe(false);
    expect(rig.real.swing).toBe(false);
    expect(rig.writes).toEqual([]);
    expect(rig.log.matching(/warn oscillation ignored: the fan is off/)).toHaveLength(1);
  });

  it('does not refuse on an old reading: the fan was turned on at the fan', async () => {
    rig = await Rig.create(name);
    rig.atTheFan.power(false);
    await rig.started();
    rig.atTheFan.power(true);
    rig.fan.setOscillation(true);
    await rig.fan.idle();
    expect(rig.real.swing).toBe(true);
    expect(rig.fan.snapshot.state).toMatchObject({ power: true, oscillation: true });
  });

  it('ends up showing the truth when the fan was turned off at the fan', async () => {
    rig = await (await Rig.create(name)).started();
    rig.atTheFan.power(false);
    rig.fan.setOscillation(true);
    await rig.fan.idle();
    expect(rig.fan.snapshot.state).toMatchObject({ power: false, oscillation: rig.real.swing });
  });

  it('says nothing more about a command when the fan does not answer', async () => {
    rig = await Rig.create(name);
    rig.atTheFan.power(false);
    await rig.started();
    rig.device.silent = true;
    rig.fan.setOscillation(true);
    await rig.fan.idle();
    expect(rig.fan.snapshot).toMatchObject({ online: false, state: { oscillation: false } });
    expect(rig.log.matching(/ignored/)).toEqual([]);
  });
});
