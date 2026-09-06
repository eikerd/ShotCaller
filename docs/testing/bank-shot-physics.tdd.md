# Bank-shot physics — TDD evidence

## Source and journeys

No external plan was used. The guarantees came from the requirement that a can
may sit against a wall and trajectories must not assume constant straight-line
motion.

- As the detector, I fit current projectile velocity without confusing gravity
  for measurement noise.
- As the predictor, I follow rising and falling ballistic paths.
- As the predictor, I can reflect from bounded planes with arbitrary normals
  and configurable energy loss.
- As event code, I receive one early `bank-predicted` hook while the final
  reward remains tied to an observed rim crossing.

## RED / GREEN evidence

| Guarantee | RED evidence | GREEN evidence |
|---|---|---|
| Gravity-aware latest velocity | Existing linear fit missed the expected vertical velocity | Analytic ballistic samples recover all three latest velocity components |
| Rising and falling rim prediction | Linear prediction returned 100 ms and rejected an initially rising lob | Piecewise ballistic prediction reaches the rim in under 80 ms and resolves the lob |
| Arbitrary-plane reflection | `reflectVelocity is not a function` | Normal velocity reverses by restitution while tangent is independently retained |
| Rear-wall bank | `predictTrajectory is not a function` | A direct miss becomes an inside-rim path with one registered rear-wall collision |
| Early event hook | Expected one `bank-predicted`, received zero | One hook carries the ordered `rear-wall` collision list |

Checkpoint commits:

- RED: `e0554a1 test: define bank-shot and ballistic physics`
- RED refinement: `d2826bb test: require rising lob prediction`
- GREEN: `9826297 feat: add piecewise ballistic bank-shot physics`
- Hook RED: `b0ee591 test: require early bank prediction event`
- Hook GREEN: `60a2874 feat: emit early bank-shot prediction hook`
- Session-config RED: `6a948e7 test: require physics config in session logs`
- Session-config GREEN: `7adf430 feat: timestamp physics config in sensor sessions`

## Verification

- `node --test --experimental-test-coverage tests/shot_model.test.js` passed
  12/12 tests. `tools/shot_model.js` measured 95.06% line, 78.68% branch,
  and 86.30% function coverage; aggregate coverage remained above 80% on all
  reported axes.
- The dashboard's inline JavaScript compiled, and the deterministic bank QA
  view rendered the rear-wall plane, curved segments, contact marker, bank
  count, and `bank-predicted` trace without visible layout breakage.
- `PYTHONDONTWRITEBYTECODE=1 python3 -m unittest tests.test_viz_server` passed
  3/3 tests.
- Against the live 4x4/60 Hz rig, recorded frames advanced in lockstep with
  parsed frames, parse errors remained zero, and the session contained the
  unchanged detector configuration posted through `/config`.

## Known physical gap

These are analytic and synthetic guarantees, not evidence that the single ToF
viewpoint observes a real wall contact. Real continuously recorded bank throws
must measure occlusion duration, post-contact reacquisition, and restitution by
object class before bank accuracy can be claimed.
