# Codex navigation guide

## Fast map

| Surface | Owner / source of truth | Verification |
|---|---|---|
| Sensor mode and UART payload | `ShotCaller/Src/main.c` | `make`, flash, serial capture |
| Range parsing and SSE | `tools/viz_server.py` | Python compile + `/api/status` |
| Geometry and state transitions | `tools/shot_model.js` | `tests/shot_model.test.js` |
| Product UI and 3D renderer | `tools/viz.html` | local Chrome smoke test |
| Physical design assumptions | `docs/SHOTCALLER-NEXT.md` | measured mount + labelled throws |

## Data flow

```text
VL53L5CX -> STM32 I2C -> F frame on UART -> Python parser -> SSE
          -> empty-scene subtraction -> 3D observation -> velocity fit
          -> rim intercept/crossing -> browser event -> sample playback
```

The MCU timestamp (`frame.t`) drives trajectory math. Host arrival time
(`frame.rx`) measures delivered cadence only. Do not substitute one for the
other.

## Change boundaries

- A UART field change touches `main.c`, `SensorLink.parse_frame`, UI consumers,
  the handoff protocol example, and a live capture check.
- A geometry/state change touches `shot_model.js`, tests first, UI readouts,
  and `docs/SHOTCALLER-NEXT.md` when the physical meaning changes.
- A dashboard-only visual change should not move detector decisions back into
  inline DOM code; keep decisions in `shot_model.js`.
- A firmware configuration change must retain 4x4 <= 60 Hz and 8x8 <= 15 Hz.

## Review packet

For a cross-layer change, report:

1. Files and behavioral contracts changed.
2. RED and GREEN commands/results.
3. Firmware build size and flash result, if hardware was in scope.
4. Serial mode, measured frame cadence, parse error count.
5. Desktop/mobile UI screenshots or an explicit reason they are unavailable.
6. What remains unverified on physical throws.
