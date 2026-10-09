import type { CharacteristicValue, HAP, PlatformAccessory, Service } from 'homebridge';

import type { Fan, FanSnapshot } from './fan';
import type { Direction } from './models';

export interface DeviceInfo {
  model: string;
  firmware?: string;
  serial?: string;
}

export interface FanAccessoryOptions {
  name: string;
  /** Adds the Move Left and Move Right switches. */
  moveSwitches: boolean;
  info: DeviceInfo;
}

const MOVES: Array<[Direction, string]> = [
  ['left', 'Move Left'],
  ['right', 'Move Right'],
];

// Shows one fan as one HomeKit accessory: a Fanv2 service and, when asked for, two switches that
// turn the head while they are on.
export class FanAccessory {
  private readonly service: Service;
  private readonly switches = new Map<Direction, Service>();

  constructor(
    private readonly hap: HAP,
    accessory: PlatformAccessory,
    private readonly fan: Fan,
    options: FanAccessoryOptions,
  ) {
    const { Service: S, Characteristic: C } = hap;

    const info = accessory.getService(S.AccessoryInformation) as Service;
    info.setCharacteristic(C.Manufacturer, 'Xiaomi').setCharacteristic(C.Model, options.info.model);
    if (options.info.serial) {
      info.setCharacteristic(C.SerialNumber, options.info.serial);
    }
    if (options.info.firmware) {
      info.setCharacteristic(C.FirmwareRevision, options.info.firmware);
    }

    this.service = accessory.getService(S.Fanv2) ?? accessory.addService(S.Fanv2, options.name);
    this.service.setPrimaryService(true);
    this.service
      .getCharacteristic(C.Active)
      .onGet(() => {
        const { online, state } = this.fan.snapshot;
        if (online === false) {
          throw new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
        return state?.power ? C.Active.ACTIVE : C.Active.INACTIVE;
      })
      .onSet((value) => {
        const on = value === C.Active.ACTIVE;
        // HomeKit sends the power along with a speed. The speed has turned the fan on already.
        if (this.fan.snapshot.state?.power !== on) {
          this.fan.setPower(on);
        }
      });
    this.service
      .getCharacteristic(C.RotationSpeed)
      .setProps({ minValue: 0, maxValue: 100, minStep: 1 })
      .onSet((value) => this.fan.setLevel(value as number));
    this.service
      .getCharacteristic(C.SwingMode)
      .onSet((value) => this.fan.setOscillation(value === C.SwingMode.SWING_ENABLED));
    this.service
      .getCharacteristic(C.LockPhysicalControls)
      .onSet((value) => this.fan.setLock(value === C.LockPhysicalControls.CONTROL_LOCK_ENABLED));

    for (const [direction, name] of MOVES) {
      const subtype = `move-${direction}`;
      const existing = accessory.getServiceById(S.Switch, subtype);
      if (!options.moveSwitches) {
        if (existing) {
          accessory.removeService(existing);
        }
        continue;
      }
      const service = existing ?? accessory.addService(S.Switch, name, subtype);
      // The Home app shows the services of one accessory by this name, not by Name.
      service.addOptionalCharacteristic(C.ConfiguredName);
      service.setCharacteristic(C.ConfiguredName, name);
      service.updateCharacteristic(C.On, false);
      service.getCharacteristic(C.On).onSet((value) => {
        if (value) {
          this.fan.startJog(direction);
        } else {
          this.fan.stopJog(direction);
        }
      });
      this.switches.set(direction, service);
    }

    fan.onChange((snapshot) => this.show(snapshot));
    this.show(fan.snapshot);
  }

  private show({ online, state, jog }: FanSnapshot): void {
    const { Characteristic: C, HapStatusError, HAPStatus } = this.hap;
    for (const [direction, service] of this.switches) {
      service.updateCharacteristic(C.On, jog === direction);
    }
    if (online === false) {
      this.service.updateCharacteristic(
        C.Active,
        new HapStatusError(
          HAPStatus.SERVICE_COMMUNICATION_FAILURE,
        ) as unknown as CharacteristicValue,
      );
      return;
    }
    if (!state) {
      return;
    }
    this.service
      .updateCharacteristic(C.Active, state.power ? C.Active.ACTIVE : C.Active.INACTIVE)
      .updateCharacteristic(
        C.CurrentFanState,
        state.power ? C.CurrentFanState.BLOWING_AIR : C.CurrentFanState.INACTIVE,
      )
      .updateCharacteristic(C.RotationSpeed, state.level)
      .updateCharacteristic(
        C.SwingMode,
        state.oscillation ? C.SwingMode.SWING_ENABLED : C.SwingMode.SWING_DISABLED,
      )
      .updateCharacteristic(
        C.LockPhysicalControls,
        state.lock
          ? C.LockPhysicalControls.CONTROL_LOCK_ENABLED
          : C.LockPhysicalControls.CONTROL_LOCK_DISABLED,
      );
  }
}
