"""Every command of the driver on both models, tested against the fake fan.

    HUBITAT_HUB=http://<hub> python tests/test_commands.py [model ...]

Uploads the working copy of the driver first. Takes about three minutes per model.
"""
import sys, time
import hub
from hub import N, S
from harness import Rig, check, finish

# model: (angle the driver must refuse, steps a jog takes before the switch turns itself off)
MODELS = {"dmaker.fan.p33": (45, 28), "zhimi.fan.za1": (140, 24)}

def moves(rig, mark=0):
    return [r for r in rig.fan.requests(mark) if r.startswith("set_move") or '"siid":6' in r]

def run(model):
    bad_angle, range_steps = MODELS[model]
    rig = Rig(model, poll=30, moveSwitches=True)
    try:
        time.sleep(9)
        check("the device comes online", rig.online(), str(rig.attrs()))
        kids = hub.children(rig.dev)
        check("three child switches exist", set(kids) == {"Oscillation", "Move Left", "Move Right"}, str(kids))
        child = lambda name: hub.attributes(kids[name]).get("switch")

        def step(name, expect, *call, dev=None, wait=2.5):
            rig.cmd(*call, dev=dev); time.sleep(wait)
            a = rig.attrs()
            check(name, all(a[k] == v for k, v in expect.items()), " ".join(f"{k}={a[k]}" for k in expect))

        step("setLevel 40", {"switch": "on", "level": "40", "speed": "medium-low"}, "setLevel", N(40))
        step("setSpeed high", {"level": "100", "speed": "high"}, "setSpeed", S("high"))
        step("setSpeed low", {"level": "25", "speed": "low"}, "setSpeed", S("low"))
        step("cycleSpeed", {"level": "50", "speed": "medium-low"}, "cycleSpeed")

        step("setOscillation on", {"oscillation": "on"}, "setOscillation", S("on"))
        check("the child follows", child("Oscillation") == "on")
        step("child off", {"oscillation": "off"}, "off", dev=kids["Oscillation"])
        step("child on", {"oscillation": "on"}, "on", dev=kids["Oscillation"])
        step("setOscillation off", {"oscillation": "off"}, "setOscillation", S("off"))
        check("the child follows", child("Oscillation") == "off")

        step("angle 60 turns oscillation on", {"oscillationAngle": "60", "oscillation": "on"}, "setOscillationAngle", N(60))
        step(f"angle {bad_angle} is refused", {"oscillationAngle": "60"}, "setOscillationAngle", N(bad_angle))
        rig.cmd("setOscillationAngle", N(120)); time.sleep(2.5)
        step("angle 120, oscillation off", {"oscillationAngle": "120", "oscillation": "off"}, "setOscillation", S("off"))

        step("natural wind", {"windMode": "natural"}, "setWindMode", S("natural"))
        step("a level keeps natural wind", {"windMode": "natural", "level": "60"}, "setLevel", N(60))
        step("normal wind", {"windMode": "normal", "level": "60"}, "setWindMode", S("normal"))

        mark = rig.fan.mark()
        rig.cmd("move", S("left")); time.sleep(2)
        check("move sends one step", len(moves(rig, mark)) == 1, f"{len(moves(rig, mark))} steps")

        mark = rig.fan.mark()
        rig.cmd("on", dev=kids["Move Left"]); time.sleep(2.6)
        check("a move switch stays on while jogging", child("Move Left") == "on")
        rig.cmd("off", dev=kids["Move Left"]); time.sleep(0.3)
        sent = len(moves(rig, mark)); time.sleep(2)
        check("a jog sends several steps", sent >= 3, f"{sent} steps in 2.6 s")
        check("no step after the switch is turned off", len(moves(rig, mark)) == sent, f"{len(moves(rig, mark)) - sent} more")
        check("the move switch is off", child("Move Left") == "off")

        rig.cmd("on", dev=kids["Move Left"]); time.sleep(1.2)
        rig.cmd("on", dev=kids["Move Right"]); time.sleep(1.2)
        check("turning one move switch on turns the other off", child("Move Left") == "off" and child("Move Right") == "on")
        rig.cmd("off", dev=kids["Move Right"]); time.sleep(2)

        rig.cmd("setOscillation", S("on")); time.sleep(2.5)
        mark = rig.fan.mark()
        rig.cmd("on", dev=kids["Move Left"]); time.sleep(2)
        rig.cmd("off", dev=kids["Move Left"]); time.sleep(2)
        check("a jog turns oscillation off first", rig.attrs()["oscillation"] == "off" and len(moves(rig, mark)) >= 1, f"{len(moves(rig, mark))} steps")

        mark = rig.fan.mark()
        rig.cmd("on", dev=kids["Move Right"])
        t0 = time.time()
        while time.time() - t0 < 40 and child("Move Right") == "on":
            time.sleep(1)
        time.sleep(1.5)
        check("a move switch left on turns itself off after the range", len(moves(rig, mark)) == range_steps, f"{len(moves(rig, mark))} steps, expected {range_steps}")

        step("off", {"switch": "off", "speed": "off"}, "off")
        mark = rig.fan.mark()
        rig.cmd("setOscillation", S("on")); rig.cmd("setWindMode", S("natural")); rig.cmd("on", dev=kids["Move Left"]); time.sleep(5)
        a = rig.attrs()
        writes = [r for r in rig.fan.requests(mark) if r.startswith("set_")]
        check("oscillation, wind mode and move are refused while off",
              a["oscillation"] == "off" and a["windMode"] == "normal" and not writes and child("Move Left") == "off" and child("Oscillation") == "off",
              f"{a['oscillation']} {a['windMode']}, {len(writes)} writes")

        step("setLevel turns the fan on", {"switch": "on", "level": "30"}, "setLevel", N(30))
        step("setLevel 0 turns it off", {"switch": "off"}, "setLevel", N(0))
        rig.cmd("on"); rig.cmd("setLevel", N(100)); time.sleep(3.5)
        a = rig.attrs()
        check("on followed at once by setLevel 100", a["switch"] == "on" and a["level"] == "100", str(a))
        time.sleep(32)
        a = rig.attrs()
        check("unchanged after a poll", a["switch"] == "on" and a["level"] == "100" and a["connection"] == "online", str(a))
    finally:
        rig.close()

if __name__ == "__main__":
    hub.save_driver()
    for model in sys.argv[1:] or list(MODELS):
        print(f"-- {model}", flush=True)
        run(model)
    finish()
