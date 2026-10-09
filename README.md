# Mi Fan for Hubitat

A Hubitat driver that controls Xiaomi fans over the LAN with the miio protocol. It does not use
the Xiaomi cloud.

## Supported models

| Model | Dialect |
|---|---|
| `zhimi.fan.za1` | legacy miio |
| `dmaker.fan.p33` | miot |

The model is detected automatically. Both models are exposed in the same way.

## Install

With Hubitat Package Manager: *Install* > *From a URL*, then enter

```
https://raw.githubusercontent.com/zekaizer/hubitat-mifan/main/packageManifest.json
```

Manually: paste `drivers/mi-fan.groovy` into *Drivers Code*, then add a virtual device that uses
the `Mi Fan` driver.

Once the fan answers, a device still named `Mi Fan` is renamed `Mi Fan XXXX`, where `XXXX` is the
last four digits of the fan's MAC address. A device that was given another name keeps it.

## Configure

Set these in the device preferences:

| Preference | Meaning |
|---|---|
| Fan IP address | Give the fan a fixed address on the router |
| Device token | The 32 hex character miio token of the fan |
| Poll interval | Seconds between state reads, 30 by default |
| Buzzer, Indicator light, Child lock | `on` or `off`: the driver keeps the fan at that value. `unmanaged`: left alone |
| Hub modes treated as night | Comma-separated hub mode names, `Night` by default |
| Buzzer, light, lock at night | Value used while the hub is in a night mode. `same`: the day value |
| Create left and right move switches | Adds the `Move Left` and `Move Right` child switches, off by default |

## What the device exposes

| Capability or attribute | Notes |
|---|---|
| `Switch` | |
| `SwitchLevel` | Fan speed, 1-100 %. Setting a level turns the fan on |
| `FanControl` | `low`, `medium-low`, `medium`, `high` are 25, 50, 75 and 100 % |
| `oscillation`, `setOscillation` | Also available as a child switch, for HomeKit |
| `oscillationAngle`, `setOscillationAngle` | Setting an angle turns oscillation on |
| `windMode`, `setWindMode` | `normal` or `natural` |
| `move` | Turns the head one step `left` or `right`. Oscillation is turned off first |
| `Move Left`, `Move Right` child switches | The head keeps turning, about one step every 0.75 s, while the switch is on |
| `nightMode` | Whether the night values are in effect |
| `connection` | `online`, `offline`, `unconfigured` or `unsupported model` |

Oscillation, angle, wind mode and move commands are ignored while the fan is off.

Turning a move switch off stops the head after at most the step that was already sent. A move
switch that is left on turns itself off once the head has had enough steps to cross its whole
range (about 18 to 22 s), and turning one on turns the other off.

## HomeKit

Add the fan device to Hubitat's HomeKit Bridge as a *Fan* for power and speed, and its
`Oscillation` child device as a *Switch*. To aim the fan from HomeKit, enable the move switches
and add them as *Switch* too.

## Device behaviour

[docs/local-api.md](docs/local-api.md) records how both models behave on the wire, as measured
on real devices.

## License

Apache License 2.0. See [LICENSE](LICENSE).
