import pathlib
import re
import unittest


SOURCE = pathlib.Path("ShotCaller/Src/main.c").read_text(encoding="utf-8")
VIZ_SERVER = pathlib.Path("tools/viz_server.py").read_text(encoding="utf-8")
CAPTURE_TOOL = pathlib.Path("capture_serial.py").read_text(encoding="utf-8")


class FirmwareContractTests(unittest.TestCase):
    def test_starts_in_8x8_at_15_hz(self):
        self.assertRegex(
            SOURCE,
            r"static\s+uint8_t\s+g_res\s*=\s*VL53L5CX_RESOLUTION_8X8",
        )
        self.assertRegex(SOURCE, r"static\s+uint8_t\s+g_hz\s*=\s*15")

    def test_range_read_failures_trigger_sensor_recovery(self):
        self.assertRegex(
            SOURCE,
            r"status\s*=\s*vl53l5cx_get_ranging_data",
        )
        self.assertRegex(SOURCE, r"RecoverSensor\(&dev\)")
        self.assertRegex(SOURCE, r"E,sensor-read,status=%u")

    def test_uart_tools_share_the_stable_460800_baud_default(self):
        self.assertRegex(SOURCE, r"huart2\.Init\.BaudRate\s*=\s*460800")
        self.assertIn('SHOTCALLER_BAUD", "460800"', VIZ_SERVER)
        self.assertIn('SHOTCALLER_BAUD", "460800"', CAPTURE_TOOL)

    def test_every_real_sensor_frame_is_published_to_swd_memory(self):
        self.assertRegex(SOURCE, r"volatile\s+SwdFrame\s+g_swd_frame")
        self.assertRegex(
            SOURCE,
            r"PublishSwdFrame\(&results,\s*frame_id\).*?"
            r"StreamFrame\(&results,\s*frame_id\)",
        )


if __name__ == "__main__":
    unittest.main()
