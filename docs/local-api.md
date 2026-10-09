# Local API of three Xiaomi miio devices

How two Xiaomi fans and a humidifier behave when they are controlled over the LAN with the miio
protocol, without the Xiaomi cloud. It is written for people who write or debug a local
integration.

| Model | Dialect | Firmware measured | Measured |
|---|---|---|---|
| [`zhimi.fan.za1`](#zhimifanza1) | legacy miio | `2.2.8` | reads and writes |
| [`dmaker.fan.p33`](#dmakerfanp33) | miot | `2.1.3` | reads and writes |
| [`zhimi.humidifier.ca4`](#zhimihumidifierca4) | miot | `2.2.8` | reads only |

The fans were measured on 2026-10-08 and the humidifier on 2026-10-09, on one unit of each
model. Other firmware versions may behave differently. Where a measurement contradicts the
published miot spec, this document records the measurement.

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
- Three `set_move` requests sent back to back each answer `["ok"]` in about 200 ms.
- The head went from one end of its range to the other in 22 `set_move` requests, judged by
  eye. The angle of one step was not measured.

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
- `motor-control` written back to back answers code 0 each time, in about 200 ms. Thirty
  writes in one direction all answered code 0, so the end of the range is not reported.
- The head went from one end of its range to the other in 27 writes sent about 0.75 s apart,
  judged by eye. The angle of one step was not measured.
- **A write that comes too soon is answered with code 0 and skipped.** With 28 writes sent
  about 0.55 s apart, the head stopped short of the end.

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

## zhimi.humidifier.ca4

| Field | Value |
|---|---|
| Model | `zhimi.humidifier.ca4` |
| Firmware | `2.2.8`, MCU `0017`, miio `0.0.9` |
| Hardware | `esp32` |
| Spec | `urn:miot-spec-v2:device:humidifier:0000A00E:zhimi-ca4:2` |

**Only reads were measured.** The humidifier was off the whole time, and nothing here says how
it takes a write or an action.

`miIO.info` answers and, as on the fans, contains the token in clear.

### Properties

Reading the properties of the spec, and a scan of siid 1-8 x piid 1-12, found 19 readable
properties. The access column is the spec's; no write was tried.

| siid/piid | Name | Type | Value read | Spec access | Notes |
|---|---|---|---|---|---|
| 2/1 | on | bool | `false` | rw | |
| 2/2 | fault | uint8 | `0` | r | |
| 2/5 | fan-level | uint8 | `0` | rw | spec: 0 auto, 1-3 levels |
| 2/6 | target-humidity | uint8 | `70` | rw | spec: 30-80 % |
| 2/7 | water-level | uint8 | `0` | r | spec: 0-128. Read with the humidifier off; the scale was not measured |
| 2/8 | dry | bool | `true` | rw | |
| 2/9 | use-time | int32 | `30895473` | r | unit not measured |
| 2/10 | button-pressed | uint8 | `2` | r | spec: 0 none, 1 led, 2 power |
| 2/11 | speed-level | int32 | `704` | rw | spec: 200-2000 |
| 3/7 | temperature | float | `29.1`, later `29` | r | Celsius |
| 3/8 | fahrenheit | float | `84.3` | r | |
| 3/9 | relative-humidity | uint8 | `47` | r | |
| 4/1 | alarm (buzzer) | bool | `false` | rw | |
| 5/2 | brightness | uint8 | `2` | rw | spec: 0 dark, 1 glimmer, 2 brightest |
| 6/1 | physical-controls-locked | bool | `false` | rw | |
| 7/1 | actual-speed | uint32 | `0` | r | |
| 7/3 | power-time | uint32 | `30225623` | r | spec: seconds |
| 7/4 | country-code | uint32 | `86` | rw | |
| 7/5 | clean | bool | `false` | rw | |

The device-information service (siid 1) is not readable: every property of it answers `-4004`.

### A property the device does not have

**A property the device does not have answers `-4004`, and properties that come after it in the
same request can answer `-4004` as well**, although each of them reads fine by itself.

| `get_properties` request | Result |
|---|---|
| `2/1` | value |
| `2/1`, `9/9` | `2/1` value; `9/9` `-4004` |
| `9/9`, `2/1` | both `-4004` |
| `2/1`, `9/9`, `3/9` | `2/1` value; `9/9` and `3/9` `-4004` |
| `3/9`, `9/9` | `3/9` value; `9/9` `-4004` |
| `1/1`, `2/1` | both `-4004` |
| `2/3`, `2/1` | `2/3` `-4001`; `2/1` value |
| `2/1`, `2/3`, `2/5` | `2/3` `-4001`; the other two values |
| `1/11`, `1/12`, `2/1`, `2/2`, `2/3`, `2/4`, `2/5`, `2/6`, `2/7`, `2/8` | the first six `-4004`; `2/5` to `2/8` values |
| the same ten, with `1/11`, `1/12`, `2/3`, `2/4` last | six values; the last four `-4004` |

- Each request was sent twice, with the same result both times.
- Not every later property is lost. After a missing one, `2/1`, `2/2`, `3/9`, `7/1` and `7/3`
  answered `-4004`, while `2/5` to `2/8`, `4/1`, `5/2`, `7/4` and `7/5` were still given. What
  decides it was not worked out.
- `2/3` and `2/4`, which the spec does not list, answer `-4001` instead and leave the rest of
  the request alone. After a `-4004` in the same request they answer `-4004` too.
- A request made only of properties the device has was answered in full every time: the same
  11 properties nine times.

An integration should therefore ask only for properties the device has.

### Replies and errors

| Request | Result |
|---|---|
| Unknown method | `-5001 command error`, answered in 66 ms |
| Legacy `get_prop` | `-5001 command error`, answered in 138 ms |
| `get_properties` with an empty list | `-9999 user ack timeout` after 4 s |

### Request size

| `get_properties` request | Result |
|---|---|
| 1, 11, 15 items (up to 485 bytes of params) | all results |
| 25, 32, 40 items | `-9999` after 4 s |

The limit lies between 15 and 25 items; whether it counts items or bytes was not separated.

### Latency

| Request | Round trip |
|---|---|
| `get_properties`, 1 property | 104-143 ms |
| `get_properties`, 11 properties | 97-128 ms |
| `get_properties`, 15 properties | 102-133 ms |

## Differences that matter to an integration

The table compares the two fans. `zhimi.humidifier.ca4`, measured for reads only, differs from
both: an unknown method answers `-5001` at once, a missing property answers `-4004` and can
take other properties of the request with it, and a read takes 15 items.


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
