"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { trial, THROWS } = require("../tools/throw_sim.js");

const CASE = { objKey: "wad", throwSpec: THROWS[Object.keys(THROWS)[0]], pitch: 8 };

test("the same trial index gives every configuration the same throw", () => {
  // The simulator exists to compare mount geometries. If each row is measured
  // against different random throws, a difference between rows can be sampling
  // noise rather than the configuration being compared -- and a row's value
  // changes when an unrelated earlier row is added or removed.
  const slow = [];
  const fast = [];
  for (let i = 0; i < 12; i += 1) {
    slow.push(trial({ ...CASE, modeKey: "8x8@15 cont", trialIndex: i }));
    fast.push(trial({ ...CASE, modeKey: "4x4@60 cont", trialIndex: i }));
  }

  const pairs = slow.map((s, i) => [s, fast[i]]).filter(([a, b]) => a && b);
  assert.ok(pairs.length >= 8, "most trials should produce a rim crossing");

  pairs.forEach(([a, b], i) => {
    assert.equal(
      a.truthIn, b.truthIn,
      `trial ${i}: the thrown object's actual fate must not depend on the `
        + "sensor mode used to watch it",
    );
    assert.ok(
      Math.abs(a.speed - b.speed) < 1e-6,
      `trial ${i}: crossing speed ${a.speed} vs ${b.speed} -- the flight is `
        + "physics, not sensing, so it must be identical across modes",
    );
  });
});

test("lead time is measured from when the detector receives a frame", () => {
  // firstSeen recorded the exposure midpoint, but the detector cannot act on a
  // frame before integration, processing and readout have delivered it. Using
  // the midpoint overstates lead by about 17 ms at 4x4/60 and 42 ms at 8x8/15,
  // which is the same order as the leads being compared.
  for (const modeKey of ["8x8@15 cont", "4x4@60 cont"]) {
    for (let i = 0; i < 20; i += 1) {
      const r = trial({ ...CASE, modeKey, trialIndex: i });
      if (!r || r.firstSeenLeadMs == null) continue;

      if (r.firstSeenLeadMs <= 0) {
        assert.equal(
          r.framesBefore, 0,
          `${modeKey} trial ${i}: no frame can be delivered before the `
            + "crossing when the first frame that saw anything arrived after it",
        );
      }
      if (r.framesBefore > 0) {
        assert.ok(
          r.firstSeenLeadMs > 0,
          `${modeKey} trial ${i}: ${r.framesBefore} frames counted before the `
            + `crossing but first-seen lead is ${r.firstSeenLeadMs} ms`,
        );
      }
    }
  }
});
