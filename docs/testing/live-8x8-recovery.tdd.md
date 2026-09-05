# Live 8x8 and sensor recovery — TDD evidence

## Contract

- The production dashboard contains no simulated throws or synthetic frames.
- The first sensor raster and firmware mode are 8x8 at 15 Hz.
- A ranging read error power-cycles and reinitializes the sensor instead of
  leaving a connected but permanently silent board.
- An open serial device is not labeled live until recent real frames arrive.
- A test throw is requested only after real and recorded frame counts advance.

## RED / GREEN evidence

| Behavior | RED | GREEN |
|---|---|---|
| Live-only 8x8 dashboard | `tests/viz_ui.test.js` found simulation controls and a 4x4 initial raster | Dashboard test passes with the simulation path removed and 64 initial zones |
| 8x8 firmware startup and read recovery | `tests/test_firmware_contract.py` found 4x4/60 defaults and no checked read/recovery path | Firmware contract passes and `make` links a 110,640-byte image |
| Honest liveness | The event-stream open handler displayed `streaming` with zero sensor frames | Server and UI tests pass; liveness expires two seconds after the last real frame |
| Stable transport rate | Firmware and tools disagreed with the new 460800 requirement | Contract test passes with the MCU and both host tools sharing 460800 baud |
| Hardware acceptance | `tools/live_sensor_smoke.py --seconds 3` | **Still red at 921600 and 460800:** no UART bytes, no sensor declaration, and zero recorded frames |

RED checkpoint: `721cec5 test: require live 8x8 sensor recovery`.

The physical acceptance result is intentionally not called green. Debugger
inspection proves the VL53L5CX is ranging inside the MCU, but the ST-LINK VCP
currently carries no bytes in either direction. A full board/ST-LINK USB power
cycle did not recover it. Rebuilding and reflashing the exact firmware commit
from the last successful archived session also produced zero transport bytes,
which isolates the present fault to the VCP path rather than this change set.
