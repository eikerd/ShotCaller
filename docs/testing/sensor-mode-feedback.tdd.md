# Sensor-mode feedback TDD evidence

## Source and journey

The journey came from a reported live-dashboard failure: when a user clicks
4x4 or 8x8, the interface must immediately show that the request was sent and
must then show either the board's acknowledged resolution/rate or an explicit
failure.

## RED / GREEN

| Behavior | RED evidence | GREEN verification | Guarantee |
|---|---|---|---|
| Mode clicks never disappear silently | `node --test tests/viz_ui.test.js` failed because no `sensorModeStatus`, request state, acknowledgment handler, or timeout existed | `node --test tests/viz_ui.test.js` | Every live mode click enters `REQUESTING`, then resolves to `ACKNOWLEDGED`, `COMMAND DELIVERY FAILED`, or `NO SENSOR ACK` |
| Existing detector behavior remains intact | Not changed by this UI task | `node --test tests/shot_model.test.js` | Geometry, acquisition, prediction, and verdict tests remain green |

## Coverage and known gap

The interaction contract is covered by the dashboard test and the complete
detector suite remains above the project's 80% aggregate coverage target.
Browser automation is unavailable because its extension is not attached. A
real 8x8 acknowledgment still requires the connected VL53L5CX to recover from
its current I2C read stall.
