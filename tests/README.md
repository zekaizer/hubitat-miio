# Tests

The driver only runs inside a Hubitat hub, so the tests drive a real hub. The fan is a fake one:
`fakefan.py` answers miio on this machine as `zhimi.fan.za1` or `dmaker.fan.p33`, following
[docs/local-api.md](../docs/local-api.md), and can be told to stop answering, lose a reply or
change state as if someone used the remote. No real fan is involved.

## Requirements

- A Hubitat hub on the same network, with hub security off, that can reach this machine on UDP
  port 54321.
- Python 3 with `pycryptodome`.

## Run

```
export HUBITAT_HUB=http://<hub address>
python tests/test_commands.py      # every command on both models, about 6 minutes
python tests/test_failures.py      # failure paths, about 6 minutes
```

Both accept names to run a part: `test_commands.py dmaker.fan.p33`,
`test_failures.py unreachable stray_handshake`. The exit code is 1 when a check fails.

**Each run first uploads `drivers/mi-fan.groovy` to the hub**, so every device that uses the
driver runs the working copy from then on. `python tests/hub.py save` does only that.

A run creates a temporary `Mi Fan` device on the hub and deletes it at the end.

## Files

| File | Purpose |
|---|---|
| `fakefan.py` | The fake fan and the ways it can misbehave |
| `harness.py` | Starts the fake fan and a temporary hub device that uses it |
| `hub.py` | Hub helpers: commands, attributes, logs, driver upload |
| `test_commands.py` | Commands, child switches, jog |
| `test_failures.py` | Unreachable fan, lost replies, stale state, night values |
