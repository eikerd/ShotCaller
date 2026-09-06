"use strict";
// Physics + sensor simulation feeding synthetic VL53L5CX frames into the real ShotDetector.
// Frame: x lateral, y up (rim plane y=0), z forward toward the thrower. Sensor at rear rim center.
const { ShotDetector, DEFAULT_CONFIG, sensorRayForZone } = require(__dirname + "/shot_model.js");

const G = 9810, RHO_AIR = 1.2e-9; // mm/s^2, kg/mm^3
const OBJECTS = {
  wad:  { name: "paper wad 5 g r25",   mass: 0.005, radius: 25, cd: 0.5, refl: 0.85, flicker: 0.1 },
  can:  { name: "empty can 15 g r40",  mass: 0.015, radius: 40, cd: 0.8, refl: 0.20, flicker: 0.6 },
};
const MODES = {
  "8x8@15 cont":  { edge: 8, hz: 15, integ: 1000 / 15, thresh: 0.035, sigma0: 6 },
  "4x4@60 cont":  { edge: 4, hz: 60, integ: 1000 / 60, thresh: 0.14, sigma0: 12 },
  "4x4@60 auto5": { edge: 4, hz: 60, integ: 5,         thresh: 0.46, sigma0: 20 },
};
const PROC_MS = 1, READOUT_MS = Number(process.env.READOUT_MS || 8);
const CAN = { hw: DEFAULT_CONFIG.canWidthMm / 2, hd: DEFAULT_CONFIG.canDepthMm / 2, depth: 600 };
const SENSOR = { x: 0, y: DEFAULT_CONFIG.sensorHeightMm, z: -CAN.hd };

let seed = 12345;
const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const randn = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());

// ---- background scene -------------------------------------------------------
function planeHit(o, d, axis, value, within) {
  if (Math.abs(d[axis]) < 1e-9) return Infinity;
  const t = (value - o[axis]) / d[axis];
  if (t <= 0) return Infinity;
  const p = { x: o.x + d.x * t, y: o.y + d.y * t, z: o.z + d.z * t };
  return within(p) ? t : Infinity;
}
function backgroundDistance(o, d) {
  const inCanY = p => p.y <= 0 && p.y >= -CAN.depth;
  const ts = [
    planeHit(o, d, "z", CAN.hd, p => inCanY(p) && Math.abs(p.x) <= CAN.hw),
    planeHit(o, d, "x", CAN.hw, p => inCanY(p) && Math.abs(p.z) <= CAN.hd),
    planeHit(o, d, "x", -CAN.hw, p => inCanY(p) && Math.abs(p.z) <= CAN.hd),
    planeHit(o, d, "y", -CAN.depth, p => Math.abs(p.x) <= CAN.hw && Math.abs(p.z) <= CAN.hd),
    planeHit(o, d, "y", -700, () => true),   // room floor
    planeHit(o, d, "y", 1800, () => true),   // ceiling
    planeHit(o, d, "z", 2500, () => true),   // far wall
    planeHit(o, d, "x", 2000, () => true), planeHit(o, d, "x", -2000, () => true),
  ];
  return Math.min(4000, ...ts);
}
function sphereHit(o, d, c, r) {
  const ox = o.x - c.x, oy = o.y - c.y, oz = o.z - c.z;
  const b = ox * d.x + oy * d.y + oz * d.z;
  const cc = ox * ox + oy * oy + oz * oz - r * r;
  const disc = b * b - cc;
  if (disc < 0) return Infinity;
  const t = -b - Math.sqrt(disc);
  return t > 0 ? t : Infinity;
}
function insideOpening(p) { return (p.x / CAN.hw) ** 2 + (p.z / CAN.hd) ** 2 <= 1; }

// ---- ballistics with drag ---------------------------------------------------
function flyTo(obj, start, target, angleDeg) {
  const area = Math.PI * obj.radius ** 2;            // mm^2
  const kOverM = 0.5 * RHO_AIR * obj.cd * area / obj.mass; // 1/mm
  const dx = target.x - start.x, dz = target.z - start.z;
  const horiz = Math.hypot(dx, dz);
  const dir = { x: dx / horiz, z: dz / horiz };
  const ang = angleDeg * Math.PI / 180;
  function run(speed, record) {
    let p = { ...start }, v = { x: speed * Math.cos(ang) * dir.x, y: speed * Math.sin(ang), z: speed * Math.cos(ang) * dir.z };
    const dt = 0.0005, path = [];
    let t = 0, crossing = null;
    while (t < 3 && p.y > -CAN.depth) {
      if (record) path.push({ t: t * 1000, x: p.x, y: p.y, z: p.z, vx: v.x, vy: v.y, vz: v.z });
      const sp = Math.hypot(v.x, v.y, v.z);
      const ax = -kOverM * sp * v.x, ay = -G - kOverM * sp * v.y, az = -kOverM * sp * v.z;
      const np = { x: p.x + v.x * dt, y: p.y + v.y * dt, z: p.z + v.z * dt };
      if (p.y > 0 && np.y <= 0 && !crossing) {
        const a = p.y / (p.y - np.y);
        crossing = { t: (t + a * dt) * 1000, x: p.x + (np.x - p.x) * a, z: p.z + (np.z - p.z) * a, speed: sp, descentDeg: Math.atan2(-v.y, Math.hypot(v.x, v.z)) * 180 / Math.PI };
      }
      if (crossing && !insideOpening(crossing) && np.y <= 0) break; // miss: lands outside, stops at rim level
      if (crossing && insideOpening(crossing) && (Math.abs(np.x) > CAN.hw || Math.abs(np.z) > CAN.hd)) break; // hit inner wall
      p = np; v = { x: v.x + ax * dt, y: v.y + ay * dt, z: v.z + az * dt }; t += dt;
    }
    return { path, crossing };
  }
  let lo = 500, hi = 20000;
  for (let i = 0; i < 40; i += 1) {
    const mid = (lo + hi) / 2;
    const r = run(mid, false);
    const landZ = r.crossing ? r.crossing.z * dir.z + r.crossing.x * dir.x : -1e9; // along-throw distance
    const wantZ = target.z * dir.z + target.x * dir.x;
    if (landZ < wantZ) lo = mid; else hi = mid;
  }
  const res = run((lo + hi) / 2, true);
  res.launchSpeed = (lo + hi) / 2;
  return res;
}
function posAt(path, tMs) {
  const i = Math.min(path.length - 1, Math.max(0, Math.round(tMs / 0.5)));
  return path[i];
}

// ---- sensor frame synthesis -------------------------------------------------
function buildZoneRays(edge, cfg) {
  const rays = [];
  const sub = 3;
  for (let zone = 0; zone < edge * edge; zone += 1) {
    const row = Math.floor(zone / edge), col = zone % edge;
    const list = [];
    for (let i = 0; i < sub; i += 1) for (let j = 0; j < sub; j += 1) {
      // fractional zone index -> pretend a finer grid
      const fine = edge * sub;
      const fz = (row * sub + i) * fine + (col * sub + j);
      const d = sensorRayForZone(fz, fine, cfg);
      list.push({ d, bg: backgroundDistance(SENSOR, d) });
    }
    rays.push(list);
  }
  return rays;
}
function synthFrame(rays, mode, path, tEnd, obj, id, cfg) {
  const edge = mode.edge, zones = edge * edge;
  const d = new Array(zones), s = new Array(zones), sig = new Array(zones);
  const tSteps = 6;
  const flick = Math.exp(randn() * obj.flicker);
  for (let zone = 0; zone < zones; zone += 1) {
    let hits = 0, sumD = 0, samples = 0, bgMean = 0;
    for (const r of rays[zone]) {
      bgMean += r.bg;
      for (let k = 0; k < tSteps; k += 1) {
        const t = tEnd - mode.integ + (k + 0.5) * mode.integ / tSteps;
        samples += 1;
        if (t < 0 || t > path.at(-1).t) continue;
        const p = posAt(path, t);
        if (p.y < 0 && !insideOpening(p)) continue; // outside can below rim: occluded
        const h = sphereHit(SENSOR, r.d, p, obj.radius);
        if (h < r.bg) { hits += 1; sumD += h; }
      }
    }
    bgMean /= rays[zone].length;
    const c = hits / samples;
    const dObj = hits ? sumD / hits : 0;
    const strength = hits ? c * obj.refl * flick * (1000 / dObj) ** 2 : 0;
    if (hits && strength >= mode.thresh) {
      const sigma = Math.min(60, mode.sigma0 / Math.sqrt(Math.min(1, c * obj.refl * flick / 0.85)));
      let reported = dObj;
      if (bgMean - dObj < 250) reported = c * dObj + (1 - c) * bgMean; // merged peaks
      d[zone] = Math.round(reported + randn() * sigma); s[zone] = 5; sig[zone] = Math.round(strength * 100);
    } else {
      d[zone] = Math.round(bgMean + randn() * 5); s[zone] = bgMean >= 4000 ? 255 : 5; sig[zone] = 20;
    }
  }
  return { id, t: Math.round(tEnd + PROC_MS + READOUT_MS), rx: 0, edge, hz: mode.hz, d, s, sig };
}

// ---- one trial ----------------------------------------------------------------
function trial({ objKey, modeKey, pitch, throwSpec }) {
  const obj = OBJECTS[objKey], mode = MODES[modeKey];
  const cfg = { ...DEFAULT_CONFIG, pitchDeg: pitch, foregroundDeltaMm: Number(process.env.FG || DEFAULT_CONFIG.foregroundDeltaMm) };
  const rays = buildZoneRays(mode.edge, cfg);
  const start = { x: throwSpec.x0 + randn() * 60, y: throwSpec.h + randn() * 80, z: throwSpec.d + randn() * 150 };
  const target = { x: throwSpec.tx + randn() * 40, z: throwSpec.tz + randn() * 40 };
  const flight = flyTo(obj, start, target, throwSpec.angle + randn() * 5);
  if (!flight.crossing) return null;
  const events = [];
  const det = new ShotDetector(cfg, e => events.push(e));
  det.start();
  const period = 1000 / mode.hz;
  const emptyPath = [{ t: 0, x: 0, y: 5000, z: 0 }];
  let id = 0;
  for (let i = 0; i < DEFAULT_CONFIG.baselineFrames; i += 1) {
    const f = synthFrame(rays, mode, emptyPath, -3000 + i * period, obj, id++, cfg);
    det.ingestFrame(f);
  }
  const frames = [];
  let firstSeen = null, zonesSeen = new Set(), detectedFrames = 0, zonesPerFrame = [];
  const tLast = flight.path.at(-1).t;
  const phase = rand() * period;
  for (let tEnd = phase; tEnd < tLast + 400; tEnd += period) {
    const f = synthFrame(rays, mode, flight.path, tEnd, obj, id++, cfg);
    frames.push(f);
    const objZones = f.sig.map((v, z) => (v !== 20 ? z : -1)).filter(z => z >= 0);
    if (objZones.length) {
      detectedFrames += 1; zonesPerFrame.push(objZones.length); objZones.forEach(z => zonesSeen.add(z));
      if (firstSeen == null) firstSeen = tEnd - mode.integ / 2;
    }
    det.ingestFrame(f);
    if (process.env.DEBUG && objZones.length) {
      const tp = tEnd - mode.integ / 2; const p = posAt(flight.path, tp);
      const snap = det.snapshot(); const last = snap.track && snap.track.samples.at(-1);
      console.log(`t=${f.t} true@${tp.toFixed(0)}ms xyz=${p.x.toFixed(0)},${p.y.toFixed(0)},${p.z.toFixed(0)} zones=${objZones.join(",")} d=${objZones.map(z=>f.d[z]).join(",")} obs=${last ? `${last.point.x.toFixed(0)},${last.point.y.toFixed(0)},${last.point.z.toFixed(0)}` : "-"} state=${snap.state}`);
    }
  }
  if (process.env.DEBUG) { console.log("crossing", JSON.stringify(flight.crossing), "launch", flight.launchSpeed.toFixed(0)); events.forEach(e => console.log("  event", e.type, "t=", e.t, e.velocity ? `speed=${e.velocity.speed.toFixed(0)}` : "", e.point ? `pt=${e.point.x.toFixed(0)},${e.point.y.toFixed(0)},${e.point.z.toFixed(0)} inside=${e.inside}` : "")); }
  const cross = flight.crossing;
  const truthIn = insideOpening(cross);
  const ev = type => events.find(e => e.type === type);
  const verdict = ev("in") ? "in" : ev("miss") ? "miss" : "none";
  const inbound = ev("inbound");
  const predPoint = inbound && inbound.prediction && inbound.prediction.point;
  const framesBefore = frames.filter(f => f.sig.some(v => v !== 20) && (f.t - PROC_MS - READOUT_MS - mode.integ / 2) < cross.t).length;
  return {
    speed: cross.speed, descent: cross.descentDeg, truthIn, verdict,
    correct: verdict === (truthIn ? "in" : "miss"),
    firstSeenLeadMs: firstSeen == null ? null : cross.t - firstSeen,
    framesBefore, detectedFrames, zonesSeen: zonesSeen.size, meanZones: zonesPerFrame.length ? zonesPerFrame.reduce((a, b) => a + b) / zonesPerFrame.length : 0,
    acquiredLeadMs: ev("target-acquired") ? cross.t - ev("target-acquired").t : null,
    inboundLeadMs: inbound ? cross.t - inbound.t : null,
    velErrPct: inbound ? (inbound.velocity.speed - cross.speed) / cross.speed * 100 : null,
    predErrMm: predPoint ? Math.hypot(predPoint.x - cross.x, predPoint.z - cross.z) : null,
    verdictDelayMs: verdict !== "none" ? ev(verdict).t - cross.t : null,
  };
}

const THROWS = {
  "lob 1.0m":   { d: 1000, h: 500, x0: 0, angle: 35, tx: 0, tz: 0 },
  "lob 2.0m":   { d: 2000, h: 500, x0: 0, angle: 40, tx: 0, tz: 0 },
  "lob 3.0m":   { d: 3000, h: 500, x0: 0, angle: 45, tx: 0, tz: 0 },
  "hard 2.5m":  { d: 2500, h: 400, x0: 0, angle: 12, tx: 0, tz: 0 },
  "miss long":  { d: 2000, h: 500, x0: 0, angle: 40, tx: 0, tz: 230 },
  "miss side":  { d: 2000, h: 500, x0: 0, angle: 40, tx: 200, tz: 0 },
  "side lob 2m":  { d: 0, h: 500, x0: 2000, angle: 40, tx: 0, tz: 0 },
  "side hard 2m": { d: 0, h: 400, x0: 2000, angle: 12, tx: 0, tz: 0 },
  "rear-side lob": { d: -1400, h: 500, x0: 1400, angle: 40, tx: 0, tz: 0 },
};
const N = Number(process.env.N || 20);
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const fmt = (v, p = 0) => Number.isFinite(v) ? v.toFixed(p) : "-";
const pitches = (process.env.PITCH || "8,0,-10,-20").split(",").map(Number);
const objs = (process.env.OBJ || "wad,can").split(",");
const modes = (process.env.MODES || Object.keys(MODES).join("|")).split("|");
const throwsSel = (process.env.THROWS || Object.keys(THROWS).join("|")).split("|");

console.log("pitch | mode | object | throw | speed m/s | descent° | seen% | frames pre-cross | zones/frame | zones total | first-seen lead | inbound lead | vel err% | pred err mm | verdict ok% | verdict delay");
for (const pitch of pitches) for (const modeKey of modes) for (const objKey of objs) for (const throwKey of throwsSel) {
  const rows = [];
  for (let i = 0; i < N; i += 1) { const r = trial({ objKey, modeKey, pitch, throwSpec: THROWS[throwKey] }); if (r) rows.push(r); }
  const num = k => rows.map(r => r[k]).filter(Number.isFinite);
  console.log([pitch, modeKey, objKey, throwKey,
    fmt(mean(num("speed")) / 1000, 1), fmt(mean(num("descent"))),
    fmt(100 * rows.filter(r => r.detectedFrames > 0).length / rows.length),
    fmt(mean(num("framesBefore")), 1), fmt(mean(num("meanZones")), 1), fmt(mean(num("zonesSeen")), 1),
    fmt(mean(num("firstSeenLeadMs"))), `${fmt(mean(num("inboundLeadMs")))} (${num("inboundLeadMs").length}/${rows.length})`,
    fmt(mean(num("velErrPct").map(Math.abs))), fmt(mean(num("predErrMm"))),
    fmt(100 * rows.filter(r => r.correct).length / rows.length), fmt(mean(num("verdictDelayMs"))),
  ].join(" | "));
}
