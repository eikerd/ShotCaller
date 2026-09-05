import json
import os
import socket
import tempfile
import unittest
from types import SimpleNamespace
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
            recorder.record_detector_config({
                "geometry": {
                    "rearWallBankEnabled": True,
                    "rearWallGapMm": 30,
                    "rearWallRestitution": 0.5,
                }
            })
            recorder.record_frame(frame)

            # Read before close: every frame must already be durable while a
            # person is making throws, not merely buffered until clean exit.
            with open(recorder.path, encoding="utf-8") as session_file:
                records = [json.loads(line) for line in session_file]

            self.assertEqual(
                [record["type"] for record in records],
                ["session-start", "config", "detector-config", "frame"],
            )
            self.assertTrue(records[2]["config"]["geometry"]["rearWallBankEnabled"])
            self.assertEqual(records[3]["frame"], frame)
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


class SensorLinkStatusTests(unittest.TestCase):
    def test_open_serial_port_is_not_reported_live_until_frames_arrive(self):
        link = viz_server.SensorLink("/dev/test-shotcaller", 921600)
        link.ser = SimpleNamespace(is_open=True)

        waiting = link.status(now=100.0)
        self.assertTrue(waiting["serial_open"])
        self.assertFalse(waiting["connected"])

        link.last_frame_at = 99.25
        self.assertTrue(link.status(now=100.0)["connected"])
        self.assertFalse(link.status(now=102.0)["connected"])


if __name__ == "__main__":
    unittest.main()
