(function attachShotDemo(root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.ShotDemo = api;
}(typeof globalThis !== "undefined" ? globalThis : this, function buildShotDemo() {
  "use strict";

  function sensorModeForEdge(edge) {
    if (edge !== 4 && edge !== 8) throw new RangeError("edge must be 4 or 8");
    return { edge, hz: edge === 4 ? 60 : 15 };
  }

  function syntheticSensorFrame(edge, id, activeZones) {
    const mode = sensorModeForEdge(edge);
    const foreground = new Set(activeZones || []);
    const zoneCount = edge * edge;
    return {
      id,
      t: Math.round(id * 1000 / mode.hz),
      rx: Date.now() / 1000,
      edge,
      hz: mode.hz,
      d: Array.from({ length: zoneCount }, (_, index) => (
        foreground.has(index) ? 560 : 1350
      )),
      s: Array(zoneCount).fill(5),
      sig: Array.from({ length: zoneCount }, (_, index) => (
        foreground.has(index) ? 42 : 18
      )),
    };
  }

  return { sensorModeForEdge, syntheticSensorFrame };
}));
