# Fake fan

`fakefan.py` answers miio on UDP port 54321 as `zhimi.fan.za1` or `dmaker.fan.p33`, following
[docs/local-api.md](../docs/local-api.md). It can be told to stop answering, lose a reply or
change state as if someone used the remote, so the failure paths can be exercised without a real
fan.

## Requirements

Python 3 with `pycryptodome`.

## Run

```
python tests/fakefan.py <model> <control.json> <log file>
```

The token it expects is in `fakefan_token.py`. Every request is appended to the log file.

The control file is read again on every packet:

| Key | Effect |
|---|---|
| `silent` | Ignore every packet, like a fan that is unplugged |
| `drop_requests` | Answer the handshake only, like a fan given the wrong token |
| `drop_replies` | Number of requests to carry out without answering |
| `stray_hello` | Number of requests to answer with a second handshake reply instead |
| `delay` | Seconds to wait before each reply |
| `set` | Properties to change, as if someone used the remote |
| `unreadable` | miot properties, as `[siid, piid]`, that answer `-4003` |
