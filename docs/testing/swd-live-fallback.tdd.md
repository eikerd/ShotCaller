# SWD live-frame fallback TDD evidence

## User journey

As the device operator, I want the dashboard to show and continuously record
real 8x8 ToF readings when the ST-LINK virtual COM endpoint is silent, so that
an `OFFLINE` label does not prevent physical sensor evaluation.

## RED / GREEN

| Guarantee | RED evidence | GREEN evidence |
|---|---|---|
| Every successful sensor read is copied into a debugger-readable frame ring before UART output | `python3 -m unittest tests.test_firmware_contract` failed because `g_swd_frame` and `PublishSwdFrame` did not exist | Firmware contract passes and `make` succeeds |
| Torn SRAM reads and unknown memory are rejected | `tests.test_swd_transport` initially failed to import the missing transport | Four SWD decode/ring tests pass |
| Equal initial seqlock values in different ring slots are not mistaken for one frame | Consecutive-slot regression raised `IndexError` because the second frame was suppressed | Iterator keys frame identity from the monotonic ring write count |
| A real SWD frame makes the dashboard live even while UART remains silent | `SensorLink` had no `accept_frame` path and the status integration test errored | Server integration test passes and status reports `transport: swd` |
| Disarmed and disconnected are visibly different | Browser source contract failed because every detector-off state said `OFFLINE` | UI contract passes with `DISARMED` for a live sensor and `SENSOR OFFLINE` only when frames are absent |

## Physical verification

After flashing the new firmware, the host decoded a real 64-zone frame directly
from MCU SRAM. With the append-only recorder running, this command passed:

```text
python3 tools/live_sensor_smoke.py --url http://127.0.0.1:8420/api/status --seconds 5 --expect-edge 8
{"edge":"8","frames_recorded_delta":17,"frames_seen_delta":17,"parse_errors_delta":0}
LIVE PASS: real sensor frames and continuous recording are advancing
```

The SWD fallback delivers approximately 3.4 dashboard frames per second from
an 8x8/15 Hz sensor because this old V2J33S25 probe reads SRAM slowly. It is
enough for real field-of-view and hand-motion evaluation, but the VCP or an
external UART remains necessary for full-rate projectile tracking.
