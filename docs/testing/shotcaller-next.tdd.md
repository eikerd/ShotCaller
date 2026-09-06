# ShotCaller Next — TDD evidence

## Source and journeys

No external plan file was used. The testable journeys were derived from the
product request:

- As the gadget, I enter tracking on the first credible foreground return so
  event code can react immediately.
- As the gadget, I confirm a projectile from stable 3D velocity and emit an
  inbound event early.
- As the gadget, I reward only a downward path crossing inside the calibrated
  rim aperture.
- As the gadget, I call an outside crossing a miss and ignore a slow hand.
- As the builder, I can see and tune the sensor/can geometry in a live 3D view.

## RED / GREEN evidence

| Behavior | Test target | RED evidence | GREEN evidence |
|---|---|---|---|
| 3D rays, pitch, and rim interception | `tests/shot_model.test.js` | `node --test tests/shot_model.test.js` failed with `Cannot find module '../tools/shot_model.js'` | 8/8 tests pass |
| Background subtraction and connected foreground group | `tests/shot_model.test.js` | Same missing implementation RED gate | Static frame returns no observation; nearer zone returns one observation |
| Early acquisition and inbound hook | `tests/shot_model.test.js` | Same missing implementation RED gate | Tracking begins on observation 1; inbound emits by observation 3 / 34 ms |
| In, miss, and slow-hand rejection | `tests/shot_model.test.js` | Same missing implementation RED gate | Synthetic make/miss sequences resolve correctly; slow hand emits no sound/outcome event |

Checkpoint commits on the active branch:

- RED: `a009e6d test: define 3D trajectory detector behavior`
- GREEN: `4f286fc feat: add calibrated 3D shot trajectory model`

## Verification

- `node --test --experimental-test-coverage tests/shot_model.test.js`
  - 8 tests passed, 0 failed.
  - `tools/shot_model.js`: 93.61% lines, 81.06% branches, 83.33% functions.
- Inline dashboard JavaScript compiled with `new Function(...)`.
- `python3 -m py_compile tools/viz_server.py capture_serial.py` passed.
- `make -j4` passed; firmware size was 109,588 bytes text + 108 bytes data.
- `make flash` completed with write verification.
- Post-flash serial capture declared `res=4,hz=60,target=closest` and measured
  about 16.8 ms between frames.
- Browser smoke test used local headless Chrome through the DevTools protocol:
  desktop synthetic make, 390x844 synthetic miss, and a live board session.
  No runtime exceptions or horizontal overflow were found. The live system
  reached `ARMED` at 4x4/60 Hz with 16/16 valid zones and zero parse errors.

## Known gaps

- There are no real labelled throws yet, so physical classification accuracy
  is unknown.
- Automated browser accessibility rules were unavailable; labels, landmarks,
  button names, input labels, reduced-motion behavior, and responsive overflow
  received structural/manual checks, but this is not a full WCAG audit.
- Audio files loaded through the browser are intentionally session-local.
