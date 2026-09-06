# ShotCaller project instructions

## Purpose

ShotCaller is a trash-can projectile detector built around a VL53L5CX ToF
sensor. The current Nucleo rig streams ranges to a local browser trajectory
lab; the eventual product is a compact clip-on sensor and audio device.

## Structure

- `ShotCaller/Src/main.c`: STM32 bring-up, sensor configuration, UART protocol.
- `ShotCaller/Drivers/`: vendored CMSIS, HAL, and VL53L5CX ULD code. Avoid
  editing vendored files unless the task explicitly requires it.
- `tools/shot_model.js`: testable geometry and detector state machine.
- `tools/viz_server.py`: serial-to-SSE bridge and local persistence API.
- `tools/viz.html`: dependency-free 3D trajectory dashboard.
- `tests/`: Node test-runner coverage for the detector model.
- `captures/`: local ignored calibration and labelled-throw data.

Read `docs/CODEX-NAVIGATION-GUIDE.md` and `docs/SHOTCALLER-NEXT.md` before a
cross-layer feature.

## Commands

- Build firmware: `make`
- Flash the connected dev rig: `make flash`
- Unit tests: `node --test tests/shot_model.test.js`
- Coverage: `node --test --experimental-test-coverage tests/shot_model.test.js`
- Python syntax: `python3 -m py_compile tools/viz_server.py capture_serial.py`
- Run dashboard: `python3 tools/viz_server.py`, then open
  `http://127.0.0.1:8420`
- Capture UART: `python3 capture_serial.py 5 build/serial_capture.log`

## Conventions

- Keep the frame parser and firmware `F,` / `C,` protocol changes synchronized.
- Only target statuses 5 and 9 are trustworthy range values.
- Use 4x4/60 Hz for throws; keep 8x8 for spatial inspection.
- Preserve the `target-acquired`, `inbound`, `bank-predicted`, `rim-crossed`,
  `in`, and `miss` event names across browser and future embedded ports.
- Collision-surface normals point into playable free space. Treat bank
  predictions as anticipatory effects only; `in` still requires an observed
  downward rim crossing.
- Detector behavior changes require a failing test before implementation.
- Do not claim physical accuracy from synthetic tests. Record and label real
  throws for every mounted geometry.
- Never ask the user to make a test throw until `/api/status` reports an active
  continuous recorder and `recording.frames_recorded` is advancing. Keep the
  recorder running for the entire throw session; do not rely only on labelled
  event windows.
- Never hardcode a transient `/dev/cu.usbmodem*` suffix; autodetect or accept
  `SHOTCALLER_PORT`.
- Review `git diff` before committing. Do not commit captures or build output.
