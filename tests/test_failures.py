"""Failure paths of the driver, tested against the fake fan.

    HUBITAT_HUB=http://<hub> python tests/test_failures.py [scenario ...]

Uploads the working copy of the driver first. Takes about six minutes for all scenarios.
"""
import json, sys, time
import hub
from hub import N, S
from harness import Rig, check, finish

def model_race():
    """The oscillation child refreshes while the model is still being read."""
    rig = Rig("dmaker.fan.p33", ctl={"delay": 2.5})
    time.sleep(13)
    rig.fan.ctl()
    check("the device comes online", rig.online(), str(rig.attrs()))
    legacy = rig.fan.requests(method="get_prop")
    check("no legacy request is sent to a miot fan before the model is known", not legacy, f"{len(legacy)} get_prop")
    return rig

def lost_write(rig):
    """A write that gets no reply must not leave the claimed state behind."""
    rig.online()
    before = rig.attrs()
    rig.fan.ctl(silent=True)
    rig.cmd("setLevel", N(80)); time.sleep(1.5)
    during = rig.attrs()
    time.sleep(24)
    after = rig.attrs()
    check("the new level is reported at once", during["level"] == "80", str(during))
    check("the device goes offline", after["connection"] == "offline", str(after))
    check("the level falls back to the last confirmed value", after["level"] == before["level"], f"before {before['level']}, after {after['level']}")
    rig.fan.ctl(); rig.online()

def unreachable(rig):
    """An unreachable fan is reported once, not on every poll."""
    rig.online()
    since = hub.now(); time.sleep(1.1)
    rig.fan.ctl(silent=True); time.sleep(75)
    warnings = [l for l in hub.logs(rig.dev, since) if " WARN " in l]
    check("the device is offline", rig.attrs()["connection"] == "offline")
    check("one warning in 75 s without replies", len(warnings) == 1, f"{len(warnings)} warnings")
    rig.fan.ctl()
    check("the device comes back online", rig.online())
    since = hub.now(); time.sleep(1.1)
    rig.fan.ctl(drop_requests=True); time.sleep(32)
    warnings = [l for l in hub.logs(rig.dev, since) if " WARN " in l]
    check("handshake answered, requests ignored: the warning names the token", any("token" in l for l in warnings), "; ".join(w[17:] for w in warnings)[:170])
    rig.fan.ctl(); rig.online()

def stray_handshake(rig):
    """A second handshake reply while a request is in flight must not stop the driver for good."""
    rig.online(); time.sleep(2)
    mark = rig.fan.mark()
    rig.fan.ctl(stray_hello=1); time.sleep(45)
    lines = rig.fan.log(mark)
    at = [i for i, l in enumerate(lines) if "stray hello" in l]
    later = [l for l in lines[at[0] + 1:] if " req " in l] if at else []
    check("the stray handshake was sent", bool(at))
    check("requests continue afterwards", len(later) >= 2, f"{len(later)} requests after it")
    check("the device is online", rig.attrs()["connection"] == "online", str(rig.attrs()))

def stale_power_miot(rig):
    """The power state the hub holds can be up to one poll interval old."""
    rig.online()
    rig.cmd("on"); time.sleep(4)
    mark = rig.fan.mark(); rig.fan.ctl(set={"2.1": False})
    rig.cmd("setLevel", N(60)); time.sleep(5)
    writes = rig.fan.requests(mark, "set_properties")
    check("setLevel sends the power with the level", any('"piid":1,"value":true' in w for w in writes), "; ".join(w[:90] for w in writes))
    a = rig.attrs()
    check("the fan is on at 60", a["switch"] == "on" and a["level"] == "60", str(a))
    rig.cmd("off"); time.sleep(5)
    mark = rig.fan.mark(); rig.fan.ctl(set={"2.1": True})
    rig.cmd("setOscillation", S("on")); time.sleep(6)
    writes = rig.fan.requests(mark, "set_properties")
    check("oscillation is accepted when the fan was turned on elsewhere", any('"piid":4,"value":true' in w for w in writes) and rig.attrs()["oscillation"] == "on", str(rig.attrs()))
    rig.cmd("setOscillation", S("off")); time.sleep(3)
    rig.cmd("off"); time.sleep(5)
    mark = rig.fan.mark(); since = hub.now(); time.sleep(1.1)
    rig.cmd("setOscillation", S("on")); time.sleep(6)
    writes = rig.fan.requests(mark, "set_properties")
    check("oscillation is still refused while the fan is off", not writes and any("fan is off" in l for l in hub.logs(rig.dev, since)), f"{len(writes)} writes")
    # A move switch turned off again while the driver is still reading the state.
    rig.configure(moveSwitches=True); time.sleep(10)
    left = hub.children(rig.dev)["Move Left"]
    rig.cmd("off"); time.sleep(5)
    mark = rig.fan.mark(); rig.fan.ctl(set={"2.1": True}, delay=2)
    rig.cmd("on", dev=left); time.sleep(0.5)
    rig.cmd("off", dev=left); time.sleep(7)
    rig.fan.ctl()
    steps = [r for r in rig.fan.requests(mark) if '"siid":6' in r]
    check("a move switch turned off before the state is read starts no jog", not steps and hub.attributes(left).get("switch") == "off", f"{len(steps)} steps")
    rig.cmd("on"); time.sleep(4)

def night_value(rig):
    """A value forced at night goes back to what it was when the day value is unmanaged."""
    modes = json.loads(hub.get("/modes/json"))
    current = next(m["name"] for m in modes["modes"] if m["id"] == modes["currentModeId"])
    light = lambda: [r for r in rig.fan.requests(method="set_properties") if '"siid":4' in r]
    rig.configure(lightDay="unmanaged", lightNight="off", nightModes="NoSuchMode"); time.sleep(13)
    n0 = len(light())
    check("day: the light is left alone", rig.attrs("nightMode")["nightMode"] == "off")
    rig.configure(nightModes=current); time.sleep(15)
    night = light()[n0:]
    check("night: the light is turned off", rig.attrs("nightMode")["nightMode"] == "on" and any('"value":false' in r for r in night), f"{len(night)} writes")
    n1 = len(light())
    rig.configure(nightModes="NoSuchMode"); time.sleep(15)
    day = light()[n1:]
    check("day again: the light is turned back on", rig.attrs("nightMode")["nightMode"] == "off" and any('"value":true' in r for r in day), f"{len(day)} writes")
    rig.configure(lightNight="same"); time.sleep(8)

def stale_power_legacy():
    """zhimi.fan.za1 answers device_poweroff to a level when it was switched off elsewhere."""
    rig = Rig("zhimi.fan.za1")
    try:
        time.sleep(9)
        check("the legacy device comes online", rig.online(), str(rig.attrs()))
        mark = rig.fan.mark(); rig.fan.ctl(set={"power": "off"})
        rig.cmd("setLevel", N(60)); time.sleep(8)
        sent = rig.fan.requests(mark)
        a = rig.attrs()
        check("the fan is turned on and the level is sent again", any(r.startswith("set_power") for r in sent) and a["switch"] == "on" and a["level"] == "60",
              f"{a['switch']} {a['level']} | " + "; ".join(r[:34] for r in sent))
    finally:
        rig.close()

SHARED = {"lost_write": lost_write, "unreachable": unreachable, "stray_handshake": stray_handshake,
          "stale_power_miot": stale_power_miot, "night_value": night_value}

if __name__ == "__main__":
    wanted = sys.argv[1:] or ["model_race", *SHARED, "stale_power_legacy"]
    hub.save_driver()
    rig = None
    try:
        if "model_race" in wanted:
            print("-- model_race", flush=True)
            rig = model_race()
        for name, scenario in SHARED.items():
            if name in wanted:
                if rig is None:
                    rig = Rig("dmaker.fan.p33"); time.sleep(9)
                print(f"-- {name}", flush=True)
                scenario(rig)
    finally:
        if rig:
            rig.close()
    if "stale_power_legacy" in wanted:
        print("-- stale_power_legacy", flush=True)
        stale_power_legacy()
    finish()
