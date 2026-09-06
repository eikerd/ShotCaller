"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(
  path.join(__dirname, "..", "tools", "viz.html"),
  "utf8",
);

test("production dashboard is live-only and starts with an 8x8 raster", () => {
  assert.doesNotMatch(html, /simulationConsole|RUN MAKE|RUN MISS|RUN BANK/);
  assert.doesNotMatch(html, /DEMO MAKE|DEMO MISS|DEMO BANK/);
  assert.doesNotMatch(html, /query\.has\("qa"\)|activateQaMode|syntheticSensorFrame/);
  assert.match(html, /VL53L5CX · closest target · 8×8\/15/);
  assert.match(html, /buildZones\(8\)/);
});

test("live sensor-mode clicks always expose request, acknowledgment, or failure", () => {
  assert.match(html, /id="sensorModeStatus"[^>]*aria-live="polite"/);
  assert.match(html, /function requestSensorMode\(edge\)/);
  assert.match(html, /REQUESTING.*×.*…/);
  assert.match(html, /NO SENSOR ACK/);
  assert.match(html, /function confirmSensorMode\(config\)/);
  assert.match(html, /payload\.type==="config"\)\{onBoardConfig\(payload\.config\)/);
  assert.match(html, /function onBoardConfig\(config\)\{[\s\S]*?confirmSensorMode\(config\)/);
});

test("dashboard never calls an open event stream a live sensor", () => {
  assert.doesNotMatch(html, /events\.onopen=.*linkText.*streaming/);
  assert.match(html, /status\.connected\?"sensor live":"no sensor data"/);
});

test("dashboard distinguishes a live but disarmed sensor from a dead transport", () => {
  assert.match(html, /runtime\.connected\?"DISARMED":"SENSOR OFFLINE"/);
  assert.match(html, /status\.transport/);
});

// The recorder gate decides whether the operator is allowed to throw. Pull the
// decision itself out of the page and exercise it, rather than asserting that
// some text appears in the source.
function extract(name) {
  const match = html.match(new RegExp(`function ${name}\\([^)]*\\)\\{[\\s\\S]*?\\n`, "m"));
  assert.ok(match, `viz.html must define a testable ${name}()`);
  // eslint-disable-next-line no-eval
  return eval(`(${match[0].trim()})`);
}

test("a recorder with zero frames is not advancing", () => {
  const advancing = extract("recorderAdvancing");

  assert.equal(
    advancing(null, { active: true, frames_recorded: 0 }),
    false,
    "the first poll has no earlier sample to compare against, so an active "
      + "recorder that has written nothing must not read as advancing",
  );
  assert.equal(advancing(null, { active: true, frames_recorded: 900 }), false);
  assert.equal(advancing(0, { active: true, frames_recorded: 0 }), false,
    "a stalled recorder repeats its count");
  assert.equal(advancing(900, { active: true, frames_recorded: 901 }), true,
    "two ordered samples with a strictly increasing count is the only pass");
  assert.equal(advancing(900, { active: false, frames_recorded: 901 }), false,
    "an inactive writer is never advancing");
  assert.equal(advancing(900, null), false);
});

test("a stale status response cannot un-arm a healthy recorder", () => {
  assert.match(
    html,
    /runtime\.statusSeq/,
    "overlapping /api/status polls must be sequenced so an older response "
      + "cannot be applied after a newer one",
  );
});

test("RECAL is gated on the recorder, exactly like ARM", () => {
  assert.match(
    html,
    /\$\("recalButton"\)\.onclick=\(\)=>\{if\(!runtime\.recording\)/,
    "RECAL enters CALIBRATING and frames alone can carry the detector to "
      + "ARMED, bypassing the ARM guard entirely",
  );
});

test("physics reaches the session log before it reaches the detector", () => {
  assert.match(
    html,
    /async function recordAndApplyConfig\(\)/,
    "config changes must go through one path that records before applying",
  );
  assert.match(
    html,
    /await fetch\("\/config",\{method:"POST"[\s\S]{0,400}?runtime\.detector\.setConfig/,
    "setConfig must come after the awaited POST, not before it",
  );
  assert.doesNotMatch(
    html,
    /setTimeout\(\(\)=>fetch\("\/config"/,
    "the debounced fire-and-forget save let the detector run physics the log "
      + "had not yet recorded",
  );
});

test("a physics change that was not recorded is surfaced, not swallowed", () => {
  assert.match(
    html,
    /result\.recorded===false|!response\.ok/,
    "the server reports whether the recorder captured the config; the "
      + "dashboard must act on that",
  );
});

test("the dashboard's script block actually parses", () => {
  // Regex assertions over the source cannot see a syntax error, and a syntax
  // error in this page's single script block stops the whole dashboard from
  // initialising. Parse it for real.
  const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
    .map(match => match[1]);
  assert.ok(blocks.length > 0, "viz.html must carry an inline script block");

  blocks.forEach((source, index) => {
    assert.doesNotThrow(
      () => new Function(`return async()=>{${source}\n}`),
      `inline script block ${index} does not parse`,
    );
  });
});

test("only a matching board reply acknowledges a sensor-mode request", () => {
  // Initial state, SWD updates and unrelated firmware commands all emit config
  // events. Treating any of them as the acknowledgement shows ACKNOWLEDGED for
  // a setting that was never applied -- which is the one thing this dashboard
  // is supposed to stop doing.
  assert.doesNotMatch(
    html,
    /payload\.type==="config"\)\{confirmSensorMode\(payload\.config\)/,
    "an unrelated config event must not clear the pending request",
  );
  assert.match(
    html,
    /function sensorModeMatchesRequest\(/,
    "the pending request must be compared against the reported configuration",
  );

  const matches = (() => {
    const source = html.match(/function sensorModeMatchesRequest\([\s\S]*?\n\}/m);
    assert.ok(source, "sensorModeMatchesRequest must be extractable");
    // eslint-disable-next-line no-eval
    return eval(`(${source[0].trim()})`);
  })();

  assert.equal(matches({ pendingEdge: 8, pendingMaxRate: false }, { res: "8", hz: "15" }), true);
  assert.equal(matches({ pendingEdge: 8, pendingMaxRate: false }, { res: "4", hz: "60" }), false,
    "a 4x4 reply does not acknowledge an 8x8 request");
  assert.equal(matches({ pendingEdge: null, pendingMaxRate: false }, { res: "8", hz: "15" }), false,
    "with nothing pending there is nothing to acknowledge");
  assert.equal(matches({ pendingEdge: null, pendingMaxRate: true }, { res: "4", hz: "60" }), true,
    "max rate at 4x4 is 60 Hz");
  assert.equal(matches({ pendingEdge: null, pendingMaxRate: true }, { res: "4", hz: "15" }), false,
    "a slower rate does not acknowledge a max-rate request");
});
