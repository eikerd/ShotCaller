# QA simulation controls TDD evidence

## Source and journey

The journey came from the reported dashboard bug: a user opening QA mode needs
obvious replay controls, a continuously rendered trajectory, and local 4x4/8x8
sensor controls that do not depend on the connected board.

## RED / GREEN

| Behavior | RED evidence | GREEN verification | Guarantee |
|---|---|---|---|
| Prominent replay controls and QA-specific sensor modes | `node --test tests/viz_ui.test.js` failed because `tools/viz_demo.js` did not exist | `node --test tests/viz_ui.test.js` | QA exposes Run Make, Run Miss, and Run Bank; 4x4/8x8 produce visible synthetic ToF frames at their real rate ceilings |
| Detector behavior remains unchanged | Not changed by this UI-only task | `node --test tests/shot_model.test.js` | Existing geometry, state-machine, and bank-shot tests remain green |
| Local bridge remains valid | Not changed until the helper asset route was added | `PYTHONDONTWRITEBYTECODE=1 python3 -m unittest tests.test_viz_server` | Session-recorder and local-server tests remain green |

## Coverage and gaps

The new helper behavior is covered by three Node tests. Browser automation was
unavailable because the local browser extension was not attached; interactive
visual verification remains separate from the passing source-level contract.
Synthetic QA does not establish physical sensor accuracy.
