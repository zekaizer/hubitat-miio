# 1. Expose the devices through a Homebridge plugin instead of a Hubitat driver

Date: 2026-10-09

## Status

Accepted

## Context

The goal is to control Xiaomi miio devices from Apple Home over the LAN, without the Xiaomi
cloud. Until 0.1.2 this repository was a Hubitat driver package, and the devices reached Apple
Home through Hubitat's built-in HomeKit Bridge.

The Bridge maps a fixed set of Hubitat capabilities to a fixed set of accessory types, and a
driver cannot extend either:

- A fan is exported with power and speed only. HomeKit's swing mode is not exported, and Hubitat
  has no standard capability for oscillation.
- Each Hubitat device becomes its own accessory. Oscillation and the two head-movement switches
  had to be child devices, so one fan took four tiles in the Home app.
- There is no humidifier accessory type, and no Hubitat capability for a target humidity.
- Custom attributes and commands are not exported at all.

No Hubitat app other than the HomeKit Bridge used the devices.

Alternatives considered:

- **Keep the Hubitat driver and add a Homebridge plugin that reads Hubitat.** Two code bases, and
  one more hop on the path where latency matters most (stopping the head while it moves).
- **A standalone HAP daemon.** Same reach as Homebridge, but pairing storage and configuration
  would have to be built.
- **Home Assistant with its HomeKit Bridge.** A whole platform to run for three devices, and the
  head-movement switches would still be custom work.
- **A Matter bridge.** Apple Home shows only what it maps from Matter to HomeKit: fan oscillation
  as a single toggle, no wind mode. Humidifier support was not confirmed.

## Decision

The repository becomes a Homebridge dynamic platform plugin, `homebridge-miio-local`, written in
TypeScript, that speaks miio to the devices directly.

The Hubitat driver, its Hubitat Package Manager manifest and the hub-driven tests are removed.
`docs/local-api.md` stays the reference for how the devices behave.

## Consequences

- One accessory per device can carry everything HomeKit can express for it: fan speed, swing
  mode, physical-controls lock and the head-movement switches for a fan; target humidity, current
  humidity and water level for a humidifier.
- The protocol and device logic can be unit tested on a development machine. The Groovy driver
  could only be tested on a hub.
- The devices are no longer available to Hubitat rules, dashboards or hub modes. Night values,
  which followed the hub mode, need another trigger.
- None of the Groovy code is reused. The measured device behaviour and the fake device in
  `tests/` carry over.
- Hubitat installs of the package get no further updates. The last driver is 0.1.2, at commit
  `4de32b8`.
