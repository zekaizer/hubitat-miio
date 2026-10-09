# Local API of two Xiaomi fans

How two Xiaomi fans behave when they are controlled over the LAN with the miio protocol,
without the Xiaomi cloud. It is written for people who write or debug a local integration.

| Model | Dialect | Firmware measured |
|---|---|---|
| [`zhimi.fan.za1`](#zhimifanza1) | legacy miio | `2.2.8` |
| [`dmaker.fan.p33`](#dmakerfanp33) | miot | `2.1.3` |

Everything here was measured on 2026-10-08, on one unit of each model. Other firmware versions
may behave differently. Where a measurement contradicts the published miot spec, this document
records the measurement.

## Method

A standalone miio client on the same LAN sent the requests directly to UDP port 54321, so the
timings include the network and the device and nothing else. Each write was followed by a read
of all readable properties. Each fan was returned to the state it started in.

Nobody was watching the fan. A write is recorded as working when the reply reports success and
the value reads back; the physical effect of `motor-control`, the indicator light, the buzzer
and natural wind was not observed.

## Requests

Both models use the same packet format and encryption, described in the
[mihome binary protocol notes](https://github.com/OpenMiHome/mihome-binary-protocol/blob/master/doc/PROTOCOL.md).
They differ in the JSON payload.

Legacy miio, used by `zhimi.fan.za1`:

```json
{"id": 1, "method": "get_prop", "params": ["power", "speed_level"]}
{"id": 1, "result": ["on", 40]}

{"id": 2, "method": "set_speed_level", "params": [60]}
{"id": 2, "result": ["ok"]}
```

miot, used by `dmaker.fan.p33`. A property is addressed by service id (`siid`) and property id
(`piid`), written here as `siid/piid`:

```json
{"id": 1, "method": "get_properties", "params": [{"did": "x", "siid": 2, "piid": 1}]}
{"id": 1, "result": [{"did": "x", "siid": 2, "piid": 1, "code": 0, "value": true}]}

{"id": 2, "method": "set_properties", "params": [{"did": "x", "siid": 2, "piid": 6, "value": 60}]}
{"id": 2, "result": [{"did": "x", "siid": 2, "piid": 6, "code": 0}]}
```

`did` is echoed back. A failed request has an `error` object with a
`code` and a `message` in place of `result`.

## zhimi.fan.za1

| Field | Value |
|---|---|
| Model | `zhimi.fan.za1` |
| Firmware | `2.2.8`, MCU `0088`, miio `0.0.9` |
| Hardware | `esp32` |

`miIO.info` answers in about 85 ms. **Its result contains the device token in clear**, so an
integration must not log that reply.

### Properties

Method `get_prop`, params a list of names; the result is a list of values in the same order.

| Name | Values | Setter | Notes |
|---|---|---|---|
| `power` | `"on"`, `"off"` | `set_power` | |
| `speed_level` | 1-100 | `set_speed_level` | |
| `natural_level` | 0-100 | `set_natural_level` | 0 means natural wind is off |
| `mode` | `"normal"`, `"natural"` | `set_mode` | |
| `speed` | motor speed | none | read only |
| `angle` | 0-120 | `set_angle` | |
| `angle_enable` | `"on"`, `"off"` | `set_angle_enable` | swing |
| `poweroff_time` | seconds | `set_poweroff_time` | counts down |
| `child_lock` | `"on"`, `"off"` | `set_child_lock` | |
| `buzzer` | 0, 1, 2 | `set_buzzer` | number, not a string |
| `led_b` | 0, 1, 2 | `set_led_b` | number |
| `ac_power` | `"on"` | none | read only |
| `use_time` | counter | none | read only; unit not measured |

- **An unknown property is not an error.** It reads as the string `"null"`, not JSON `null`.
  `led`, `natural_enable`, `temp_dec`, `humidity`, `battery`, `bat_charge`, `bat_state` and
  `button_pressed` (names other zhimi fans use) all read `"null"` on this model.
- What the three `buzzer` and `led_b` values do was not observed.

### Writes

Every setter takes a one-element list. An accepted write answers `["ok"]`; a read sent
immediately afterwards already returns the new value.

**Power**

- `set_power` takes only the lowercase strings `"on"` and `"off"`. `true`, `1`, `"ON"` and any
  other string answer `-5001 invalid arg`.

**Speed and natural wind**

- `set_speed_level` takes an integer 1-100. `0`, `101`, `-1`, `"50"` and `33.5` answer `-5001`
  and change nothing.
- `speed_level` and `natural_level` are one value with a mode flag:

| Write | `speed_level` | `natural_level` | `mode` |
|---|---|---|---|
| `set_natural_level [30]` | 30 | 30 | `natural` |
| `set_natural_level [0]` | 30 | 0 | `normal` |
| `set_speed_level [40]` | 40 | 0 | `normal` |
| `set_mode ["natural"]` at level 58 | 58 | 58 | `natural` |
| `set_mode ["normal"]` | 58 | 0 | `normal` |

- `set_mode` takes `"natural"` and `"normal"`; `"nature"` and `1` answer `-5001`.
- `speed` is the measured motor speed, not a setpoint. It ramps for several seconds after a
  change (about 930 at level 100) and can read a stale non-zero value for up to 3 s after the
  fan is turned off.

**Swing**

- `set_angle_enable` coerces instead of rejecting: `"on"` turns swing on, and **every other
  value** (`true`, `1`, `"ON"`, `"bogus"`) answers `["ok"]` and turns it **off**.
- `set_angle` accepts 30, 60, 90, 120 and also 45 and 0; 140 answers `-5001`.
- **`set_angle` turns swing on** when it was off.
- `set_move` takes `"left"` and `"right"`. While swing is on it answers `-6007 device_busy`.

**Timer**

- `set_poweroff_time` is in seconds: after writing 300 it read 299, and 289 ten seconds later.
- 28801 answers `-5001`. Turning the fan off resets the timer to 0.

**Other**

- `set_buzzer` and `set_led_b` take 0, 1 and 2; 3 and `"on"` answer `-5001`.
- `child_lock` does not block LAN writes: with the lock on, `set_speed_level` was applied.

### Writes while the fan is off

| Write | Result |
|---|---|
| `set_speed_level`, `set_natural_level`, `set_angle`, `set_angle_enable`, `set_poweroff_time` | `-6011 device_poweroff`, immediately |
| `set_child_lock`, `set_buzzer`, `set_led_b` | applied |

No speed write turns the fan on, so `set_power` has to be sent first.

### Replies and errors

| Request | Result |
|---|---|
| Unknown method | `-5000 method not found`, answered in 120 ms |
| `get_prop` with an empty list | `-5000 method not found` |
| miot `get_properties` | `-9999 user ack timeout` after 4 s |

An unknown method fails immediately. Only the miot methods cost 4 seconds.

| Code | Meaning observed |
|---|---|
| `-5000` `method not found` | unknown method, or a request too large |
| `-5001` `invalid arg` | value rejected, nothing changed |
| `-6007` `device_busy` | `set_move` while swinging |
| `-6011` `device_poweroff` | write that needs the fan on |
| `-9999` `user ack timeout` | miot method or oversized request, after 4 s |

### Request size

| `get_prop` request | Result |
|---|---|
| 13, 26, 39 names (up to 433 bytes of params) | all values returned |
| 52 names (577 bytes), 78 names (865 bytes) | `-5000 method not found` |
| 104 names (1153 bytes) | `-9999` after 4 s |

The limit lies between 39 and 52 names; whether it counts names or bytes was not separated.

### Packet level

| Probe | Result |
|---|---|
| Hello reply | 32 bytes: magic, length, device id, stamp; checksum field all `ff` |
| Stamp behind by 0, 5, 30 s | answered |
| Stamp behind by 60 s or more | no reply |
| Stamp ahead by 30, 60 s | answered |
| Stamp ahead by 600 s or more, or stamp 0 | no reply |
| Repeated, lower and restarted message ids | answered |
| Message id 0 | no reply |
| Zero checksum, wrong device id | no reply |

The boundary for a stale stamp lies between 30 and 60 s. A packet the device does not accept
is dropped silently, so a wrong token and an unreachable device look the same to the sender.

### Latency

| Request | Round trip |
|---|---|
| Hello | 6-70 ms |
| `get_prop`, 1 property | 150-240 ms |
| `get_prop`, 13 properties | 130-350 ms, typically 200 ms |
| `set_*` | 110-610 ms, typically 200-300 ms |

## dmaker.fan.p33

| Field | Value |
|---|---|
| Model | `dmaker.fan.p33` |
| Firmware | `2.1.3`, MCU `0002`, miio `0.0.9` |
| Hardware | `esp8266` |
| Spec | `urn:miot-spec-v2:device:fan:0000A005:dmaker-p33:1` |

`miIO.info` answers in about 130 ms and, as on `zhimi.fan.za1`, contains the token in clear.

### Properties

A scan of siid 1-10 x piid 1-20 found 11 readable properties. Everything else answers
`-4003`, including the whole device-information service (siid 1).

| siid/piid | Name | Type | Values | Spec access | Measured |
|---|---|---|---|---|---|
| 2/1 | on | bool | | rw | rw |
| 2/2 | fan-level | uint8 | 1-4 | rw | rw, only while on |
| 2/3 | mode | uint8 | 0 straight, 1 natural | rw | rw |
| 2/4 | horizontal-swing | bool | | rw | rw |
| 2/5 | horizontal-angle | uint16 | 30, 60, 90, 120, 140 | rw | rw, value not validated |
| 2/6 | status | uint8 | 1-100 | **r** | **rw: it is the fan speed in percent** |
| 3/1 | off-delay-time | uint16 | 0-480, minutes | rw | rw |
| 4/1 | indicator-light on | bool | | rw | rw |
| 5/1 | alarm (buzzer) | bool | | rw | rw |
| 6/1 | motor-control | uint8 | 0 none, 1 left, 2 right | w | w (read gives `-4003`) |
| 6/2 | fault | uint8 | 0 no fault | r | r, always 0 |
| 7/1 | physical-controls-locked | bool | | rw | rw |

### Speed: 2/2 and 2/6 are one value

Writing either property updates the other.

| fan-level written | status read back |
|---|---|
| 1 | 1 |
| 2 | 35 |
| 3 | 70 |
| 4 | 100 |

| status written | fan-level read back |
|---|---|
| 1-34 | 1 |
| 35-69 | 2 |
| 70-99 | 3 |
| 100 | 4 |

- `status` is a setpoint: in natural mode it stays constant while the wind varies.
- `status` can be written while the fan is off. The value is stored and the fan stays off.

### Writes while the fan is off

| Write | Result |
|---|---|
| `fan-level` alone | `-9999 user ack timeout` after 4 s, value unchanged |
| `[on=true, fan-level=3]` in one request | both applied |
| `[fan-level=1, on=true]` in one request | both answer code 0, **the level is not applied** |
| `status`, `mode`, swing, angle, timer, light, alarm, lock | applied |

### Value handling

- **`on` coerces instead of rejecting.** `true` and `1` turn the fan on. `0` and every string
  (`"on"`, `"true"`, `"off"`, `"false"`) answer code 0 and turn it **off**. `2` answers `-4005`.
- `fan-level` rejects `0`, `5` and `"2"` with `-4005`; `mode` rejects `2`; the timer rejects
  `481`; `status` rejects `0` and `101`.
- **A rejected value can still show up in later reads.** After `status=101` was rejected, 2/6
  read `101` while 2/2 stayed `4`. After the rejected `fan-level` writes, 2/2 read `0`. The
  next valid speed write cleared both.
- `horizontal-angle` accepts `45` with code 0 and reads it back, although the spec lists five
  values.
- Writing `horizontal-angle` does not turn swing on.

### Timer

- The unit is minutes. With `2` written, the value read `1` at 62 s; at 123 s the fan was off
  and the value was `0`.
- Turning the fan off through 2/1 resets the timer to 0.
- A timer written while the fan is off is kept when the fan is turned on.

### Child lock

`physical-controls-locked` does not block LAN writes: with the lock on, `fan-level` and `on`
writes were applied.

### Actions

Method `action`, params `{did, siid, aiid, in: []}`.

| siid/aiid | Name | While on | While off |
|---|---|---|---|
| 2/1 | toggle | turns off | turns on |
| 3/1 | toggle-mode | flips `mode` 0/1 | `-9999` after 4 s |
| 3/2 | loop-gear | next `fan-level` (1 -> 2 observed) | `-9999` after 4 s |

### Replies and errors

- `get_properties` and `set_properties` return one result per item with its own `code`. A
  read mixing readable and unreadable properties returns the readable ones. A write mixing
  accepted and rejected items was not measured.
- A `set_properties` reply carries only codes. A read sent immediately afterwards already
  returns the new value.

| Code | Where | Meaning observed |
|---|---|---|
| `0` | item | accepted |
| `-4003` | item, read | property missing or not readable; answered immediately |
| `-4005` | item, write | value rejected |
| `-9999` `user ack timeout` | whole request, after 4 s | the device could not service it |

`-9999` is returned for an unknown method, the legacy `get_prop`, `get_properties` with an
empty list, a write to a missing service, a missing action, and the off-state cases above.
Whether the device services other requests during those 4 seconds was not measured.

### Request size

| `get_properties` request | Result |
|---|---|
| 20 items, 611 bytes of params | 20 results |
| 21 items, 642 bytes | `-9999` after 4 s |
| 20 items, 1011 bytes | `-9999` after 4 s |
| 10 or 20 items, about 1800 bytes | no reply at all |

Both the item count (20) and the request size limit a batch. The exact byte limit lies
between 611 and 1011 and was not narrowed further.

### Packet level

| Probe | Result |
|---|---|
| Hello reply | same layout as `zhimi.fan.za1` |
| Stamp off by 0, 5, 30, 60 s (either direction) | answered |
| Stamp off by 120 s or more, or stamp 0 | no reply |
| Same message id sent three times | answered every time |
| Lower message id than the previous one, id 1 | answered |
| Message id 0 | no reply |
| Zero checksum | no reply |
| Wrong device id, device id `ffffffff` | no reply |

The stamp tolerance boundary lies between 60 and 120 s, wider than on `zhimi.fan.za1`. Rejected packets
are dropped silently here too.

### Latency

| Request | Round trip |
|---|---|
| Hello | 14-30 ms, occasionally up to 160 ms |
| `get_properties`, 1 property | 140-260 ms |
| `get_properties`, 11 properties | 250-520 ms |
| `set_properties`, 1 property | 120-510 ms, typically 200-300 ms |
| `action` | 200-410 ms |

The `exe_time` field of the replies was 150-280 ms, so most of the round trip is spent in the
device.

## Differences that matter to an integration

| | `zhimi.fan.za1` | `dmaker.fan.p33` |
|---|---|---|
| Dialect | legacy `get_prop` / `set_*` | miot `get_properties` / `set_properties` |
| The other dialect | `-9999` after 4 s | `-9999` after 4 s |
| Unknown method | `-5000` immediately | `-9999` after 4 s |
| Unknown property on read | value `"null"` | item code `-4003` |
| Read batch limit | 39 names work, 52 fail | 20 items and about 600 bytes |
| Power value | string `"on"` / `"off"` only | JSON `true` / `false`; strings turn it off |
| Speed | `set_speed_level` 1-100 | 2/6 `status` 1-100 |
| Speed write while off | `-6011` immediately | 2/6 stored; 2/2 alone `-9999` after 4 s |
| Rejected value | nothing changes | can appear in later reads |
| Swing value other than on | accepted, turns swing off | `false` only; not probed further |
| Writing the angle | turns swing on | leaves swing as it was |
| Timer unit | seconds | minutes |
| Timer after power off | reset to 0 | reset to 0 |
| Child lock | does not block LAN writes | does not block LAN writes |
| Stale stamp accepted | 30 s yes, 60 s no | 60 s yes, 120 s no |
| Message id reuse | accepted | accepted |
| Bad token or checksum | silence | silence |
| `miIO.info` | works, exposes the token | works, exposes the token |

`miIO.info` works on both and returns the model, so it can select the dialect without the
4-second penalty of probing with the wrong one.
