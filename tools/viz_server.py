#!/usr/bin/env python3
"""
viz_server.py -- bridge the ShotCaller board's UART frame stream to a local
web UI, so the VL53L5CX's field of view can be watched live in a browser.

    python3 tools/viz_server.py          # then open http://localhost:8420

The board streams one line per ranging frame (see StreamFrame() in
ShotCaller/Src/main.c):

    F,<id>,<t_ms>,<edge>,<hz>,<d>:<st>:<sig>,<d>:<st>:<sig>,...

This process parses those lines, fans them out to browsers over Server-Sent
Events, and relays single-character commands the other way so the sensor can be
retuned live (resolution / rate / ranging mode) without a rebuild.

SSE rather than WebSockets on purpose: the data is strictly one-directional
board->browser at up to 60Hz, and SSE needs nothing outside the standard
library. Commands going the other way are rare and fit fine on a plain GET.

Dependencies: pyserial (already installed on this machine).
"""
import argparse
import glob
import json
import os
import queue
import sys
import threading
import time
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from socketserver import TCPServer
from urllib.parse import urlparse, parse_qs

try:
    import serial
except ImportError:
    sys.exit("pyserial not found -- install with: pip3 install pyserial")

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)

# Ring buffer of recent frames, so a browser that connects late (or wants to
# scrub back through a throw that already happened) still has history to show.
# 1800 frames is ~2 minutes at 15Hz, ~30 seconds at 60Hz.
HISTORY = 1800
# HAL_GetTick() is uint32_t milliseconds; it wraps after ~49.7 days.
TICK_WRAP = 2 ** 32

# A continuous session writes roughly 30 KB/s at 4x4/60 Hz, so an unattended
# rig fills a disk in days. Recording is the precondition for every throw the
# operator is allowed to make, so it has to fail loudly and early rather than
# hit ENOSPC mid-session. This floor is about 4 hours of headroom.
MIN_FREE_BYTES = 512 * 1024 * 1024
# statvfs per frame would be wasteful; once per ~10 s at 60 Hz is plenty.
FREE_SPACE_CHECK_EVERY = 600


def free_bytes(path):
    """Bytes available to an unprivileged writer under path."""
    st = os.statvfs(path)
    return st.f_bavail * st.f_frsize


THROWS_DIR = os.path.join(REPO, "captures", "throws")
CONFIG_PATH = os.path.join(REPO, "captures", "detector.json")
CAPTURES_DIR = os.path.join(REPO, "captures")


class SessionRecorder:
    """Flush every parsed UART event to one append-only NDJSON session."""

    def __init__(self, captures_dir, port, baud, started_at=None):
        self.started_at = time.time() if started_at is None else started_at
        self.frames_recorded = 0
        self.error = None
        self._lock = threading.Lock()
        self._file = None

        sessions_dir = os.path.join(captures_dir, "sessions")
        os.makedirs(sessions_dir, exist_ok=True)

        # Refuse to open a session we cannot finish. Sessions are never deleted
        # automatically: a recorded throw is ground truth the operator cannot
        # regenerate, so retention stays a human decision.
        available = free_bytes(sessions_dir)
        if available < MIN_FREE_BYTES:
            raise OSError(
                f"refusing to record: {available // (1024 * 1024)} MB free space "
                f"below the {MIN_FREE_BYTES // (1024 * 1024)} MB floor at "
                f"{sessions_dir}"
            )
        stamp = time.strftime("%Y%m%d-%H%M%S",
                              time.localtime(self.started_at))
        base = os.path.join(sessions_dir, f"session-{stamp}")
        for suffix in range(1000):
            candidate = f"{base}.ndjson" if suffix == 0 else f"{base}-{suffix}.ndjson"
            try:
                self._file = open(candidate, "x", encoding="utf-8", buffering=1)
                self.path = candidate
                break
            except FileExistsError:
                continue
        else:
            raise OSError(f"cannot allocate a unique session log below {sessions_dir}")

        if not self._write({
            "type": "session-start",
            "recorded_at": self.started_at,
            "schema": 1,
            "port": port,
            "baud": baud,
        }):
            raise OSError(f"cannot initialize session log: {self.error}")

    def _write(self, record, count_frame=False):
        with self._lock:
            if self.error is not None or self._file is None:
                return False
            try:
                self._file.write(json.dumps(record, separators=(",", ":")) + "\n")
                # Deliberately flush every event. A power loss can still affect
                # the OS cache, but a crash or forced stop will not strand a
                # throw in Python's userspace buffer.
                self._file.flush()
                if count_frame:
                    self.frames_recorded += 1
                    if self.frames_recorded % FREE_SPACE_CHECK_EVERY == 0:
                        available = free_bytes(os.path.dirname(self.path))
                        if available < MIN_FREE_BYTES:
                            self.error = (
                                f"stopped recording: {available // (1024 * 1024)} MB "
                                f"free space below the "
                                f"{MIN_FREE_BYTES // (1024 * 1024)} MB floor"
                            )
                            return False
                return True
            except (OSError, ValueError) as exc:
                self.error = str(exc)
                return False

    def record_frame(self, frame):
        return self._write({
            "type": "frame",
            "recorded_at": time.time(),
            "frame": frame,
        }, count_frame=True)

    def record_config(self, config):
        return self._write({
            "type": "config",
            "recorded_at": time.time(),
            "config": config,
        })

    def record_detector_config(self, config):
        return self._write({
            "type": "detector-config",
            "recorded_at": time.time(),
            "config": config,
        })

    def record_log(self, text):
        return self._write({
            "type": "board-log",
            "recorded_at": time.time(),
            "text": text,
        })

    def status(self):
        with self._lock:
            active = (self.error is None and self._file is not None
                      and not self._file.closed)
            return {
                "active": active,
                "path": os.path.abspath(self.path),
                "frames_recorded": self.frames_recorded,
                "started_at": self.started_at,
                "error": self.error,
            }

    def close(self):
        with self._lock:
            if self._file is None or self._file.closed:
                return
            if self.error is None:
                try:
                    self._file.write(json.dumps({
                        "type": "session-end",
                        "recorded_at": time.time(),
                        "frames_recorded": self.frames_recorded,
                    }, separators=(",", ":")) + "\n")
                    self._file.flush()
                except (OSError, ValueError) as exc:
                    self.error = str(exc)
            self._file.close()


# ---- detector calibration -----------------------------------------------
# Which zones correspond to the basket opening, plus the tracker thresholds.
# This describes the physical rig (where the board is clipped, how big the
# can is), so it belongs on disk next to the recordings rather than in one
# browser's localStorage.

def load_config():
    try:
        with open(CONFIG_PATH) as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}


def save_config(cfg):
    os.makedirs(os.path.dirname(CONFIG_PATH), exist_ok=True)
    with open(CONFIG_PATH, "w") as f:
        json.dump(cfg, f, indent=2)


# ---- labelled training throws -------------------------------------------
# Kept as one JSON file per throw on disk rather than in memory, so a training
# set survives a page reload, a server restart, and a session boundary. The
# browser is the only thing that interprets them; this process just stores.

def load_throws():
    if not os.path.isdir(THROWS_DIR):
        return []
    out = []
    for name in sorted(os.listdir(THROWS_DIR)):
        if not name.endswith(".json"):
            continue
        try:
            with open(os.path.join(THROWS_DIR, name)) as f:
                t = json.load(f)
            t["id"] = name[:-5]
            out.append(t)
        except (OSError, json.JSONDecodeError):
            continue
    return out


def save_throw(payload):
    os.makedirs(THROWS_DIR, exist_ok=True)
    # Throw IDs carry one-second precision, so two saves inside the same second
    # -- a double-click, or two dashboard tabs -- would land on one path and the
    # second would truncate the first. Create exclusively and suffix on
    # collision so a labelled throw is never silently replaced.
    stem = time.strftime("%Y%m%d-%H%M%S") + f"-{payload['label']}"
    for attempt in range(1, 1000):
        tid = stem if attempt == 1 else f"{stem}-{attempt}"
        try:
            fd = os.open(
                os.path.join(THROWS_DIR, tid + ".json"),
                os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                0o644,
            )
        except FileExistsError:
            continue
        with os.fdopen(fd, "w") as f:
            json.dump(payload, f)
        return tid
    raise OSError(f"could not allocate a throw id for {stem}")


def delete_throw(tid):
    # Reject anything that could climb out of the throws directory.
    if not tid or "/" in tid or ".." in tid:
        return False
    path = os.path.join(THROWS_DIR, tid + ".json")
    try:
        os.remove(path)
        return True
    except OSError:
        return False


def autodetect_port():
    """Nucleo ST-LINK VCP shows up as /dev/cu.usbmodem* on macOS."""
    candidates = sorted(glob.glob("/dev/cu.usbmodem*"))
    if not candidates:
        candidates = sorted(glob.glob("/dev/ttyACM*"))  # Linux
    return candidates[0] if candidates else None


class SensorLink:
    """Owns the serial port: parses frames off it, writes commands to it."""

    def __init__(self, port, baud, recorder=None):
        self.port = port
        self.baud = baud
        self.recorder = recorder
        self.ser = None
        self.lock = threading.Lock()

        self.history = deque(maxlen=HISTORY)
        self.config = {}
        self.log = deque(maxlen=200)
        self.subscribers = set()
        self.sub_lock = threading.Lock()

        self.frames_seen = 0
        self.parse_errors = 0
        self.recording_failure_noted = False

    def open(self):
        self.ser = serial.Serial(self.port, self.baud, timeout=1.0)
        # The board may be mid-frame when we attach; drop whatever is buffered
        # so the first line we parse is a whole one.
        time.sleep(0.1)
        self.ser.reset_input_buffer()
        # The board only announces its configuration when it changes, so a
        # process attaching mid-run has no idea what resolution/rate is active.
        # '?' asks it to re-announce.
        self.ser.write(b"?")
        self.ser.flush()

    def send(self, ch):
        with self.lock:
            if self.ser:
                self.ser.write(ch.encode("ascii")[:1])
                self.ser.flush()

    def subscribe(self):
        # Bounded queue: if a browser tab can't keep up, we drop its oldest
        # frames rather than let the reader thread block. Live view stays live.
        q = queue.Queue(maxsize=120)
        with self.sub_lock:
            self.subscribers.add(q)
        return q

    def unsubscribe(self, q):
        with self.sub_lock:
            self.subscribers.discard(q)

    def _publish(self, msg):
        with self.sub_lock:
            targets = list(self.subscribers)
        for q in targets:
            try:
                q.put_nowait(msg)
            except queue.Full:
                try:
                    q.get_nowait()
                    q.put_nowait(msg)
                except queue.Empty:
                    pass

    def _unwrap_tick(self, raw):
        """HAL_GetTick() is a 32-bit millisecond counter and wraps every 49.7
        days. Everything downstream -- track expiry, cooldowns, velocity --
        assumes timestamps only increase, so unwrap the counter here at the
        parser boundary rather than teach every consumer about the wrap."""
        last = getattr(self, "_last_raw_tick", None)
        epoch = getattr(self, "_tick_epoch", 0)
        if last is not None and raw < last and (last - raw) > TICK_WRAP // 2:
            epoch += 1
        self._tick_epoch = epoch
        self._last_raw_tick = raw
        return raw + epoch * TICK_WRAP

    def parse_frame(self, line):
        """F,<id>,<t_ms>,<edge>,<hz>,<d>:<st>:<sig>,... -> dict, or None."""
        parts = line.split(",")
        if len(parts) < 6:
            return None
        try:
            frame_id = int(parts[1])
            t_ms = self._unwrap_tick(int(parts[2]))
            edge = int(parts[3])
            hz = int(parts[4])
        except ValueError:
            return None

        dist, status, signal = [], [], []
        for zone in parts[5:]:
            bits = zone.split(":")
            if len(bits) != 3:
                return None
            try:
                dist.append(int(bits[0]))
                status.append(int(bits[1]))
                signal.append(int(bits[2]))
            except ValueError:
                return None

        if len(dist) != edge * edge:
            return None

        return {
            "id": frame_id,
            "t": t_ms,
            "edge": edge,
            "hz": hz,
            "d": dist,
            "s": status,
            "sig": signal,
            # Host arrival time: lets the UI measure the delivered frame rate
            # independently of the board's own clock.
            "rx": time.time(),
        }

    def reader_loop(self):
        # We almost certainly attached mid-frame, so the first readline() is a
        # tail fragment. Drop it rather than log a line of orphaned zone data.
        first = True
        while True:
            try:
                raw = self.ser.readline()
            except serial.SerialException as e:
                self._note(f"serial error: {e}")
                time.sleep(1.0)
                continue

            if not raw:
                continue
            line = raw.decode("utf-8", errors="replace").strip()
            if not line:
                continue
            if first:
                first = False
                # open() flushes the input buffer and then asks the board to
                # re-announce with '?', so the first whole line is usually the
                # C, reply -- dropping it unconditionally left /api/status and
                # every fresh dashboard with no board configuration. Only
                # discard it when it is not already a complete record.
                if not line.startswith(("F,", "C,", "E,")):
                    continue

            if line.startswith("F,"):
                frame = self.parse_frame(line)
                if frame is None:
                    self.parse_errors += 1
                    continue
                self.frames_seen += 1
                if (self.recorder and not self.recorder.record_frame(frame)
                        and not self.recording_failure_noted):
                    self.recording_failure_noted = True
                    self._note(
                        f"CRITICAL: continuous recorder stopped: "
                        f"{self.recorder.status()['error']}",
                        record=False,
                    )
                self.history.append(frame)
                self._publish({"type": "frame", "frame": frame})
            elif line.startswith("C,"):
                cfg = {}
                for kv in line[2:].split(","):
                    if "=" in kv:
                        k, v = kv.split("=", 1)
                        cfg[k] = v
                self.config = cfg
                if self.recorder:
                    self.recorder.record_config(cfg)
                self._note(f"config: {line[2:]}", record=False)
                self._publish({"type": "config", "config": cfg})
            else:
                self._note(line)

    def _note(self, text, record=True):
        entry = {"t": time.time(), "text": text}
        self.log.append(entry)
        if record and self.recorder:
            self.recorder.record_log(text)
        print(f"[board] {text}", flush=True)
        self._publish({"type": "log", "log": entry})


class LocalThreadingHTTPServer(ThreadingHTTPServer):
    """Loopback HTTP server that never blocks startup on reverse DNS."""

    def server_bind(self):
        TCPServer.server_bind(self)
        self.server_name, self.server_port = self.server_address[:2]


class Handler(BaseHTTPRequestHandler):
    link = None  # set on the class before serving

    def log_message(self, fmt, *args):
        pass  # the board's own log is the interesting one

    def handle(self):
        # Browsers routinely reset a keep-alive or SSE socket when a tab closes.
        # That is transport cleanup, not a server fault worth a traceback.
        try:
            super().handle()
        except ConnectionResetError:
            pass

    def _send(self, code, body, ctype="text/plain; charset=utf-8"):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # Endpoints that change state: retune the board, write capture files, or
    # delete labelled throws. They are reachable from any page the operator has
    # open, because the browser attaches to loopback happily from any origin.
    # /config is not listed: GET /config reads the saved geometry and only
    # POST /config writes it.
    MUTATIONS = ("/cmd", "/save", "/throws/delete", "/throws/save")

    LOOPBACK_HOSTS = ("127.0.0.1", "localhost", "::1", "[::1]")

    def _host_is_loopback(self):
        """Reject a rebound hostname. If attacker.example resolves to
        127.0.0.1, the browser treats this server as same-origin with the
        attacker's page; checking Host closes that."""
        host = (self.headers.get("Host") or "").strip()
        if host.startswith("[") and "]" in host:
            host = host[1:host.index("]")]          # [::1]:8420 -> ::1
        elif host.count(":") == 1:
            host = host.split(":", 1)[0]            # 127.0.0.1:8420 -> 127.0.0.1
        return host == "" or host in self.LOOPBACK_HOSTS

    def _origin_is_local(self):
        """A cross-site fetch carries the attacker's Origin. A same-origin
        dashboard request carries ours, or none at all."""
        origin = self.headers.get("Origin")
        if not origin:
            return True
        host = urlparse(origin).hostname
        return host in ("127.0.0.1", "localhost", "::1")

    def _guard(self):
        if not self._host_is_loopback():
            self._send(403, "forbidden: non-loopback Host")
            return False
        if not self._origin_is_local():
            self._send(403, "forbidden: cross-origin request")
            return False
        return True

    def do_GET(self):
        url = urlparse(self.path)
        qs = parse_qs(url.query)

        if not self._guard():
            return

        # A GET must never change anything: <img src="http://127.0.0.1:8420/
        # cmd?c=8"> on any page the operator visits would otherwise retune the
        # attached sensor, and a guessed throw ID would delete capture data.
        if url.path in self.MUTATIONS:
            self.send_response(405)
            self.send_header("Allow", "POST")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        if url.path in ("/", "/index.html"):
            try:
                with open(os.path.join(HERE, "viz.html"), "rb") as f:
                    self._send(200, f.read(), "text/html; charset=utf-8")
            except OSError as e:
                self._send(500, f"cannot read viz.html: {e}")

        elif url.path == "/shot_model.js":
            try:
                with open(os.path.join(HERE, "shot_model.js"), "rb") as f:
                    self._send(200, f.read(), "text/javascript; charset=utf-8")
            except OSError as e:
                self._send(500, f"cannot read shot_model.js: {e}")

        elif url.path == "/api/status":
            self._send(200, json.dumps({
                "connected": self.link.ser is not None and self.link.ser.is_open,
                "port": self.link.port,
                "baud": self.link.baud,
                "frames_seen": self.link.frames_seen,
                "parse_errors": self.link.parse_errors,
                "config": self.link.config,
                "recording": (self.link.recorder.status()
                              if self.link.recorder else None),
            }), "application/json")

        elif url.path == "/events":
            self.stream_events()

        elif url.path == "/history":
            n = int((qs.get("n") or [str(HISTORY)])[0])
            frames = list(self.link.history)[-n:]
            self._send(200, json.dumps({"frames": frames}),
                       "application/json")

        elif url.path == "/throws/list":
            self._send(200, json.dumps({"throws": load_throws()}),
                       "application/json")

        elif url.path == "/config":
            self._send(200, json.dumps(load_config()), "application/json")

        else:
            self._send(404, "not found")

    def do_POST(self):
        url = urlparse(self.path)
        qs = parse_qs(url.query)

        if not self._guard():
            return

        if url.path == "/cmd":
            ch = (qs.get("c") or [""])[0]
            if not ch:
                self._send(400, "missing ?c=<char>")
                return
            self.link.send(ch)
            self._send(200, "ok")
            return

        if url.path == "/save":
            self.save_capture()
            return

        if url.path == "/throws/delete":
            tid = (qs.get("id") or [""])[0]
            self._send(200, json.dumps({"deleted": delete_throw(tid)}),
                       "application/json")
            return

        if url.path not in ("/throws/save", "/config"):
            self._send(404, "not found")
            return

        length = int(self.headers.get("Content-Length") or 0)
        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError as e:
            self._send(400, f"bad JSON: {e}")
            return

        if url.path == "/config":
            save_config(payload)
            if self.link.recorder:
                self.link.recorder.record_detector_config(payload)
            self._send(200, json.dumps({"saved": True}), "application/json")
            return

        label = payload.get("label")
        if label not in ("in", "miss"):
            self._send(400, "label must be 'in' or 'miss'")
            return

        tid = save_throw(payload)
        print(f"[training] saved {label} throw {tid} "
              f"({len(payload.get('frames') or [])} frames)", flush=True)
        self._send(200, json.dumps({"id": tid}), "application/json")

    def stream_events(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        # Without this, a proxy or the browser may sit on the stream waiting
        # for a buffer to fill, which shows up as "the UI is frozen".
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()

        q = self.link.subscribe()
        try:
            if self.link.config:
                self._sse({"type": "config", "config": self.link.config})
            while True:
                try:
                    msg = q.get(timeout=10.0)
                except queue.Empty:
                    # Keepalive comment: proves the connection is alive when
                    # the sensor is paused and no frames are flowing.
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
                    continue
                self._sse(msg)
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            self.link.unsubscribe(q)

    def _sse(self, msg):
        self.wfile.write(b"data: " + json.dumps(msg).encode("utf-8") + b"\n\n")
        self.wfile.flush()

    def save_capture(self):
        outdir = os.path.join(REPO, "captures")
        os.makedirs(outdir, exist_ok=True)
        name = time.strftime("capture-%Y%m%d-%H%M%S.json")
        path = os.path.join(outdir, name)
        payload = {
            "saved": time.time(),
            "config": self.link.config,
            "frames": list(self.link.history),
        }
        with open(path, "w") as f:
            json.dump(payload, f)
        self._send(200, json.dumps({"path": path,
                                    "frames": len(payload["frames"])}),
                   "application/json")


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", default=os.environ.get("SHOTCALLER_PORT"),
                    help="serial device (default: autodetect /dev/cu.usbmodem*)")
    ap.add_argument("--baud", type=int,
                    default=int(os.environ.get("SHOTCALLER_BAUD", "921600")))
    ap.add_argument("--http-port", type=int, default=8420)
    args = ap.parse_args()

    port = args.port or autodetect_port()
    if not port:
        sys.exit("No serial port found. Plug in the Nucleo, or pass --port. "
                 "Check with: ls /dev/cu.usbmodem*")

    try:
        recorder = SessionRecorder(CAPTURES_DIR, port, args.baud)
    except OSError as e:
        sys.exit(f"ERROR starting mandatory continuous recorder: {e}")

    link = SensorLink(port, args.baud, recorder)
    try:
        link.open()
    except serial.SerialException as e:
        recorder.close()
        sys.exit(f"ERROR opening {port} @ {args.baud}: {e}")

    threading.Thread(target=link.reader_loop, daemon=True).start()

    Handler.link = link
    httpd = LocalThreadingHTTPServer(("127.0.0.1", args.http_port), Handler)
    httpd.daemon_threads = True

    print(f"Serial : {port} @ {args.baud}")
    print(f"Record : {recorder.path}")
    print(f"Web UI : http://localhost:{args.http_port}")
    print("Ctrl-C to stop.")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")
    finally:
        httpd.server_close()
        if link.ser is not None and link.ser.is_open:
            link.ser.close()
        recorder.close()


if __name__ == "__main__":
    main()
