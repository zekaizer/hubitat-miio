"""Fake Xiaomi fan for tests.

Answers miio on UDP 54321 as zhimi.fan.za1 or dmaker.fan.p33, following docs/local-api.md, and
logs every request. A control file, read again on every packet, makes it misbehave:

    silent         ignore every packet, like a fan that is unplugged
    drop_requests  answer the handshake only, like a fan given the wrong token
    drop_replies   number of requests to carry out without answering
    stray_hello    number of requests to answer with a second handshake reply instead
    delay          seconds to wait before each reply
    set            properties to change, as if someone used the remote
    unreadable     miot properties, as [siid, piid], that answer -4003

Usage: fakefan.py <model> <control.json> <log file>
"""
import hashlib, json, socket, struct, sys, time
from Crypto.Cipher import AES
from fakefan_token import TOKEN_HEX

TOKEN = bytes.fromhex(TOKEN_HEX)
DID = bytes.fromhex("0badf00d")
md5 = lambda b: hashlib.md5(b).digest()
KEY = md5(TOKEN)
IV = md5(KEY + TOKEN)
MODEL, CTL_PATH, LOG_PATH = sys.argv[1], sys.argv[2], sys.argv[3]
MIOT = MODEL.startswith("dmaker")
START = time.time()

miot = {(2, 1): True, (2, 2): 1, (2, 3): 0, (2, 4): False, (2, 5): 120, (2, 6): 25, (3, 1): 0,
        (4, 1): True, (5, 1): False, (6, 2): 0, (7, 1): False}
legacy = {"power": "on", "speed_level": 25, "natural_level": 0, "mode": "normal", "speed": 300,
          "angle": 120, "angle_enable": "off", "poweroff_time": 0, "child_lock": "off",
          "buzzer": 0, "led_b": 0, "ac_power": "on", "use_time": 1}
ctl = {"seq": None}
left = {"drop_replies": 0, "stray_hello": 0}

def log(*parts):
    line = time.strftime("%H:%M:%S") + f".{int(time.time() * 1000) % 1000:03d} " + " ".join(str(p) for p in parts)
    with open(LOG_PATH, "a") as f:
        f.write(line + "\n")

def load_ctl():
    try:
        new = json.load(open(CTL_PATH))
    except Exception:
        return
    if new.get("seq") == ctl.get("seq"):
        return
    ctl.clear(); ctl.update(new)
    left["drop_replies"] = new.get("drop_replies", 0)
    left["stray_hello"] = new.get("stray_hello", 0)
    for key, value in (new.get("set") or {}).items():
        if MIOT:
            siid, piid = key.split(".")
            miot[(int(siid), int(piid))] = value
        else:
            legacy[key] = value
    log("ctl", json.dumps(new))

def hello_reply():
    return b"\x21\x31\x00\x20" + b"\x00" * 4 + DID + struct.pack(">I", int(time.time() - START) + 1000) + b"\xff" * 16

def packet(obj):
    body = json.dumps(obj, separators=(",", ":")).encode()
    pad = 16 - len(body) % 16
    enc = AES.new(KEY, AES.MODE_CBC, IV).encrypt(body + bytes([pad]) * pad)
    head = b"\x21\x31" + struct.pack(">H", 32 + len(enc)) + b"\x00" * 4 + DID + struct.pack(">I", int(time.time() - START) + 1000)
    return head + md5(head + TOKEN + enc) + enc

def err(code, message):
    return {"error": {"code": code, "message": message}}

def handle(method, params):
    if method == "miIO.info":
        return {"result": {"model": MODEL, "fw_ver": "9.9.9", "mac": "AA:BB:CC:DD:FA:CE", "token": TOKEN_HEX}}
    if MIOT:
        if method == "get_properties":
            out = []
            for p in params:
                key = (p["siid"], p["piid"])
                item = {"did": p["did"], "siid": p["siid"], "piid": p["piid"]}
                if key in miot and list(key) not in ctl.get("unreadable", []):
                    item.update(code=0, value=miot[key])
                else:
                    item.update(code=-4003)
                out.append(item)
            return {"result": out}
        if method == "set_properties":
            out = []
            for p in params:
                key = (p["siid"], p["piid"])
                code = 0
                if key == (6, 1):
                    pass
                elif key in miot:
                    miot[key] = p["value"]
                else:
                    code = -4003
                out.append({"did": p["did"], "siid": p["siid"], "piid": p["piid"], "code": code})
            return {"result": out}
        return err(-9999, "user ack timeout")
    if method == "get_prop":
        return {"result": [legacy.get(name, "null") for name in params]}
    if method == "set_power":
        if params[0] not in ("on", "off"):
            return err(-5001, "invalid arg")
        legacy["power"] = params[0]
        return {"result": ["ok"]}
    needs_power = {"set_speed_level": "speed_level", "set_natural_level": "natural_level", "set_angle": "angle",
                   "set_angle_enable": "angle_enable", "set_mode": "mode", "set_move": None}
    if method in needs_power:
        if legacy["power"] != "on":
            return err(-6011, "device_poweroff")
        if method == "set_move":
            return err(-6007, "device_busy") if legacy["angle_enable"] == "on" else {"result": ["ok"]}
        legacy[needs_power[method]] = params[0]
        if method == "set_speed_level":
            legacy["mode"], legacy["natural_level"] = "normal", 0
        elif method == "set_natural_level":
            legacy["mode"], legacy["speed_level"] = ("natural" if params[0] else "normal"), params[0] or legacy["speed_level"]
        elif method == "set_angle":
            legacy["angle_enable"] = "on"
        return {"result": ["ok"]}
    if method in ("set_buzzer", "set_led_b", "set_child_lock"):
        legacy[method[4:]] = params[0]
        return {"result": ["ok"]}
    return err(-5000, "method not found")

sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
sock.bind(("0.0.0.0", 54321))
log("start", MODEL)
while True:
    data, addr = sock.recvfrom(4096)
    load_ctl()
    if ctl.get("silent"):
        log("ignored: silent")
        continue
    if len(data) == 32 and data[4:] == b"\xff" * 28:
        sock.sendto(hello_reply(), addr)
        log("hello")
        continue
    head, enc = data[:32], data[32:]
    if md5(head[:16] + TOKEN + enc) != head[16:32]:
        log("ignored: bad checksum")
        continue
    raw = AES.new(KEY, AES.MODE_CBC, IV).decrypt(enc)
    req = json.loads(raw[:-raw[-1]])
    log("req", req["method"], json.dumps(req["params"], separators=(",", ":")))
    if ctl.get("drop_requests"):
        continue
    reply = handle(req["method"], req["params"])
    reply["id"] = req["id"]
    if left["stray_hello"] > 0:
        left["stray_hello"] -= 1
        sock.sendto(hello_reply(), addr)
        log("  -> stray hello, reply lost")
        continue
    if left["drop_replies"] > 0:
        left["drop_replies"] -= 1
        log("  -> reply lost")
        continue
    if ctl.get("delay"):
        time.sleep(ctl["delay"])
    sock.sendto(packet(reply), addr)
    if "error" in reply:
        log("  -> error", reply["error"]["code"])
