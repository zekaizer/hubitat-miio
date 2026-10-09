# homebridge-miio-local

Homebridge plugin that exposes Xiaomi devices to Apple Home over the LAN with the miio protocol.
It does not use the Xiaomi cloud.

Up to 0.1.2 this repository was a Hubitat driver package (`hubitat-miio`).
[ADR 1](docs/adr/0001-homebridge-plugin-instead-of-hubitat-driver.md) records why it moved. The
last Hubitat driver is at commit `4de32b8`.

## Supported devices

| Model | Device | Dialect | Status |
|---|---|---|---|
| `zhimi.fan.za1` | Pedestal fan | legacy miio | supported |
| `dmaker.fan.p33` | Pedestal fan | miot | supported |
| `zhimi.humidifier.ca4` | Evaporative humidifier | miot | supported; **writes not verified on a real device** |

The model is detected from the device. Both fans are exposed in the same way.

For the humidifier only reads were measured on a real device. Its writes follow the published
miot spec and have been run against a fake device only.

## Install

The package is not on npm yet. Build a tarball and install it where Homebridge keeps its
plugins:

```
npm install
npm run build
npm pack
npm install homebridge-miio-local-<version>.tgz
```

## Configure

```json
{
  "platform": "MiioLocal",
  "night": { "start": "22:00", "end": "07:00" },
  "devices": [
    {
      "name": "Bedroom fan",
      "address": "192.168.1.50",
      "token": "<32 hex characters>",
      "moveSwitches": true,
      "buzzer": "off",
      "lightAtNight": "off"
    }
  ]
}
```

| Setting | Meaning |
|---|---|
| `night.start`, `night.end` | When the night values are used, as local time `HH:MM` of the Homebridge host. Without it they never are |
| `name` | The name the accessory is added with |
| `address` | IP address of the device. Give it a fixed address on the router: the accessory is tied to it |
| `token` | The 32 hex character miio token of the device |
| `pollInterval` | Seconds between state reads, 15 by default |
| `moveSwitches` | Fans: adds the *Move Left* and *Move Right* switches, off by default |
| `buzzer`, `light` | `on` or `off`: the plugin keeps the device at that value. `unmanaged`, the default: left alone. `light` is the indicator light of a fan and the screen of the humidifier |
| `buzzerAtNight`, `lightAtNight` | The value during the night. `same`, the default: the day value. With an `unmanaged` day value, the device gets back what it had before the night |

A device that does not answer when Homebridge starts is asked again every 30 seconds and added
once it answers.

## What Apple Home shows

One accessory per fan:

| Control | Notes |
|---|---|
| Power | |
| Speed | 1-100 %. Setting a speed turns the fan on |
| Oscillation | Ignored while the fan is off |
| Child lock | |
| *Move Left*, *Move Right* switches | The head keeps turning, one step every 0.75 s, while the switch is on |

Turning a move switch off stops the head after at most the step that was already sent. A move
switch that is left on turns itself off once the head has had enough steps to cross its whole
range (about 18 to 22 s), and turning one on turns the other off. A move turns oscillation off
first.

A control shows its new value at once. If the fan does not take it, the control goes back to
what the fan has. A fan that stops answering is shown as *No Response*.

Natural wind, the oscillation angle and the timer are not exposed. A fan in natural wind stays
in it when the speed changes.

One accessory for the humidifier:

| Control | Notes |
|---|---|
| Power | |
| Mode | *Auto* is the humidifier's automatic mode. *Humidify* is a manual level |
| Speed | The manual level: up to 33 % low, up to 66 % medium, above that high |
| Target humidity | Kept within 30-80 % |
| Current humidity, water level | The water level scale is python-miio's and was not measured |
| Child lock | |

The temperature, the dry mode and the clean mode are not exposed. A `light` kept `on` sets the
screen to its brightest level; a dim screen counts as on.

## Device behaviour

[docs/local-api.md](docs/local-api.md) records how the devices behave on the wire, as measured
on real ones. The plugin relies on it. For the humidifier only reads were measured.

## Development

```
npm test            # unit and integration tests against a fake device on localhost
npm run typecheck
npm run fmt
```

`test/support/fake-device.ts` answers miio as any of the three models, following the measured
behaviour, and can be told to stop answering, lose a reply or change state as if someone used
the remote. How it takes writes as the humidifier is an assumption taken from the spec.

## License

Apache License 2.0. See [LICENSE](LICENSE).
