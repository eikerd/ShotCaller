(function attachShotModel(root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.ShotModel = api;
}(typeof globalThis !== "undefined" ? globalThis : this, function buildShotModel() {
  "use strict";

  const VALID_STATUSES = new Set([5, 9]);
  const STATES = Object.freeze({
    OFF: "OFF",
    CALIBRATING: "CALIBRATING",
    ARMED: "ARMED",
    TRACKING: "TRACKING",
    COOLDOWN: "COOLDOWN",
  });

  const DEFAULT_CONFIG = Object.freeze({
    canWidthMm: 260,
    canDepthMm: 240,
    sensorHeightMm: 36,
    sensorSetbackMm: 0,
    sensorOffsetXMm: 0,
    pitchDeg: 8,
    yawDeg: 0,
    fovHorizontalDeg: 45,
    fovVerticalDeg: 45,
    flipX: false,
    flipY: false,
    rimMarginMm: 18,
    baselineFrames: 24,
    foregroundDeltaMm: 140,
    trackRangeMm: 1800,
    minProjectileSpeedMmS: 650,
    velocityWindowMs: 120,
    predictionHorizonMs: 900,
    endGapMs: 85,
    cooldownMs: 700,
  });

  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  const radians = degrees => degrees * Math.PI / 180;

  function configWithDefaults(config) {
    return { ...DEFAULT_CONFIG, ...(config || {}) };
  }

  function recommendedPitchDeg(config) {
    const cfg = configWithDefaults(config);
    return Math.atan2(cfg.sensorHeightMm, cfg.canDepthMm) * 180 / Math.PI;
  }

  function sensorRayForZone(zone, edge, config) {
    const cfg = configWithDefaults(config);
    const row = Math.floor(zone / edge);
    const column = zone % edge;
    let horizontal = ((column + 0.5) / edge - 0.5) * cfg.fovHorizontalDeg;
    let vertical = (0.5 - (row + 0.5) / edge) * cfg.fovVerticalDeg;
    if (cfg.flipX) horizontal *= -1;
    if (cfg.flipY) vertical *= -1;

    let x = Math.tan(radians(horizontal));
    let y = Math.tan(radians(vertical));
    let z = 1;
    const magnitude = Math.hypot(x, y, z);
    x /= magnitude;
    y /= magnitude;
    z /= magnitude;

    // Positive pitch points the sensor down into the can. Positive yaw points
    // it toward the right side of the opening.
    const pitch = radians(cfg.pitchDeg);
    const pitchedY = y * Math.cos(pitch) - z * Math.sin(pitch);
    const pitchedZ = y * Math.sin(pitch) + z * Math.cos(pitch);
    const yaw = radians(cfg.yawDeg);
    const worldX = x * Math.cos(yaw) + pitchedZ * Math.sin(yaw);
    const worldZ = -x * Math.sin(yaw) + pitchedZ * Math.cos(yaw);

    return { x: worldX, y: pitchedY, z: worldZ };
  }

  function zoneToWorld(zone, edge, distanceMm, config) {
    const cfg = configWithDefaults(config);
    const ray = sensorRayForZone(zone, edge, cfg);
    return {
      x: cfg.sensorOffsetXMm + ray.x * distanceMm,
      y: cfg.sensorHeightMm + ray.y * distanceMm,
      z: -cfg.canDepthMm / 2 - cfg.sensorSetbackMm + ray.z * distanceMm,
    };
  }

  function estimateVelocity(samples) {
    if (!samples || samples.length < 2) return null;
    const meanT = samples.reduce((sum, sample) => sum + sample.t, 0) / samples.length;
    const denominator = samples.reduce((sum, sample) => {
      const dt = sample.t - meanT;
      return sum + dt * dt;
    }, 0);
    if (denominator <= 0) return null;

    function slope(axis) {
      const mean = samples.reduce((sum, sample) => sum + sample.point[axis], 0) / samples.length;
      const numerator = samples.reduce((sum, sample) => (
        sum + (sample.t - meanT) * (sample.point[axis] - mean)
      ), 0);
      return numerator / denominator * 1000;
    }

    const velocity = { x: slope("x"), y: slope("y"), z: slope("z") };
    velocity.speed = Math.hypot(velocity.x, velocity.y, velocity.z);
    return velocity;
  }

  function pointInsideRim(point, config) {
    const cfg = configWithDefaults(config);
    const radiusX = Math.max(1, cfg.canWidthMm / 2 - cfg.rimMarginMm);
    const radiusZ = Math.max(1, cfg.canDepthMm / 2 - cfg.rimMarginMm);
    const normalized = (point.x / radiusX) ** 2 + (point.z / radiusZ) ** 2;
    return { inside: normalized <= 1, normalized, clearance: 1 - Math.sqrt(normalized) };
  }

  function predictRimIntercept(point, velocity, config) {
    const cfg = configWithDefaults(config);
    if (!point || !velocity || velocity.y >= -1) return null;
    const seconds = -point.y / velocity.y;
    if (seconds < 0 || seconds * 1000 > cfg.predictionHorizonMs) return null;
    const intercept = {
      x: point.x + velocity.x * seconds,
      y: 0,
      z: point.z + velocity.z * seconds,
    };
    const rim = pointInsideRim(intercept, cfg);
    return {
      point: intercept,
      tMs: Math.round(seconds * 1000),
      inside: rim.inside,
      normalized: rim.normalized,
      clearance: rim.clearance,
    };
  }

  function segmentRimCrossing(previous, current, config) {
    if (!previous || !current || previous.y <= 0 || current.y > 0 || current.y >= previous.y) {
      return null;
    }
    const alpha = previous.y / (previous.y - current.y);
    const point = {
      x: previous.x + (current.x - previous.x) * alpha,
      y: 0,
      z: previous.z + (current.z - previous.z) * alpha,
    };
    return { point, alpha, ...pointInsideRim(point, config) };
  }

  function median(values) {
    if (!values.length) return null;
    const ordered = values.slice().sort((a, b) => a - b);
    const middle = Math.floor(ordered.length / 2);
    return ordered.length % 2
      ? ordered[middle]
      : (ordered[middle - 1] + ordered[middle]) / 2;
  }

  function connectedComponents(zones, edge) {
    const remaining = new Set(zones);
    const components = [];
    while (remaining.size) {
      const seed = remaining.values().next().value;
      remaining.delete(seed);
      const component = [seed];
      const queue = [seed];
      while (queue.length) {
        const zone = queue.shift();
        const row = Math.floor(zone / edge);
        const column = zone % edge;
        for (let dr = -1; dr <= 1; dr += 1) {
          for (let dc = -1; dc <= 1; dc += 1) {
            if (dr === 0 && dc === 0) continue;
            const rr = row + dr;
            const cc = column + dc;
            const neighbor = rr * edge + cc;
            if (rr >= 0 && rr < edge && cc >= 0 && cc < edge && remaining.has(neighbor)) {
              remaining.delete(neighbor);
              component.push(neighbor);
              queue.push(neighbor);
            }
          }
        }
      }
      components.push(component);
    }
    return components;
  }

  class FrameProjector {
    constructor(config) {
      this.config = configWithDefaults(config);
      this.reset();
    }

    setConfig(config) {
      const old = this.config;
      this.config = configWithDefaults({ ...old, ...(config || {}) });
    }

    reset(edge) {
      this.edge = edge || null;
      this.baselineSamples = [];
      this.baseline = null;
      this.ready = false;
    }

    addBaselineFrame(frame) {
      if (!frame || !Number.isInteger(frame.edge)) {
        return { ready: false, progress: 0 };
      }
      if (this.edge && frame.edge !== this.edge) this.reset(frame.edge);
      if (!this.edge) this.edge = frame.edge;
      this.baselineSamples.push(frame);
      const required = Math.max(1, Math.round(this.config.baselineFrames));
      if (this.baselineSamples.length >= required) {
        const zoneCount = frame.edge * frame.edge;
        this.baseline = Array.from({ length: zoneCount }, (_, zone) => median(
          this.baselineSamples
            .filter(sample => VALID_STATUSES.has(sample.s[zone]))
            .map(sample => sample.d[zone])
            .filter(Number.isFinite),
        ));
        this.baselineSamples = this.baselineSamples.slice(-required);
        this.ready = true;
      }
      return {
        ready: this.ready,
        progress: Math.min(1, this.baselineSamples.length / required),
      };
    }

    observationForFrame(frame) {
      if (!this.ready || !frame || frame.edge !== this.edge || !this.baseline) return null;
      const candidates = [];
      for (let zone = 0; zone < frame.d.length; zone += 1) {
        const distance = frame.d[zone];
        const background = this.baseline[zone];
        if (!VALID_STATUSES.has(frame.s[zone]) || !Number.isFinite(background)) continue;
        const delta = background - distance;
        if (delta < this.config.foregroundDeltaMm || distance > this.config.trackRangeMm) continue;
        candidates.push({
          zone,
          distance,
          delta,
          signal: Number.isFinite(frame.sig[zone]) ? frame.sig[zone] : 0,
        });
      }
      if (!candidates.length) return null;

      const byZone = new Map(candidates.map(candidate => [candidate.zone, candidate]));
      const components = connectedComponents(candidates.map(candidate => candidate.zone), frame.edge);
      const best = components
        .map(zones => ({
          zones,
          score: zones.reduce((sum, zone) => sum + byZone.get(zone).delta, 0),
        }))
        .sort((a, b) => b.score - a.score)[0];
      const selected = best.zones.map(zone => byZone.get(zone));
      const weighted = selected.map(candidate => ({
        ...candidate,
        weight: candidate.delta * (1 + Math.log1p(candidate.signal) * 0.08),
        point: zoneToWorld(candidate.zone, frame.edge, candidate.distance, this.config),
      }));
      const totalWeight = weighted.reduce((sum, candidate) => sum + candidate.weight, 0);
      const point = { x: 0, y: 0, z: 0 };
      weighted.forEach(candidate => {
        point.x += candidate.point.x * candidate.weight / totalWeight;
        point.y += candidate.point.y * candidate.weight / totalWeight;
        point.z += candidate.point.z * candidate.weight / totalWeight;
      });
      const averageDelta = selected.reduce((sum, candidate) => sum + candidate.delta, 0) / selected.length;
      const averageDistance = selected.reduce((sum, candidate) => sum + candidate.distance, 0) / selected.length;
      const confidence = clamp(
        0.28 + Math.min(3, selected.length) * 0.12 + Math.min(1, averageDelta / 450) * 0.34,
        0,
        0.98,
      );

      return {
        t: frame.t,
        point,
        zones: best.zones.slice().sort((a, b) => a - b),
        primaryZone: selected.slice().sort((a, b) => b.delta - a.delta)[0].zone,
        distanceMm: averageDistance,
        foregroundDeltaMm: averageDelta,
        confidence,
        frame,
      };
    }
  }

  class ShotDetector {
    constructor(config, onEvent) {
      this.config = configWithDefaults(config);
      this.onEvent = typeof onEvent === "function" ? onEvent : () => {};
      this.projector = new FrameProjector(this.config);
      this.state = STATES.OFF;
      this.track = null;
      this.cooldownUntil = 0;
      this.lastEvent = null;
    }

    setConfig(config) {
      this.config = configWithDefaults({ ...this.config, ...(config || {}) });
      this.projector.setConfig(this.config);
    }

    _emit(type, detail) {
      const event = { type, state: this.state, ...(detail || {}) };
      this.lastEvent = event;
      this.onEvent(event);
      return event;
    }

    start(options) {
      const calibrate = !options || options.calibrate !== false;
      this.track = null;
      this.cooldownUntil = 0;
      if (calibrate) {
        this.projector.reset();
        this.state = STATES.CALIBRATING;
        this._emit("calibrating", { progress: 0 });
      } else {
        this.state = STATES.ARMED;
        this._emit("armed");
      }
      return this.state;
    }

    stop() {
      this.state = STATES.OFF;
      this.track = null;
      this._emit("off");
    }

    recalibrate() {
      this.projector.reset();
      this.track = null;
      this.state = STATES.CALIBRATING;
      this._emit("calibrating", { progress: 0 });
    }

    ingestFrame(frame) {
      if (this.state === STATES.OFF) return [];
      if (this.state === STATES.CALIBRATING) {
        const result = this.projector.addBaselineFrame(frame);
        this._emit("calibration-progress", result);
        if (result.ready) {
          this.state = STATES.ARMED;
          this._emit("armed", { baselineZones: this.projector.baseline.filter(Number.isFinite).length });
        }
        return [];
      }
      const observation = this.projector.observationForFrame(frame);
      return this.ingestObservation(observation, frame);
    }

    ingestObservation(observation, timing) {
      if (this.state === STATES.OFF || this.state === STATES.CALIBRATING) return [];
      const now = observation && Number.isFinite(observation.t)
        ? observation.t
        : timing && Number.isFinite(timing.t) ? timing.t : 0;

      if (this.state === STATES.COOLDOWN) {
        if (now < this.cooldownUntil) return [];
        this.state = STATES.ARMED;
        this._emit("armed");
      }

      if (!observation) {
        if (this.state === STATES.TRACKING && now - this.track.lastSeen >= this.config.endGapMs) {
          this._finishTrack(now);
        }
        return [];
      }

      if (this.state === STATES.ARMED) {
        this.state = STATES.TRACKING;
        this.track = {
          t0: now,
          lastSeen: now,
          samples: [],
          frames: [],
          projectile: false,
          inboundAt: null,
          crossing: null,
          prediction: null,
          velocity: null,
          peakSpeed: 0,
          minDistance: Infinity,
        };
        this._emit("target-acquired", { t: now, observation });
      }

      if (this.state !== STATES.TRACKING) return [];
      const track = this.track;
      const previous = track.samples.at(-1);
      track.samples.push(observation);
      if (observation.frame) track.frames.push(observation.frame);
      track.lastSeen = now;
      if (Number.isFinite(observation.distanceMm)) {
        track.minDistance = Math.min(track.minDistance, observation.distanceMm);
      }

      const cutoff = now - this.config.velocityWindowMs;
      const velocitySamples = track.samples.filter(sample => sample.t >= cutoff);
      if (velocitySamples.length >= 3) {
        track.velocity = estimateVelocity(velocitySamples);
        if (track.velocity) {
          track.peakSpeed = Math.max(track.peakSpeed, track.velocity.speed);
          track.prediction = predictRimIntercept(observation.point, track.velocity, this.config);
          if (!track.projectile && track.velocity.speed >= this.config.minProjectileSpeedMmS) {
            track.projectile = true;
            track.inboundAt = now;
            this._emit("inbound", {
              t: now,
              latencyMs: now - track.t0,
              velocity: track.velocity,
              prediction: track.prediction,
              track,
            });
          }
        }
      }

      if (!track.crossing && previous) {
        const crossing = segmentRimCrossing(previous.point, observation.point, this.config);
        if (crossing) {
          track.crossing = { ...crossing, t: now };
          this._emit("rim-crossed", {
            t: now,
            inside: crossing.inside,
            point: crossing.point,
            clearance: crossing.clearance,
            track,
          });
        }
      }
      return [];
    }

    _finishTrack(now) {
      const track = this.track;
      this.track = null;
      if (!track || !track.projectile) {
        this.state = STATES.ARMED;
        return;
      }

      const type = track.crossing && track.crossing.inside ? "in" : "miss";
      const observationConfidence = track.samples.reduce(
        (sum, sample) => sum + (Number.isFinite(sample.confidence) ? sample.confidence : 0.5),
        0,
      ) / Math.max(1, track.samples.length);
      const confidence = clamp(
        (track.crossing ? 0.58 : 0.35) + observationConfidence * (track.crossing ? 0.4 : 0.3),
        0,
        0.99,
      );
      this.state = this.config.cooldownMs > 0 ? STATES.COOLDOWN : STATES.ARMED;
      this.cooldownUntil = now + this.config.cooldownMs;
      this._emit(type, {
        t: now,
        confidence,
        latencyMs: track.inboundAt == null ? null : track.inboundAt - track.t0,
        intercept: track.crossing || track.prediction,
        track,
      });
    }

    snapshot() {
      return {
        state: this.state,
        track: this.track,
        baselineReady: this.projector.ready,
        lastEvent: this.lastEvent,
      };
    }
  }

  return {
    DEFAULT_CONFIG,
    STATES,
    VALID_STATUSES,
    FrameProjector,
    ShotDetector,
    estimateVelocity,
    pointInsideRim,
    predictRimIntercept,
    recommendedPitchDeg,
    segmentRimCrossing,
    sensorRayForZone,
    zoneToWorld,
  };
}));
