# homebridge-miio-local

Homebridge plugin that exposes Xiaomi devices to Apple Home over the LAN with the miio protocol.
It does not use the Xiaomi cloud.

> **Not usable yet.** The plugin is being written. Up to 0.1.2 this repository was a Hubitat
> driver package (`hubitat-miio`); [ADR 1](docs/adr/0001-homebridge-plugin-instead-of-hubitat-driver.md)
> records why it moved. The last Hubitat driver is at commit `4de32b8`.

## Target devices

| Model | Device | Dialect |
|---|---|---|
| `zhimi.fan.za1` | Pedestal fan | legacy miio |
| `dmaker.fan.p33` | Pedestal fan | miot |
| `zhimi.humidifier.ca4` | Evaporative humidifier | miot |

## Device behaviour

[docs/local-api.md](docs/local-api.md) records how the two fans behave on the wire, as measured
on real devices. The humidifier is not documented yet.

## Fake device

`tests/fakefan.py` answers miio as either fan and can be told to misbehave. See
[tests/README.md](tests/README.md).

## License

Apache License 2.0. See [LICENSE](LICENSE).
