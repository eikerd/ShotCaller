# ShotCaller Next

## Product definition

ShotCaller is a clip-on trash-can gadget that reacts to a thrown object in two
phases:

1. Fire an **inbound** event as soon as a fast foreground object has a credible
   trajectory.
2. Fire **in** only after that trajectory crosses downward through the usable
   opening, otherwise fire **miss**.

The current NUCLEO-F446RE and X-NUCLEO-53L5A1 are the development rig. A final
clip should use the same VL53L5CX sensor on a small carrier, an MCU with enough
RAM for the ST firmware, an I2S audio amplifier, a speaker, and flash or SD
storage for samples.

## Can one ToF sensor do it?

One VL53L5CX is a credible way to prototype and may be sufficient for the
product when these constraints hold:

- One object is thrown at a time.
- The sensor is rigidly mounted at the rear center of a known opening.
- The empty scene is calibrated after the can is positioned.
- The item produces valid returns in at least three 60 Hz frames.
- A conservative false-miss is preferable to a false reward.

It is not full free-space radar. A single viewpoint can lose a small, dark, or
edge-grazing object; the rim can occlude the object immediately after entry;
and 4x4 mode has coarse angular cells. If real-throw scoring cannot reach the
desired reliability, the smallest robust addition is a second orthogonal ToF
sensor or a short break-beam just below the rim. That second sensor would be a
confirmation channel, not a replacement for trajectory tracking.

The VL53L5CX supports a 4x4 mode at 60 Hz, a 45-degree square field of view
(about 65 degrees diagonal), and closest-target ordering. The firmware now
uses all three product-oriented settings.

## Mount geometry

Use this coordinate system:

- The rim is the horizontal plane `y = 0`.
- The can center is `(x, z) = (0, 0)`.
- The sensor clips to the rear center at `z = -canDepth / 2`.
- Positive `y` is above the rim and positive `z` points across the opening.

The lens should sit 25-50 mm above the rim. Aim the optical axis at the far
inner rim, not straight down into the basket. For a centered mount, the first
pitch estimate is:

```text
pitchDown = atan(sensorHeightAboveRim / canDepth)
```

The dashboard computes this value. With the default 36 mm height and 240 mm
opening depth, it is 8.5 degrees down. Yaw should be zero. If the carrier is
mounted upside down or mirrored, use **Flip X** / **Flip Y** until live motion
in the raster agrees with the 3D scene.

Why this aim works:

- Upper rays see an object before it reaches the opening.
- Center rays traverse the opening and land near the far rim.
- Lower rays see the first portion of the can interior.
- Raising the lens slightly above the rim reduces immediate self-occlusion.

The 45-degree field width at range `d` is approximately
`2 * d * tan(22.5 degrees)`, or `0.83d`. At 260 mm it spans about 215 mm; one
4x4 cell spans roughly 54 mm. This is why measured can dimensions and a safe
edge margin matter more than drawing a few hand-picked “basket zones.”

## Ballistic and bank-shot model

Trajectory prediction is piecewise ballistic rather than a single straight
ray. Between contacts, each axis follows:

```text
p(t) = p0 + v0*t + 0.5*a*t^2
```

Earth gravity is the default vertical acceleration. The velocity fit removes
that known acceleration from the range observations and reports velocity at
the newest sample, so a rising lob can still be projected through its apex and
back down to the rim.

A bank surface is a plane described by a point, a normal pointing into free
space, optional bounds, normal restitution, and tangential retention. The
solver finds the earliest plane or rim contact, reflects velocity at a plane,
and continues with a fresh ballistic segment. It accepts arbitrary plane
normals and multiple surfaces; the dashboard currently exposes the most useful
physical preset, **Rear wall**, with wall-gap and restitution controls. The 3D
view renders the registered wall, curved path segments, and an amber contact
marker. An early `bank-predicted` event is included in the normal event stream.

Restitution is object-dependent: a crumpled paper ball, plastic cup, and rubber
ball do not leave a wall with the same energy. Treat the coefficient as a
calibrated class parameter, not a universal constant. The recorded sessions
must therefore include object type, direct shots, successful banks, failed
banks, and wall contacts that never return to the sensor's field of view.

The geometry model does not create visibility. With a rear-rim sensor aimed
across the opening, the actual wall contact may pass behind the lens or through
an occluded zone. The pre-contact path can predict the bank from the known wall,
and the sliding velocity window can reacquire the post-contact segment, but
real logs must establish how many frames survive that gap. A predicted bank may
trigger an anticipatory sound; it never grants the reward. `in` still requires
an observed downward crossing inside the safe aperture.

## Detection pipeline

```text
CALIBRATING -> ARMED -> TRACKING -> INTERCEPT -> IN / MISS -> COOLDOWN
```

### 1. Empty-scene baseline

Twenty-four frames are median-combined per zone. At 60 Hz this takes about
0.4 seconds. The wall, floor, can, and clip then become static background.

### 2. Foreground acquisition

A valid zone becomes foreground when it is materially nearer than its
baseline (140 mm by default). Adjacent foreground zones are grouped, and the
strongest connected group becomes one range-weighted 3D observation. The
first such observation changes the state to `TRACKING` and emits
`target-acquired`; no multi-frame delay is imposed on that hook.

### 3. Projectile confirmation

After three observations, a least-squares fit estimates `(vx, vy, vz)`. This
is more stable than a last-frame delta. At 60 Hz the third observation arrives
about 33 ms after acquisition. A speed above 650 mm/s emits `inbound` and
starts continuous rim-intercept prediction.

### 4. Outcome

The model intersects the observed path with `y = 0`. The crossing is **in**
only when it is downward and lies inside this safe ellipse:

```text
(x / (canWidth/2 - margin))^2 +
(z / (canDepth/2 - margin))^2 <= 1
```

Predictions are useful for the interface and early effects. The reward remains
conservative: it requires an observed crossing, not only a predicted one.

### 5. Cooldown

A short refractory period suppresses bounce and settling echoes. A slow hand
may briefly create a track but cannot emit inbound or an outcome because it
does not reach projectile speed.

## Event and audio contract

The browser dispatches every state-machine event on `window`:

```js
window.addEventListener("shotcaller:event", event => {
  const { type, velocity, prediction, confidence } = event.detail;
  // type: target-acquired, inbound, rim-crossed, in, miss, ...
});
```

`window.onShotCallerEvent = callback` is also supported for quick experiments.
The dashboard has loadable inbound/in/miss sample slots; built-in synthesized
sounds remain the fallback. For the standalone product, map the same event
names to an audio queue on the MCU. Do not decode audio in the ranging loop;
enqueue the sample and let DMA/I2S playback run independently.

`bank-predicted` carries the ordered collision list and full piecewise
trajectory. It is optional in a direct shot, hence the question mark in the
dashboard event rail:

```text
target-acquired -> inbound -> bank-predicted? -> rim-crossed -> in/miss
```

## What to measure next

The algorithm is unit-tested and the transport is verified, but classification
accuracy cannot be claimed until the rig is mounted and real throws are
labelled. Starting the bridge now creates an append-only NDJSON session under
`captures/sessions/` and flushes every parsed ToF frame, configuration change,
and board message immediately. Detector geometry—including wall placement and
restitution—is timestamped into that same stream whenever it changes. The
cockpit's green **recording** chip and live frame count are the pre-flight
check; **Arm system** remains locked if that recorder is unavailable.

Use this sequence:

1. Measure the opening width and depth, rim thickness, and available clip
   clearance.
2. Mount at rear center with the recommended pitch, then correct X/Y flips.
3. Confirm the green **recording** chip's frame count is advancing. Do not make
   a test throw if it is red or stalled.
4. Clear the opening and press **Arm system** to capture the baseline.
5. Record at least 30 throws: made shots, near misses, rim hits, direct shots,
   rear-wall banks, failed banks, crumpled white paper, dark objects, small
   objects, and slow drops.
6. Label every outcome in the dashboard. Tune foreground delta, minimum speed,
   rim margin, height, and pitch from disagreements.
7. Track acquisition latency, false rewards, false misses, and invalid-return
   streaks separately. Do not hide uncertain sensor visibility inside one
   aggregate accuracy number.

If a representative object regularly yields fewer than three valid frames,
software tuning has reached the limit of the single-sensor geometry.

## Current verified rig

- MCU detected over ST-LINK: STM32F446, chip ID `0x421`.
- Serial: `/dev/cu.usbmodem11203` at 921600 baud (autodetected by the tools).
- Firmware: 4x4 at 60 Hz, closest-target ordering.
- Post-flash capture: 98 complete frames, approximately 16.8 ms mean board interval,
  with 16 zones per complete frame and the UART declaration
  `target=closest`.
- Dashboard: desktop and 390 px mobile smoke-tested with no browser exceptions
  or horizontal overflow; live calibration reached `ARMED` with 16/16 valid
  zones and zero parse errors.
