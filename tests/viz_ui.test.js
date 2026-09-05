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
  assert.match(html, /payload\.type==="config".*confirmSensorMode\(payload\.config\)/s);
});

test("dashboard never calls an open event stream a live sensor", () => {
  assert.doesNotMatch(html, /events\.onopen=.*linkText.*streaming/);
  assert.match(html, /status\.connected\?"sensor live":"no sensor data"/);
});
