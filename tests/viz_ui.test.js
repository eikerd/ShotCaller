"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  sensorModeForEdge,
  syntheticSensorFrame,
} = require("../tools/viz_demo.js");

const html = fs.readFileSync(
  path.join(__dirname, "..", "tools", "viz.html"),
  "utf8",
);

test("QA mode exposes prominent, replayable simulation controls", () => {
  const engineStart = html.indexOf('<section class="panel engine"');
  const engineEnd = html.indexOf('<section class="panel viewport"');
  const engineMarkup = html.slice(engineStart, engineEnd);

  assert.match(engineMarkup, /id="simulationConsole"/);
  assert.match(engineMarkup, /id="simMake"[^>]*>RUN MAKE</);
  assert.match(engineMarkup, /id="simMiss"[^>]*>RUN MISS</);
  assert.match(engineMarkup, /id="simBank"[^>]*>RUN BANK</);
  assert.match(html, /function activateQaMode\(/);
  assert.match(html, /if\(runtime\.qaMode\).*setSyntheticSensorMode/);
  assert.match(html, /if\(query\.has\("qa"\)\).*activateQaMode.*animate\(\)/s);
});

test("synthetic sensor mode mirrors the real 4x4 and 8x8 rate limits", () => {
  assert.deepEqual(sensorModeForEdge(4), { edge: 4, hz: 60 });
  assert.deepEqual(sensorModeForEdge(8), { edge: 8, hz: 15 });
  assert.throws(() => sensorModeForEdge(6), /edge must be 4 or 8/);
});

test("synthetic sensor frame makes the detected projectile visible in the raster", () => {
  const four = syntheticSensorFrame(4, 12, [5, 6]);
  assert.equal(four.d.length, 16);
  assert.equal(four.s.length, 16);
  assert.equal(four.hz, 60);
  assert.ok(four.d[5] < four.d[0]);
  assert.ok(four.d[6] < four.d[0]);

  const eight = syntheticSensorFrame(8, 13, [27, 28, 35, 36]);
  assert.equal(eight.d.length, 64);
  assert.equal(eight.hz, 15);
  assert.ok(eight.d[27] < eight.d[0]);
});

test("live sensor-mode clicks always expose request, acknowledgment, or failure", () => {
  assert.match(html, /id="sensorModeStatus"[^>]*aria-live="polite"/);
  assert.match(html, /function requestSensorMode\(edge\)/);
  assert.match(html, /REQUESTING.*×.*…/);
  assert.match(html, /NO SENSOR ACK/);
  assert.match(html, /function confirmSensorMode\(config\)/);
  assert.match(html, /payload\.type==="config".*confirmSensorMode\(payload\.config\)/s);
});
