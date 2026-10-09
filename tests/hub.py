"""Hubitat hub helpers for the tests.

The hub address comes from the HUBITAT_HUB environment variable, for example
http://192.168.1.9. The helpers use the hub's local web endpoints, which need no login while
hub security is off.

    python tests/hub.py save      upload drivers/mi-fan.groovy to the hub
"""
import json, os, socket, sys, time, urllib.error, urllib.parse, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DRIVER_SRC = os.path.join(ROOT, "drivers", "mi-fan.groovy")
DRIVER_NAME = "Mi Fan"
CHILD_SUFFIXES = ("Oscillation", "Move Left", "Move Right")

def hub():
    url = os.environ.get("HUBITAT_HUB")
    if not url:
        raise SystemExit("set HUBITAT_HUB to the hub address, for example http://192.168.1.9")
    return url.rstrip("/")

def get(path):
    return urllib.request.urlopen(hub() + path, timeout=20).read().decode()

def post(path, obj):
    req = urllib.request.Request(hub() + path, json.dumps(obj).encode(), {"Content-Type": "application/json"})
    try:
        return urllib.request.urlopen(req, timeout=40).read().decode()
    except urllib.error.HTTPError as e:
        return f"HTTP {e.code}: {e.read().decode()[:300]}"

def run(dev, method, *args):
    """Runs a device command. Each argument is a (type, value) pair, see N and S."""
    return post("/device/runmethod", {"id": dev, "method": method, "args": [{"type": t, "value": v} for t, v in args]})

N = lambda v: ("NUMBER", v)
S = lambda v: ("STRING", v)

def driver_id():
    for d in json.loads(get("/hub2/userDeviceTypes")):
        if d.get("name") == DRIVER_NAME:
            return d["id"]
    return None

def save_driver():
    """Uploads the working copy of the driver. Every device that uses it runs the new code."""
    did = driver_id()
    version = json.loads(get(f"/driver/ajax/code?id={did}"))["version"] if did else None
    r = json.loads(post("/driver/saveOrUpdateJson", {"id": did, "version": version, "source": open(DRIVER_SRC).read()}))
    if not r.get("success"):
        raise SystemExit(f"driver upload failed: {r.get('message')}")
    return r["id"]

def installed_source():
    return json.loads(get(f"/driver/ajax/code?id={driver_id()}"))["source"]

def create_device():
    r = json.loads(get(f"/device/createVirtual?deviceTypeId={driver_id()}"))
    return r.get("deviceId") or r.get("id")

def delete_device(dev):
    get(f"/device/forceDelete/{dev}/yes")

def attributes(dev):
    states = json.loads(get(f"/device/fullJson/{dev}"))["device"]["currentStates"]
    return {name: s.get("value") for name, s in states.items()}

def children(dev):
    """Child device ids by role: Oscillation, Move Left, Move Right."""
    out = {}
    for group in (json.loads(get(f"/device/fullJson/{dev}")).get("childDevices") or {}).values():
        for child in group if isinstance(group, list) else [group]:
            if isinstance(child, dict):
                for suffix in CHILD_SUFFIXES:
                    if child.get("name", "").endswith(suffix):
                        out[suffix] = child["id"]
    return out

def logs(dev, since, levels=("WARN", "ERROR", "INFO")):
    """Hub log lines of a device from the time string `since` on, as 'HH:MM:SS.mmm LEVEL text'."""
    out = []
    for line in json.loads(get("/logs/past/json")):
        p = line.split("\t")
        if len(p) >= 3 and p[0] >= since and p[2].startswith(f"dev|{dev}|") and p[1].strip() in levels:
            out.append(f"{p[0][11:23]} {p[1].strip()} {p[2].split('|', 3)[3]}")
    return out

def now():
    return time.strftime("%Y-%m-%d %H:%M:%S")

def local_ip():
    """This machine's address as the hub reaches it."""
    host = urllib.parse.urlparse(hub()).hostname
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.connect((host, 80))
    ip = s.getsockname()[0]
    s.close()
    return ip

if __name__ == "__main__":
    if sys.argv[1:] == ["save"]:
        print("driver id", save_driver())
    else:
        raise SystemExit(__doc__)
