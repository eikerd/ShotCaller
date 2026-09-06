# Continuous session logging — TDD evidence

## Contract

- The serial bridge starts an append-only session before it opens the sensor.
- Every parsed ToF frame is flushed to disk immediately, including all range,
  target-status, signal, timing, resolution, and rate fields.
- Configuration declarations and board messages share the same ordered log.
- Recorder failure is explicit in `/api/status`; the cockpit disables arming.
- A human throw is never requested until the recorder reports active and its
  frame count is advancing.

Session logs are NDJSON files under `captures/sessions/`. They remain local and
git-ignored; each line is independently parseable after an abrupt process stop.

## RED / GREEN evidence

| Behavior | RED | GREEN |
|---|---|---|
| Frame is readable before recorder close | `AttributeError: module 'tools.viz_server' has no attribute 'SessionRecorder'` | The open file contains `session-start`, `config`, and the complete `frame` record |
| Write failure is observable | Same missing implementation gate | `active` becomes false and `error` describes the failed write |

Checkpoint commits:

- RED: `6712ce4 test: require continuous sensor session logs`
- GREEN: `09274fa feat: record every sensor session continuously`

## Verification target

Run `PYTHONDONTWRITEBYTECODE=1 python3 -m unittest tests.test_viz_server`, then
start the bridge against the live rig and confirm both
`frames_seen` and `recording.frames_recorded` increase between status polls.
