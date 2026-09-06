"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DEFAULT_CONFIG,
  STATES,
  FrameProjector,
  ShotDetector,
  estimateVelocity,
  predictRimIntercept,
  recommendedPitchDeg,
  zoneToWorld,
} = require("../tools/shot_model.js");

function frame(t, distances, edge = 4) {
  return {
    id: t,
    t,
    rx: t / 1000,
    edge,
    hz: 60,
    d: distances,
    s: distances.map(() => 5),
    sig: distances.map(() => 20),
  };
}

test("mount pitch aims the optical axis from the rear sensor to the far rim", () => {
  const pitch = recommendedPitchDeg({ sensorHeightMm: 36, canDepthMm: 280 });
  assert.ok(Math.abs(pitch - 7.326) < 0.01);

  const point = zoneToWorld(7, 4, 280 / Math.cos(pitch * Math.PI / 180), {
    ...DEFAULT_CONFIG,
    canDepthMm: 280,
    sensorHeightMm: 36,
    pitchDeg: pitch,
  });

  // Zone 7 is just off the optical axis on an even grid, so the result should
  // land near (rather than exactly on) the far side of the opening.
  assert.ok(point.y < 70 && point.y > -10);
  assert.ok(point.z > 80);
});

test("velocity uses a least-squares fit instead of a noisy last-frame delta", () => {
  const samples = [
    { t: 0, point: { x: 0, y: 100, z: -20 } },
    { t: 20, point: { x: 10, y: 79, z: -10 } },
    { t: 40, point: { x: 20, y: 61, z: 0 } },
    { t: 60, point: { x: 30, y: 39, z: 10 } },
  ];
  const velocity = estimateVelocity(samples);

  assert.ok(Math.abs(velocity.x - 500) < 1);
  assert.ok(Math.abs(velocity.y + 1010) < 20);
  assert.ok(Math.abs(velocity.z - 500) < 1);
  assert.ok(velocity.speed > 1200);
});

test("rim intercept distinguishes a center make from an outside miss", () => {
  const geometry = {
    ...DEFAULT_CONFIG,
    canWidthMm: 260,
    canDepthMm: 240,
    rimMarginMm: 18,
  };
  const make = predictRimIntercept(
    { x: 10, y: 100, z: 0 },
    { x: 100, y: -1000, z: 100 },
    geometry,
  );
  const miss = predictRimIntercept(
    { x: 160, y: 100, z: 0 },
    { x: 0, y: -1000, z: 0 },
    geometry,
  );

  assert.equal(make.inside, true);
  assert.equal(make.tMs, 100);
  assert.equal(miss.inside, false);
  assert.equal(predictRimIntercept(
    { x: 0, y: 100, z: 0 },
    { x: 0, y: 100, z: 0 },
    geometry,
  ), null);
});

test("background calibration removes the static scene and isolates a nearer object", () => {
  const projector = new FrameProjector({
    ...DEFAULT_CONFIG,
    baselineFrames: 3,
    foregroundDeltaMm: 140,
  });
  const background = Array(16).fill(1000);

  assert.equal(projector.addBaselineFrame(frame(0, background)).ready, false);
  assert.equal(projector.addBaselineFrame(frame(17, background)).ready, false);
  assert.equal(projector.addBaselineFrame(frame(34, background)).ready, true);
  assert.equal(projector.observationForFrame(frame(51, background)), null);

  const withObject = background.slice();
  withObject[6] = 610;
  const observation = projector.observationForFrame(frame(68, withObject));
  assert.ok(observation);
  assert.equal(observation.zones[0], 6);
  assert.ok(observation.foregroundDeltaMm >= 380);
  assert.ok(Number.isFinite(observation.point.x));
});

test("a made shot enters tracking immediately, fires inbound early, then rewards a rim crossing", () => {
  const events = [];
  const detector = new ShotDetector({
    ...DEFAULT_CONFIG,
    minProjectileSpeedMmS: 650,
    velocityWindowMs: 120,
    endGapMs: 55,
    cooldownMs: 0,
  }, event => events.push(event));
  detector.start({ calibrate: false });

  detector.ingestObservation({ t: 0, point: { x: 0, y: 95, z: -10 }, confidence: 0.9 });
  assert.equal(detector.state, STATES.TRACKING);
  assert.equal(events.at(-1).type, "target-acquired");

  detector.ingestObservation({ t: 17, point: { x: 2, y: 65, z: -4 }, confidence: 0.9 });
  detector.ingestObservation({ t: 34, point: { x: 4, y: 28, z: 3 }, confidence: 0.9 });
  assert.ok(events.some(event => event.type === "inbound" && event.latencyMs <= 34));

  detector.ingestObservation({ t: 51, point: { x: 7, y: -12, z: 10 }, confidence: 0.9 });
  assert.ok(events.some(event => event.type === "rim-crossed" && event.inside));
  detector.ingestObservation(null, { t: 120 });

  assert.equal(events.at(-1).type, "in");
  assert.ok(events.at(-1).confidence > 0.5);
});

test("a fast path crossing outside the aperture is called a miss", () => {
  const events = [];
  const detector = new ShotDetector({
    ...DEFAULT_CONFIG,
    minProjectileSpeedMmS: 650,
    endGapMs: 50,
    cooldownMs: 0,
  }, event => events.push(event));
  detector.start({ calibrate: false });

  [
    { t: 0, point: { x: 165, y: 100, z: -20 }, confidence: 0.9 },
    { t: 17, point: { x: 166, y: 65, z: -10 }, confidence: 0.9 },
    { t: 34, point: { x: 167, y: 25, z: 0 }, confidence: 0.9 },
    { t: 51, point: { x: 168, y: -15, z: 10 }, confidence: 0.9 },
  ].forEach(observation => detector.ingestObservation(observation));
  detector.ingestObservation(null, { t: 110 });

  assert.equal(events.at(-1).type, "miss");
  assert.ok(events.some(event => event.type === "rim-crossed" && !event.inside));
});

test("a slow hand can create a track but never fires sound or a verdict", () => {
  const events = [];
  const detector = new ShotDetector({
    ...DEFAULT_CONFIG,
    minProjectileSpeedMmS: 650,
    endGapMs: 60,
    cooldownMs: 0,
  }, event => events.push(event));
  detector.start({ calibrate: false });

  for (let i = 0; i < 8; i += 1) {
    detector.ingestObservation({
      t: i * 50,
      point: { x: i, y: 80 - i, z: 0 },
      confidence: 0.8,
    });
  }
  detector.ingestObservation(null, { t: 500 });

  assert.deepEqual(
    events.filter(event => ["inbound", "in", "miss"].includes(event.type)),
    [],
  );
  assert.equal(detector.state, STATES.ARMED);
});

test("full frame ingestion calibrates before exposing the tracking hook", () => {
  const events = [];
  const detector = new ShotDetector({
    ...DEFAULT_CONFIG,
    baselineFrames: 2,
    foregroundDeltaMm: 120,
  }, event => events.push(event));
  const background = Array(16).fill(1100);
  detector.start();
  detector.ingestFrame(frame(0, background));
  assert.equal(detector.state, STATES.CALIBRATING);
  detector.ingestFrame(frame(17, background));
  assert.equal(detector.state, STATES.ARMED);

  const objectFrame = background.slice();
  objectFrame[5] = 650;
  detector.ingestFrame(frame(34, objectFrame));
  assert.equal(detector.state, STATES.TRACKING);
  assert.ok(events.some(event => event.type === "target-acquired"));
});

test("an armed detector recalibrates when the board changes resolution", () => {
  const events = [];
  const detector = new ShotDetector(
    { ...DEFAULT_CONFIG, baselineFrames: 3 },
    event => events.push(event),
  );

  detector.start();
  for (let i = 0; i < 3; i += 1) detector.ingestFrame(frame(i, Array(16).fill(1400)));
  assert.equal(detector.state, STATES.ARMED, "four-by-four baseline should arm the detector");

  // The operator clicks 8x8 while the detector is live. The board starts
  // sending 64-zone frames against a 16-zone baseline.
  events.length = 0;
  detector.ingestFrame(frame(100, Array(64).fill(1400), 8));

  assert.equal(
    detector.state,
    STATES.CALIBRATING,
    "a resolution change must send the detector back to calibration, not leave it armed against a stale baseline",
  );
  assert.ok(
    events.some(event => event.type === "calibrating"),
    "the operator must be told the baseline was invalidated",
  );

  for (let i = 0; i < 3; i += 1) detector.ingestFrame(frame(101 + i, Array(64).fill(1400), 8));
  assert.equal(detector.state, STATES.ARMED, "detector must re-arm on the new resolution");

  // And detection must actually work again on the new grid.
  const near = Array(64).fill(1400);
  near[27] = 900;
  near[28] = 900;
  const emitted = detector.ingestFrame(frame(120, near, 8));
  assert.ok(
    emitted.length > 0 || detector.state === STATES.TRACKING,
    "a foreground object on the new resolution must still open a track",
  );
});
