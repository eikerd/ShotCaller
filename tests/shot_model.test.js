"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DEFAULT_CONFIG,
  STATES,
  FrameProjector,
  ShotDetector,
  configuredSurfaces,
  estimateVelocity,
  predictTrajectory,
  predictRimIntercept,
  recommendedPitchDeg,
  reflectVelocity,
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

test("velocity fitting removes known gravity and reports velocity at the latest sample", () => {
  const gravity = { x: 0, y: -9810, z: 0 };
  const initial = { x: 250, y: -500, z: -700 };
  const samples = [0, 20, 40, 60].map(t => {
    const seconds = t / 1000;
    return {
      t,
      point: {
        x: initial.x * seconds,
        y: 240 + initial.y * seconds + 0.5 * gravity.y * seconds ** 2,
        z: initial.z * seconds,
      },
    };
  });

  const velocity = estimateVelocity(samples, gravity);

  assert.ok(Math.abs(velocity.x - 250) < 1);
  assert.ok(Math.abs(velocity.y - (initial.y + gravity.y * 0.06)) < 1);
  assert.ok(Math.abs(velocity.z + 700) < 1);
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
  assert.ok(make.tMs < 80, "gravity should bend the path to the rim sooner than a linear extrapolation");
  assert.equal(make.model, "piecewise-ballistic");
  assert.equal(miss.inside, false);
  const lob = predictRimIntercept(
    { x: 0, y: 100, z: 0 },
    { x: 0, y: 100, z: 0 },
    geometry,
  );
  assert.ok(lob, "an initially rising lob should still arc downward through the rim plane");
  assert.equal(lob.inside, true);
});

test("reflection works for an arbitrary plane normal and preserves configurable tangential motion", () => {
  const normal = { x: Math.SQRT1_2, y: 0, z: Math.SQRT1_2 };
  const incoming = { x: -800, y: -500, z: -600 };
  const reflected = reflectVelocity(incoming, normal, {
    restitution: 0.5,
    tangentialRetention: 0.8,
  });
  const incomingNormal = incoming.x * normal.x + incoming.z * normal.z;
  const outgoingNormal = reflected.x * normal.x + reflected.z * normal.z;

  assert.ok(Math.abs(outgoingNormal + incomingNormal * 0.5) < 1);
  assert.ok(reflected.y > incoming.y, "tangential velocity should be retained with damping");
});

test("piecewise ballistic prediction can bank off a rear wall before entering the rim", () => {
  const geometry = {
    ...DEFAULT_CONFIG,
    canWidthMm: 260,
    canDepthMm: 240,
    rimMarginMm: 18,
    rearWallBankEnabled: true,
    rearWallGapMm: 30,
    rearWallRestitution: 0.5,
    rearWallTangentialRetention: 0.9,
  };
  const point = { x: 0, y: 300, z: 0 };
  const velocity = { x: 0, y: -500, z: -1500 };

  const bank = predictTrajectory(point, velocity, geometry);
  const direct = predictTrajectory(point, velocity, {
    ...geometry,
    rearWallBankEnabled: false,
  });

  assert.equal(configuredSurfaces(geometry)[0].id, "rear-wall");
  assert.equal(bank.collisions.length, 1);
  assert.equal(bank.collisions[0].surfaceId, "rear-wall");
  assert.equal(bank.intercept.inside, true);
  assert.ok(bank.intercept.point.z > -120);
  assert.equal(direct.collisions.length, 0);
  assert.equal(direct.intercept.inside, false);
  assert.ok(direct.intercept.point.z < -240);
  assert.ok(bank.segments.every(segment => segment.path.length > 2));
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
