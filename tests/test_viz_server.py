import collections
import json
import os
import socket
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from unittest import mock

from tools import viz_server


class SessionRecorderTests(unittest.TestCase):
    def test_flushes_every_sensor_reading_to_a_session_log(self):
        frame = {
            "id": 41,
            "t": 1700,
            "edge": 4,
            "hz": 60,
            "d": [300] * 16,
            "s": [5] * 16,
            "sig": [18] * 16,
            "rx": 1_700_000_000.25,
        }

        with tempfile.TemporaryDirectory() as captures_dir:
            recorder = viz_server.SessionRecorder(
                captures_dir,
                port="/dev/test-shotcaller",
                baud=921600,
                started_at=1_700_000_000.0,
            )
            recorder.record_config({"res": "4", "hz": "60"})
            recorder.record_frame(frame)

            # Read before close: every frame must already be durable while a
            # person is making throws, not merely buffered until clean exit.
            with open(recorder.path, encoding="utf-8") as session_file:
                records = [json.loads(line) for line in session_file]

            self.assertEqual(
                [record["type"] for record in records],
                ["session-start", "config", "frame"],
            )
            self.assertEqual(records[2]["frame"], frame)
            self.assertEqual(recorder.status()["frames_recorded"], 1)
            self.assertTrue(recorder.status()["active"])
            self.assertTrue(os.path.isfile(recorder.status()["path"]))

            recorder.close()
            self.assertFalse(recorder.status()["active"])

    def test_recording_failure_is_visible_in_status(self):
        with tempfile.TemporaryDirectory() as captures_dir:
            recorder = viz_server.SessionRecorder(
                captures_dir,
                port="/dev/test-shotcaller",
                baud=921600,
            )
            recorder._file.close()

            self.assertFalse(recorder.record_frame({"id": 1}))
            self.assertFalse(recorder.status()["active"])
            self.assertIn("closed file", recorder.status()["error"])


class LocalServerTests(unittest.TestCase):
    def test_server_bind_does_not_require_reverse_dns(self):
        with mock.patch.object(
            socket,
            "getfqdn",
            side_effect=AssertionError("local dashboard startup must not use DNS"),
        ):
            server = viz_server.LocalThreadingHTTPServer(
                ("127.0.0.1", 0), viz_server.Handler
            )
        try:
            self.assertEqual(server.server_name, "127.0.0.1")
            self.assertGreater(server.server_port, 0)
        finally:
            server.server_close()


class _StopReader(Exception):
    """Breaks reader_loop out of its infinite loop inside a test."""


class _FakeSerial:
    def __init__(self, lines):
        self._lines = list(lines)
        self.is_open = True
        self.written = []

    def readline(self):
        if not self._lines:
            raise _StopReader
        return self._lines.pop(0)

    def write(self, data):
        self.written.append(data)

    def flush(self):
        pass

    def reset_input_buffer(self):
        pass


def _link_with(lines):
    link = viz_server.SensorLink.__new__(viz_server.SensorLink)
    link.port = "/dev/fake"
    link.baud = 921600
    link.ser = _FakeSerial(lines)
    link.lock = threading.Lock()
    link.sub_lock = threading.Lock()
    link.subscribers = set()
    link.history = collections.deque(maxlen=64)
    link.frames_seen = 0
    link.parse_errors = 0
    link.config = None
    link.recorder = None
    link.log = collections.deque(maxlen=64)
    return link


class BoardConfigTests(unittest.TestCase):
    def test_first_line_config_response_is_not_discarded(self):
        # open() flushes the input buffer and then sends '?', so the first
        # whole line after attaching is normally the board's C, answer.
        link = _link_with([
            b"C,res=4,hz=60,mode=cont,max_hz=60,target=closest\r\n",
        ])
        try:
            link.reader_loop()
        except _StopReader:
            pass

        self.assertIsNotNone(
            link.config,
            "the C, response to '?' must not be dropped as a mid-frame fragment",
        )
        self.assertEqual(link.config.get("res"), "4")

    def test_partial_first_frame_is_still_discarded(self):
        # A genuine mid-frame attach: the tail of an F, record with no prefix.
        link = _link_with([
            b"1400:5:20,1400:5:20\r\n",
            b"C,res=8,hz=15,mode=cont,max_hz=15,target=closest\r\n",
        ])
        try:
            link.reader_loop()
        except _StopReader:
            pass

        self.assertEqual(link.config.get("res"), "8")
        self.assertEqual(
            [entry for entry in link.log if "1400:5:20" in entry["text"]], [],
            "an orphaned zone fragment must not be logged as a board message",
        )


class TickRolloverTests(unittest.TestCase):
    def _frame_line(self, frame_id, t_ms):
        zones = ",".join(["1400:5:20"] * 16)
        return f"F,{frame_id},{t_ms},4,60,{zones}"

    def test_timestamps_stay_monotonic_across_the_32_bit_tick_wrap(self):
        link = _link_with([])
        near_wrap = 2 ** 32 - 50

        first = link.parse_frame(self._frame_line(1, near_wrap))
        second = link.parse_frame(self._frame_line(2, 10))

        self.assertIsNotNone(first)
        self.assertIsNotNone(second)
        self.assertGreater(
            second["t"], first["t"],
            "HAL_GetTick wraps every 49.7 days; the host treats t as always "
            "increasing, so the parser must unwrap it",
        )
        self.assertEqual(second["t"] - first["t"], 60)

    def test_ordinary_timestamps_are_untouched(self):
        link = _link_with([])
        a = link.parse_frame(self._frame_line(1, 1000))
        b = link.parse_frame(self._frame_line(2, 1016))
        self.assertEqual(a["t"], 1000)
        self.assertEqual(b["t"], 1016)


class ThrowStorageTests(unittest.TestCase):
    def test_two_saves_in_the_same_second_do_not_overwrite_each_other(self):
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.object(viz_server, "THROWS_DIR", tmp):
                first = viz_server.save_throw({"label": "in", "marker": 1})
                second = viz_server.save_throw({"label": "in", "marker": 2})

                self.assertNotEqual(
                    first, second,
                    "one-second ID precision must not let a second save "
                    "silently replace the first",
                )
                stored = sorted(
                    json.load(open(os.path.join(tmp, name)))["marker"]
                    for name in os.listdir(tmp) if name.endswith(".json")
                )
                self.assertEqual(stored, [1, 2])


class MutationAuthTests(unittest.TestCase):
    def setUp(self):
        self.link = _link_with([])
        viz_server.Handler.link = self.link
        self.server = viz_server.LocalThreadingHTTPServer(
            ("127.0.0.1", 0), viz_server.Handler
        )
        self.server.daemon_threads = True
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    def _request(self, path, method="GET", headers=None):
        req = urllib.request.Request(
            self.base + path, method=method, headers=headers or {}
        )
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                return resp.status, resp.read()
        except urllib.error.HTTPError as e:
            return e.code, e.read()

    def test_a_get_cannot_retune_the_sensor(self):
        # <img src="http://127.0.0.1:8420/cmd?c=8"> on any page the operator
        # visits must not be able to reconfigure the attached board.
        status, _ = self._request("/cmd?c=8")
        self.assertEqual(status, 405)
        self.assertEqual(
            self.link.ser.written, [],
            "a cross-origin GET must never reach the serial device",
        )

    def test_a_get_cannot_delete_labelled_throws(self):
        status, _ = self._request("/throws/delete?id=20260906-120000-in")
        self.assertEqual(status, 405)

    def test_a_post_from_the_dashboard_still_works(self):
        status, _ = self._request("/cmd?c=8", method="POST")
        self.assertEqual(status, 200)
        self.assertEqual(self.link.ser.written, [b"8"])

    def test_a_cross_origin_post_is_refused(self):
        status, _ = self._request(
            "/cmd?c=8", method="POST", headers={"Origin": "https://evil.example"}
        )
        self.assertEqual(status, 403)
        self.assertEqual(self.link.ser.written, [])

    def test_a_rebound_hostname_is_refused(self):
        # DNS rebinding: attacker.example resolves to 127.0.0.1, so the browser
        # treats the loopback server as same-origin with the attacker's page.
        status, _ = self._request("/api/status", headers={"Host": "attacker.example"})
        self.assertEqual(status, 403)


if __name__ == "__main__":
    unittest.main()
