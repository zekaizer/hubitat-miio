"""Test harness: runs the fake fan on this machine and a temporary hub device that talks to it."""
import json, os, subprocess, sys, tempfile, time
import hub
from fakefan_token import TOKEN_HEX

HERE = os.path.dirname(os.path.abspath(__file__))
results = []

def check(name, ok, detail=""):
    results.append((name, bool(ok)))
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"  [{detail}]" if detail else ""), flush=True)

def finish():
    failed = [name for name, ok in results if not ok]
    print(f"{len(results) - len(failed)}/{len(results)} passed")
    sys.exit(1 if failed else 0)

class FakeFan:
    """One fakefan.py process. ctl() changes how it behaves from the next packet on."""

    def __init__(self, model, **ctl):
        self.dir = tempfile.mkdtemp(prefix="fakefan-")
        self.ctl_path, self.log_path = os.path.join(self.dir, "ctl.json"), os.path.join(self.dir, "log.txt")
        self.seq = 0
        open(self.log_path, "w").close()
        self.ctl(**ctl)
        self.proc = subprocess.Popen([sys.executable, os.path.join(HERE, "fakefan.py"), model, self.ctl_path, self.log_path],
                                     stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        for _ in range(40):
            if self.log():
                return
            if self.proc.poll() is not None:
                break
            time.sleep(0.25)
        raise SystemExit("fake fan did not start: " + self.proc.stderr.read().decode()[-400:])

    def ctl(self, **kw):
        self.seq += 1
        kw["seq"] = self.seq
        with open(self.ctl_path + ".tmp", "w") as f:
            json.dump(kw, f)
        os.replace(self.ctl_path + ".tmp", self.ctl_path)

    def log(self, mark=0):
        return open(self.log_path).read().splitlines()[mark:]

    def mark(self):
        return len(self.log())

    def requests(self, mark=0, method=None):
        return [l.split(" req ", 1)[1] for l in self.log(mark) if " req " in l and (method is None or f" req {method} " in l)]

    def stop(self):
        self.proc.terminate()
        self.proc.wait(timeout=5)

class Rig:
    """A fake fan plus a temporary hub device configured to use it."""

    def __init__(self, model, poll=10, ctl=None, **settings):
        self.fan = FakeFan(model, **(ctl or {}))
        self.dev = hub.create_device()
        conf = {"ip": hub.local_ip(), "token": TOKEN_HEX, "pollSeconds": poll}
        conf.update(settings)
        self.configure(**conf)

    def configure(self, **settings):
        hub.run(self.dev, "configureDevice", hub.S(json.dumps(settings)))

    def cmd(self, method, *args, dev=None):
        return hub.run(dev or self.dev, method, *args)

    def attrs(self, *names):
        a = hub.attributes(self.dev)
        return {n: a.get(n) for n in (names or ("connection", "switch", "level", "speed", "oscillation", "oscillationAngle", "windMode"))}

    def wait(self, name, value, secs=25):
        t0 = time.time()
        while time.time() - t0 < secs:
            if hub.attributes(self.dev).get(name) == value:
                return True
            time.sleep(1)
        return False

    def online(self, secs=25):
        return self.wait("connection", "online", secs)

    def close(self):
        hub.delete_device(self.dev)
        self.fan.stop()
