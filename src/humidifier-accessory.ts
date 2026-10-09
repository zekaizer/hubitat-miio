import type { CharacteristicValue, HAP, PlatformAccessory, Service } from 'homebridge';

import type { DeviceSnapshot } from './device';
import type { DeviceInfo } from './fan-accessory';
import type { Humidifier } from './humidifier';
import type { HumidifierMode, HumidifierState } from './models';

export interface HumidifierAccessoryOptions {
  name: string;
  info: DeviceInfo;
}

// The manual modes as HomeKit rotation speeds.
const SPEEDS: Array<[HumidifierMode, number]> = [
  ['low', 33],
  ['medium', 66],
  ['high', 100],
];

// The device reports the depth of the water: 120 is a full tank, 127 a tank that is taken off.
// These meanings are python-miio's; they were not measured.
function waterPercent(depth: number): number {
  return depth > 125 ? 0 : Math.min(100, Math.max(0, Math.round(depth / 1.2)));
}

// Shows one humidifier as one HomeKit accessory with a HumidifierDehumidifier service. The
// device's automatic mode is HomeKit's "humidifier or dehumidifier" target state; its three
// manual levels are the "humidifier" state with a rotation speed.
export class HumidifierAccessory {
  private readonly service: Service;

  constructor(
    private readonly hap: HAP,
    accessory: PlatformAccessory,
    private readonly humidifier: Humidifier,
    options: HumidifierAccessoryOptions,
  ) {
    const { Service: S, Characteristic: C } = hap;
    const Target = C.TargetHumidifierDehumidifierState;

    const info = accessory.getService(S.AccessoryInformation) as Service;
    info.setCharacteristic(C.Manufacturer, 'Xiaomi').setCharacteristic(C.Model, options.info.model);
    if (options.info.serial) {
      info.setCharacteristic(C.SerialNumber, options.info.serial);
    }
    if (options.info.firmware) {
      info.setCharacteristic(C.FirmwareRevision, options.info.firmware);
    }

    this.service =
      accessory.getService(S.HumidifierDehumidifier) ??
      accessory.addService(S.HumidifierDehumidifier, options.name);
    this.service.setPrimaryService(true);
    this.service
      .getCharacteristic(C.Active)
      .onGet(() => {
        const { online, state } = this.humidifier.snapshot;
        if (online === false) {
          throw new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
        return state?.power ? C.Active.ACTIVE : C.Active.INACTIVE;
      })
      .onSet((value) => {
        const on = value === C.Active.ACTIVE;
        // HomeKit repeats the power with other settings.
        if (this.humidifier.snapshot.state?.power !== on) {
          this.humidifier.setPower(on);
        }
      });
    this.service
      .getCharacteristic(Target)
      .setProps({ validValues: [Target.HUMIDIFIER_OR_DEHUMIDIFIER, Target.HUMIDIFIER] })
      .onSet((value) => {
        const mode = this.humidifier.snapshot.state?.mode;
        if (value === Target.HUMIDIFIER_OR_DEHUMIDIFIER) {
          this.humidifier.setMode('auto');
        } else if (mode === undefined || mode === 'auto') {
          this.humidifier.setMode('medium');
        }
      });
    this.service
      .getCharacteristic(C.RotationSpeed)
      .setProps({ minValue: 0, maxValue: 100, minStep: 1 })
      .onSet((value) => {
        // 0 comes with turning the device off and says nothing about the mode.
        const speed = value as number;
        if (speed > 0) {
          this.humidifier.setMode(speed <= 33 ? 'low' : speed <= 66 ? 'medium' : 'high');
        }
      });
    this.service
      .getCharacteristic(C.RelativeHumidityHumidifierThreshold)
      .onSet((value) => this.humidifier.setTargetHumidity(value as number));
    this.service
      .getCharacteristic(C.LockPhysicalControls)
      .onSet((value) =>
        this.humidifier.setLock(value === C.LockPhysicalControls.CONTROL_LOCK_ENABLED),
      );
    this.service.getCharacteristic(C.WaterLevel);

    humidifier.onChange((snapshot) => this.show(snapshot));
    this.show(humidifier.snapshot);
  }

  private show({ online, state }: DeviceSnapshot<HumidifierState>): void {
    const { Characteristic: C, HapStatusError, HAPStatus } = this.hap;
    const Target = C.TargetHumidifierDehumidifierState;
    const Current = C.CurrentHumidifierDehumidifierState;
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
    const working = state.humidity < state.targetHumidity ? Current.HUMIDIFYING : Current.IDLE;
    this.service
      .updateCharacteristic(C.Active, state.power ? C.Active.ACTIVE : C.Active.INACTIVE)
      .updateCharacteristic(Current, state.power ? working : Current.INACTIVE)
      .updateCharacteristic(
        Target,
        state.mode === 'auto' ? Target.HUMIDIFIER_OR_DEHUMIDIFIER : Target.HUMIDIFIER,
      )
      .updateCharacteristic(C.CurrentRelativeHumidity, state.humidity)
      .updateCharacteristic(C.RelativeHumidityHumidifierThreshold, state.targetHumidity)
      .updateCharacteristic(C.WaterLevel, waterPercent(state.waterLevel))
      .updateCharacteristic(
        C.LockPhysicalControls,
        state.lock
          ? C.LockPhysicalControls.CONTROL_LOCK_ENABLED
          : C.LockPhysicalControls.CONTROL_LOCK_DISABLED,
      );
    // In the automatic mode the device picks the speed and does not report it.
    const speed = SPEEDS.find(([mode]) => mode === state.mode)?.[1];
    if (speed !== undefined) {
      this.service.updateCharacteristic(C.RotationSpeed, speed);
    }
  }
}
