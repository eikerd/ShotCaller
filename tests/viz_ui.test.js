"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(
  path.join(__dirname, "..", "tools", "viz.html"),
  "utf8",
);

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
  // The session log's claim is that it can say which physics produced each
  // prediction. Applying a change to the live detector and recording it 300 ms
  // later, best-effort, breaks exactly that.
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
  assert.doesNotMatch(
    html,
    /fetch\("\/config",\{method:"POST"[\s\S]{0,300}?\}\)\.catch\(\(\)=>\{\}\)/,
    "a failed config POST was silently discarded",
  );
  assert.match(
    html,
    /result\.recorded===false|!response\.ok/,
    "the server now reports whether the recorder captured the config; the "
      + "dashboard must act on that",
  );
});
