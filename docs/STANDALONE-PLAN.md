# ShotCaller standalone plan

Written 2026-09-06. This is the handoff for building the untethered product.
It is written for an agent that has not seen the conversation that produced
it. Read it top to bottom before doing anything. Every number in it is either
**measured** (from the bench rig, marked as such), **datasheet** (from ST
documents), or **modeled** (from `tools/throw_sim.js`, a simulation that has
not been checked against real throws). Do not promote a modeled number to a
fact. `AGENTS.md` forbids claiming physical accuracy from synthetic tests.

---

## 1. What exists today and why it is being replaced

The current rig is a NUCLEO-F446RE with an X-NUCLEO-53L5A1 shield carrying a
VL53L5CX 8x8 time-of-flight sensor. The firmware in `ShotCaller/Src/main.c`
does no trajectory work at all. It reads a frame over I2C and streams it to a
Mac over USB. All detection lives in `tools/shot_model.js` and runs inside a
browser tab served by `tools/viz_server.py`. The USB link exists only because
the detector lives on the Mac.

The owner has ruled that this must change:

- Detection runs **on the device**. No computer in the loop.
- Two device builds are wanted, in this order: **Raspberry Pi Zero 2 W** first,
  **ESP32-S3** second. Both must run the same detection logic.
- The browser becomes a **thin tuning client** that logs into the device,
  shows live performance, and edits tunables including the sensor angles. It
  must never run the detector again.
- The confirmation of "it went in" is a **cheap binary sensor on a GPIO
  pin**, such as an infrared break-beam. There is exactly one
  time-of-flight sensor in the product. That is final.
- The time-of-flight sensor sits on a **module the owner is building to
  tilt**. Its angle is dialed in, measured, or learned later, never fixed
  in code.

Compute is not a factor in any of this. The JavaScript detector costs about
one microsecond per frame on a laptop (measured by replaying 20,000 frames
from `captures/sessions/session-20260905-054301.ndjson.gz`). The sensor
delivers a frame every 16.5 ms. Every board under consideration spends well
under one percent of the frame period on the math. Choose platforms on power,
boot time, WiFi, audio, and form factor.

---

## 2. Decisions already made

Do not reopen these without the owner.

| Decision | Choice | Reason |
|---|---|---|
| Detection location | on-device | product is untethered |
| First platform | Raspberry Pi Zero 2 W | the tested JavaScript detector runs unchanged under Node, and it has WiFi; fastest path to a working unit |
| Second platform | ESP32-S3 | instant boot, microamp sleep, I2S audio, WiFi; the battery clip-on end state |
| Shared logic | one C99 core, two thin shells (section 6) | both platforms must behave identically; a C core compiles natively on ESP32 and loads into Python on the Pi through ctypes |
| Sensor count | **exactly one** time-of-flight sensor for tracking, plus a **GPIO confirmation sensor**. No second time-of-flight sensor | owner decision, final |
| Tracking sensor | VL53L5CX now, VL53L8CX for new builds, on a **tiltable module** at the rear rim center | see section 4 for the measured and modeled reasons |
| Sensor angle | **a runtime tunable, not a design constant.** The owner is building the module to tilt through all angles and will dial it in, auto-configure it, or learn it from test throws later. Thirty degrees up is the modeled starting point, nothing more | section 4.7 |
| Tracking resolution | 4x4 at 60 Hz for throws, 8x8 at 15 Hz for inspection only | 8x8 at 15 Hz yields under one usable frame per throw (modeled) |
| Confirmation sensor | infrared break-beam curtain on one GPIO. The downward multizone ToF idea was considered and **rejected** | owner decision; section 5 |
| Trigger rule | fire `inbound` on the **first fast closing motion**, arm or wad | an arm swing seen early is a feature, not noise; throws from out of view are detected by the wad alone with the same rule |
| Fail rule | `miss` only when a separated projectile was actually observed and nothing entered the can | an arm swing with nothing thrown must stay silent |
| Unseen throws | an entry with no preceding `inbound` is a **make**, graded by the confirmation sensor alone | a single sensor cannot see side throws; unseen misses stay silent |
| Trash full | a beam held broken for longer than `stuckBeamMs` plays an **"empty the trash" message** and suspends victory calls | owner instruction; never silently ignore it |
| Default branch | `main` | renamed from `master` on 2026-09-06 per the owner's global rules |

---

## 3. The physics, with sources

### 3.1 Throw envelope (modeled, bounded by the room)

The product lives in a bedroom or office no larger than 15 by 15 feet with
9 foot ceilings. That bounds every throw.

| Throw | Speed at the rim | Descent angle |
|---|---|---|
| Lob from 1 m | 3.7 m/s | about 60 degrees |
| Lob from 2 m | 4.6 m/s | about 58 degrees |
| Lob from 3 m | 5.3 m/s | about 60 degrees |
| Hard flat toss from 2.5 m | 5.5 m/s | about 32 degrees |

Objects: crumpled paper wad, about 5 g and 50 mm diameter, white, drag
coefficient 0.5. Empty aluminum can, about 15 g, treated as an 80 mm tumbling
sphere, drag coefficient 0.8, low and flickering infrared reflectance. Drag
slows the wad by about 2 m/s squared and the can by about 5 m/s squared.

### 3.2 Sensor limits (datasheet and measured)

| Fact | Value | Source |
|---|---|---|
| VL53L5CX and VL53L8CX max frame rate | 60 Hz at 4x4, 15 Hz at 8x8 | datasheet and driver; **the L8CX does not raise this** |
| Delivered rate on the bench | 60.5 Hz at 4x4, 15.1 Hz at 8x8 | measured, `HANDOFF.md` |
| Field of view | 45 by 45 degrees, 65 diagonal | datasheet |
| Zone width | 11.25 degrees at 4x4, 5.6 at 8x8 | derived |
| VL53L5CX interface | I2C only, up to 1 MHz | datasheet |
| VL53L8CX interface | I2C up to 1 MHz **or SPI up to 3 MHz** | datasheet |
| VL53L8CX I/O voltage | 1.2 V or 1.8 V only; needs a carrier with level shifters (Pololu 3419, SparkFun, ST SATEL-VL53L8CX) | datasheet |
| VL53L8CX range in 5000 lux | 2.8 m versus about 1.7 m for the L5CX | Pololu product page |
| Frame payload with all driver outputs enabled | about 1.45 KB, same at 4x4 and 8x8 | `vl53l5cx_api.h` `VL53L5CX_MAX_RESULTS_SIZE`; nothing is disabled in the current build |
| Readout time for that payload | 33 ms at 400 kHz I2C, 11 ms at 1 MHz, 3.5 ms at 3 MHz SPI | computed from byte count; **conflicts with the measured 60.5 Hz at 400 kHz, so scope the bus before trusting either number** |
| Integration in continuous mode | the full frame period, 16.5 ms at 60 Hz | driver documentation |
| Motion blur at 4.5 m/s | about 66 mm per frame in continuous mode, about 20 mm with a 5 ms autonomous integration | derived |

Only target statuses 5 and 9 are trustworthy range values (ST UM2884 table 4).

### 3.3 What the sensor sees from the rim (modeled)

The simulation places the sensor at the rear rim center, 36 mm above the rim,
uses the repo's own `sensorRayForZone` and `zoneToWorld` geometry, samples
each zone with a 3 by 3 sub-ray grid and six time steps across the
integration window, applies a detection threshold scaled by coverage,
reflectance, and inverse range squared, adds range noise, and feeds the
resulting frames into the real `ShotDetector` unmodified.

Results for a paper wad at 4x4 and 60 Hz, fifteen throws per row. "Lead" is
measured from the moment the host holds the frame to the physical rim
crossing. Negative lead means the event fired after the crossing.

| Sensor pitch | Throw | Frames before crossing | Inbound lead | Speed error | Predicted crossing error |
|---|---|---|---|---|---|
| 8 degrees down (repo default) | lob 2 m | 1.7 | -20 ms | 41 % | unusable |
| 8 degrees down | hard 2.5 m | 3.9 | +2 ms | 17 % | unusable |
| 20 degrees up | lob 2 m | 8.7 | +85 ms | 24 % | 110 mm |
| **30 degrees up** | **lob 2 m** | **10.3** | **+117 ms** | **26 %** | **95 mm** |
| 30 degrees up | hard 2.5 m | 6.7 | +69 ms | 19 % | 136 mm |
| 30 degrees up | lob 1 m | 13.5 | +180 ms | 29 % | 87 mm |
| 45 degrees up | hard 2.5 m | 0.9 | mostly never seen | | |

Findings the next agent must carry:

- The repo's default aim, down at the far inner rim, sees a throw for two to
  four frames at 100 to 300 mm range, and `inbound` fires after the object has
  already crossed. It cannot predict anything.
- Thirty degrees up sees every throw in the set, including the hard flat
  one, with 70 to 180 ms of lead. Forty-five degrees up loses flat throws
  because the bottom of the cone sits 22.5 degrees above horizontal.
- Predicted crossing error is 65 to 140 mm against an opening half-width of
  120 to 130 mm. That is enough to call a throw headed a foot wide, not one
  grazing the rim. Do not promise rim-grazer prediction.
- Pointing the sensor nearly straight up from the rear rim does **not** give
  all-round coverage. The cone over the opening is only about 100 mm wide at
  rim height. Front lobs were seen 7 percent of the time at 72 degrees up.
- A single 45 degree cone covers about plus or minus 22 degrees of forward.
  Side and rear throws produce one or two frames and no usable lead. Wider
  coverage needs a wider sensor (VL53L7CX, 60 by 60 degrees), more sensors
  yawed apart, or a lid-center mount with a bar across the opening.
- At 4x4 the wad covers one to three zones at any instant and passes through
  about 7 to 9 of the 16 over a throw. At 8x8 it passes through 20 to 28 of
  64. Zones it passes through detect white paper easily: about 6 percent of a
  zone's footprint at 600 mm clears the modeled threshold. Bare aluminum
  returns roughly a fifth of that and drops zones intermittently.

### 3.4 The make verdict fails in the model at every rim-mounted pitch

With the sensor at the rim, the existing detector never confirmed a make in
simulation, at any pitch, while it called misses correctly. Two causes:

1. Inside the can the background is the wall or floor, often within the
   140 mm `foregroundDeltaMm` threshold of the object, so the detector stops
   seeing the object before the crossing is observed. Lowering the threshold
   to 60 mm rescued only a third of makes.
2. `observationForFrame` weights zones by range delta, which favors zones
   whose background is the far wall of the room over zones where the object
   actually is. Combined with motion blur this pulls the centroid upward.

This is why confirmation moves to a separate sensor (section 5). It is also
why the labelled real throws in `captures/throws/` should be replayed to see
whether `in` ever fires on a real make before anyone trusts either the model
or the detector.

### 3.5 Where the milliseconds go (4x4 at 60 Hz, detector on the board)

| Stage | Delay |
|---|---|
| Exposure midpoint to end of frame | 8 ms |
| Sensor internal processing | about 1 ms |
| Readout over I2C at 400 kHz | 8 to 33 ms, unresolved, see 3.2 |
| Readout over SPI on a VL53L8CX | under 1 ms |
| Detector arithmetic | under 0.1 ms |
| Waiting for the third frame to fit a velocity | 33 ms after first sight |
| Each additional frame of evidence demanded before `inbound` | 16.5 ms |
| Verdict after the object vanishes, current detector | about 100 to 120 ms |

Filtering costs lead, not compute. The only filter that costs frames is
"closing speed sustained across consecutive frames", and the owner has chosen
not to require it, because an arm swing triggering early is wanted.

### 3.6 People in the room

The cone bottom at 30 degrees up sits 7.5 degrees above horizontal. From a
rim about 0.7 m off the floor, a seated person 2.5 m away is at about 11
degrees elevation and a standing person at about 22. Both are in view. A
seated thrower's raised hand is at 13 to 18 degrees, which is the modeled
reason to start the pitch sweep at 30 rather than 35: the swing should stay
in view. The tilting module makes this an experiment, not a decision. Walking people close at
under 1.5 m/s and mostly sideways. A throwing arm closes at 2 to 4 m/s for
one or two frames then decelerates at release. The wad closes at 3 to 5 m/s
for six to ten frames.

The two filters that cost no lead and remove people: an adaptive baseline
(anything stationary for over a second becomes background) and a closing
speed gate near 2 m/s. Nothing else is required, because the owner accepts
the arm as a trigger.

---

## 4. Hardware

### 4.1 Tracking sensor

- Part: VL53L5CX (existing shield) for the first Pi build. VL53L8CX on a
  carrier with level shifters for any new build. The L8CX's SPI removes the
  readout delay and its ambient immunity matters if a window is in the cone.
- Mount: rear rim center, lens 25 to 50 mm above the rim, on a **module the
  owner is building to tilt through any angle**. Pitch, yaw, roll, height,
  and lateral offset are config tunables editable live from the web client.
  The modeled starting point is 30 degrees above horizontal; the real value
  comes from section 4.7. Nothing in the firmware or the core may assume an
  angle.
- Mode for throws: 4x4, 60 Hz. Prefer autonomous mode with a 5 ms
  integration to cut blur; fall back to continuous if the short integration
  drops the wad. Both must be runtime switchable.
- I2C at 1 MHz where the host supports it (both the Pi and ESP32 do; the
  F446 does not). SPI at 3 MHz for the L8CX.

### 4.2 Confirmation sensor, preferred: infrared break-beam curtain

- What: modulated 38 kHz infrared emitter and receiver pairs spanning the
  opening, emitters on one rim edge and receivers on the opposite edge.
  Receiver outputs are open-collector, so wire them together into **one GPIO
  line**: any broken beam pulls the line low.
- How many: the smallest object is a tightly crushed wad, about 40 mm. Beam
  spacing must be at or under 40 mm across the 260 mm width, so **six or
  seven pairs** in a single plane.
- Where: **10 to 20 mm below the rim plane**, so an object that bounces off
  the rim and falls outside does not trigger, and one that bounces in does.
- Response: under 1 ms. Timestamp the falling edge in an interrupt.
- Cost: about 2 to 3 per pair for the Adafruit 5 mm break-beam parts, or
  TSSP4038 receivers with 38 kHz driven IR LEDs for better sunlight immunity.
- What it cannot do: measure fill level or tell a throw from a hand drop.
  Trash full is therefore defined as **the beam held broken**, meaning
  trash has reached the beam plane just below the rim. That is the owner's
  intended behavior.

### 4.3 Rejected: a second time-of-flight sensor aimed down

Considered because it would reuse the driver and detector and measure fill
level for free. **Rejected by the owner.** The product has one
time-of-flight sensor and a GPIO confirmation. Do not reintroduce it. If
fill level is ever wanted, that is a separate conversation with the owner.

### 4.4 Platforms

| | Raspberry Pi Zero 2 W | ESP32-S3 |
|---|---|---|
| CPU | 4 by Cortex-A53, 1 GHz | 2 by Xtensa LX7, 240 MHz |
| Detector cost per frame | 5 to 10 microseconds in Node, under 5 in C | 50 to 150 microseconds in C |
| Sensor bus | I2C to 1 MHz, SPI via spidev | I2C to 1 MHz, SPI |
| Beam GPIO | any GPIO with edge interrupt via libgpiod | any GPIO with ISR |
| Audio | USB audio dongle or I2S DAC hat; play WAV files | I2S DAC (MAX98357A class) |
| WiFi | built in | built in |
| Boot to ranging | 20 to 30 s plus about 1 s sensor firmware upload | under 1 s plus sensor upload |
| Power | 100 to 200 mA, more with WiFi active | 30 to 80 mA, sleeps to microamps |
| Filesystem | make root read-only once working; SD cards corrupt on hard power-off | none |

The Pi runs on a power bank for a couple of days. Weeks on a small cell is
only possible on the ESP32. The owner has not stated which power source the
product uses. **Ask before designing the enclosure.**

### 4.5 Pi wiring (VL53L5CX on the existing X-NUCLEO-53L5A1 shield)

The shield is Arduino form factor. Jumper these shield signals to the Pi:

| Shield signal | Arduino pin | Purpose | Pi pin |
|---|---|---|---|
| SDA | D14 or SDA | I2C data | GPIO2, physical 3 |
| SCL | D15 or SCL | I2C clock | GPIO3, physical 5 |
| PWR_EN | A3 | gates the sensor's 3.3 V load switch; **low means the sensor is unpowered and silent** | any GPIO, drive high |
| LPn | D5 | must be high or the sensor ignores the bus | any GPIO, drive high |
| I2C_RST | D3 | pulse high then low to reset the sensor's I2C block | any GPIO |
| 3V3, 5V, GND | power header | | Pi 3V3, 5V, GND |

Bring-up order, copied from ST's driver: PWR_EN low, LPn low, wait 10 ms,
PWR_EN high, wait 10 ms, LPn high, wait 10 ms, I2C_RST pulse. Failing to
drive PWR_EN was the bug that cost the most bench time on the Nucleo.

Set the bus clock in `/boot/firmware/config.txt`:
`dtparam=i2c_arm=on,i2c_arm_baudrate=1000000`.

### 4.6 Break-beam wiring

Receivers' outputs to one GPIO with a pull-up. Emitters on a common 3.3 V or
5 V rail with series resistors per the part. Keep the receiver line short and
away from the sensor's I2C lines.

### 4.7 Knowing the angle of the tilting module

The module tilts, so the angle is data, not a constant. Three ways to know
it, and the architecture supports all three so the owner can find out which
works by playing with the device:

1. **Dial it in from the thin client.** Sliders for pitch, yaw, and roll.
   The 3D view redraws the cone immediately and the observations reproject
   on the next frame. The baseline raster is the feedback: with the angle
   right, the floor, walls, and rim land where the drawing says they are.
   Zero hardware, relies on the owner's eye.
2. **Read it from an accelerometer on the module.** A 1 to 3 dollar
   three-axis accelerometer (LIS3DH, ADXL345, MPU-6050 class) glued to the
   tilting carrier reports pitch and roll from gravity to within a degree,
   on the same I2C bus, at any rate. Yaw is not observable from gravity and
   stays manual. This is the recommended addition to the BOM because it
   also catches the module being knocked. Add `imu` to the config and the
   status endpoint; when present, its pitch and roll override the manual
   values unless `tracker.angleSource` is `manual`.
3. **Learn it from recorded throws.** A free-falling object accelerates
   straight down at 9.81 m/s squared in the world frame. Reproject a
   recorded track under candidate pitch and roll values and fit its
   acceleration; the candidate whose fitted acceleration points along the
   world vertical with the right magnitude is the sensor's true attitude.
   Yaw comes from the beam-confirmed makes: the predicted crossings of
   confirmed throws should land inside the opening, and yaw is the
   rotation that centers them. Needs five or more frames per throw, so it
   works at upward pitches and not at the repo's old downward aim. This is
   a grid search over three angles on a handful of stored tracks, small
   enough to run on the device behind `POST /api/calibrate/angle`. It
   depends on two things already in the plan: raw frames are always
   recorded, and the beam gives ground truth.

Because the angle can change, **the core reprojects from raw zone and range
every frame using the current config.** Never store world coordinates as
the primary record; store raw frames, and world coordinates are derived.

The simulation in section 3.3 is the map for the first experiments: sweep
pitch in 10 degree steps from 0 to 60 up, ten throws each, and record
first-sight lead, inbound lead, and how often flat throws are lost. The
modeled prediction is that lead rises with pitch until flat throws start
disappearing between 35 and 45 degrees. Confirm or refute that on the rig.

---

## 5. Event model and state machine

### 5.1 Event names

These names are a contract across the browser, the Pi, and the ESP32.
`AGENTS.md` requires `target-acquired`, `inbound`, `bank-predicted`,
`rim-crossed`, `in`, and `miss` to be preserved. New names are added, none
removed.

| Event | Meaning in the new design |
|---|---|
| `calibrating` | baseline being built |
| `armed` | baseline ready, watching |
| `target-acquired` | first foreground track started on the tracking sensor |
| `inbound` | closing speed of at least `minClosingMmS` over `inboundFrames` consecutive frames; **start the anticipation sound now** |
| `projectile` | new. The inbound track is small (at most `maxProjectileZones` zones) and moving at least `minProjectileSpeedMmS`. Means "a thrown object was actually seen", which gates `miss` |
| `bank-predicted` | reserved, not produced in version one |
| `rim-crossed` | confirmation sensor edge (beam broken, or downward ToF foreground entry) |
| `in` | confirmed entry; play the victory sound |
| `miss` | `projectile` was emitted and the confirmation deadline passed with no `rim-crossed`; play the fail sound |
| `lapsed` | new. `inbound` fired, no `projectile` was seen, deadline passed. **No sound.** The anticipation sound fades |
| `trash-full` | beam held broken for over `stuckBeamMs`; play the empty-trash message, suspend `in` |
| `trash-cleared` | beam released after `trash-full` |

### 5.2 States

```
OFF -> CALIBRATING -> ARMED -> TRACKING -> INBOUND -> (CONFIRMED | LAPSED | MISSED) -> COOLDOWN -> ARMED
                        ^                                                                  |
                        +--------------------------- FULL <--------------------------------+
```

- `ARMED`: adaptive baseline running on the tracking sensor. A beam edge
  here with no track is an **unseen make** (`rim-crossed` then `in`) when
  `unseenMakesEnabled` is true, default true. The beam cannot tell a throw
  from a hand dropping trash, so with unseen makes enabled a hand drop plays
  the victory sound. The owner decides whether that is acceptable; if not,
  set it false and unseen throws become silent.
- `TRACKING`: a foreground component is being followed. Ends by `endGapMs`
  with nothing seen.
- `INBOUND`: fired on the first fast closing motion. Deadline is
  `max(t_inbound + minWindowMs, predictedArrival + arrivalMarginMs)`.
  Defaults 500 and 300 ms. If the arm fired the trigger, the wad may not even
  have left the hand yet, which is why the window floor is generous.
- `CONFIRMED`: `rim-crossed` before the deadline. Emit `in`.
- `MISSED`: deadline passed, `projectile` was seen. Emit `miss`.
- `LAPSED`: deadline passed, no `projectile`. Emit `lapsed`. Silent.
- `COOLDOWN`: `cooldownMs`, default 700, suppresses bounces and a second
  object thrown right behind.
- `FULL`: entered from any state on `trash-full`. Tracking continues so the
  web client shows activity, but `in` is replaced by the empty-trash message.
  Leaves on `trash-cleared`.

### 5.3 Grading (later, not version one)

The tracking sensor still sees the wad for its last 100 to 180 ms, giving
entry speed and angle. The confirmation timing tells rim-in from swish: a
rim bounce delays `rim-crossed` by 100 to 200 ms after the predicted arrival.
Reserve three sounds: clean, rim-in, miss.

---

## 6. Software architecture

### 6.1 Shape

```
core/                  C99, no OS, no malloc after init, no floats beyond float32
  shotcaller_core.h    public API: frames in, events out, config struct, snapshot
  shotcaller_core.c    baseline, foreground, components, track, kinematics, state machine
  geometry.c/.h        zone ray, zone to world, plane intersection, velocity fit
  tests/               host tests built with plain cc; run with `make -C core test`
platform/pi/           Python 3 stdlib shell, loads core as a shared library via ctypes
  sensor/              C: vendored ULD + linux i2c-dev platform layer, built as libshotsensor.so
  shotd.py             daemon: sensor loop, core, beam GPIO, audio, HTTP + SSE server
  shotcore.py          ctypes binding to libshotcaller_core.so
  replay.py            runs an NDJSON capture through the core; used on the Mac for development
platform/esp32/        ESP-IDF project
  main/                app_main, I2C or SPI platform layer for the ULD, GPIO ISR, esp_http_server, I2S audio
  components/core      symlink or copy of ../../core
web/                   dependency-free thin client, served by the device
  index.html
tools/                 existing bench tooling stays; shot_model.js becomes the reference for golden tests
```

Keep `tools/shot_model.js` and its tests. They are the reference the C core
is checked against (section 8).

### 6.2 Core API (the contract; write the header first)

```c
typedef struct {
    uint32_t t_ms;        // host timestamp when the frame was read
    uint8_t  edge;        // 4 or 8
    uint16_t d[64];       // mm, only edge*edge entries valid
    uint8_t  status[64];  // ST target status; 5 and 9 are valid
    uint16_t signal[64];  // signal per SPAD, used only as a weak weight
} sc_frame_t;

typedef struct sc_config sc_config_t;   // every tunable in section 7, with sc_config_defaults()
typedef struct sc_core   sc_core_t;     // opaque, sized by SC_CORE_SIZE_BYTES for static allocation

typedef struct {
    uint8_t  type;        // SC_EV_* matching the names in 5.1
    uint32_t t_ms;
    float    point[3];    // x, y, z mm where meaningful
    float    velocity[3]; // mm/s where meaningful
    float    closing_mm_s;
    float    predicted_arrival_ms;
    uint8_t  zones;       // zone count of the observed component
    float    confidence;
} sc_event_t;

void     sc_config_defaults(sc_config_t *cfg);
int      sc_core_init(sc_core_t *core, const sc_config_t *cfg);
void     sc_core_set_config(sc_core_t *core, const sc_config_t *cfg);
int      sc_core_ingest_frame(sc_core_t *core, const sc_frame_t *f, sc_event_t *out, int max_out);
int      sc_core_confirm(sc_core_t *core, uint32_t t_ms, float entry_speed_mm_s_or_nan, sc_event_t *out, int max_out);
int      sc_core_set_beam_stuck(sc_core_t *core, uint32_t t_ms, int stuck, sc_event_t *out, int max_out);
int      sc_core_set_attitude(sc_core_t *core, float pitch_deg, float roll_deg);           // from the accelerometer when present
int      sc_core_calibrate_angle(const sc_track_record_t *tracks, int n, sc_angle_fit_t *out); // section 4.7 method 3
int      sc_core_tick(sc_core_t *core, uint32_t t_ms, sc_event_t *out, int max_out);  // call at least every 10 ms
void     sc_core_snapshot(const sc_core_t *core, sc_snapshot_t *snap);               // state, track, baseline, attitude, beam
```

Rules for the core:

- No dynamic allocation after `sc_core_init`. The ESP32 build allocates the
  core statically.
- No dependence on wall-clock. Time comes in through `t_ms` on every call.
- Deterministic: the same frame sequence produces the same events. The
  golden tests depend on this.
- Float32 only. The ESP32-S3 FPU is single precision.

### 6.3 Detector algorithm, per frame

1. **Validity.** A zone is valid when status is 5 or 9 and range is under
   `trackRangeMm`.
2. **Adaptive baseline.** Per zone keep `baseline_mm` and a stability
   counter. If the zone is valid and within `baselineTolMm` (default 60) of
   the current baseline candidate for `baselineFrames` consecutive frames
   (default 60, one second at 60 Hz), adopt the candidate. **A zone with no
   valid return during calibration gets baseline = infinity, not "skip
   forever".** This is a verified bug in `tools/shot_model.js`: a zone whose
   background is beyond range never contributes an observation, and in a
   15 foot room with the sensor at 30 degrees up that is 8 to 12 of the 16
   zones. Never re-baseline while a track is active.
3. **Foreground.** Valid zones where `baseline - d >= foregroundDeltaMm`
   (default 140 for the upward sensor) or baseline is infinite.
4. **Components.** Eight-neighbor connected components on the edge by edge
   grid. Port `connectedComponents` from the JavaScript.
5. **Observation per component.** World point from `zoneToWorld` with
   weights favoring **nearer** zones, not larger deltas. Record mean range,
   zone count, and mean signal.
6. **Association.** One track in version one. Attach the component whose
   mean range is closest to the track's predicted range. If no track, start
   one on the component with the smallest mean range and emit
   `target-acquired`.
7. **Kinematics.** Keep the last `velocityWindowMs` (default 120) of
   samples. Closing speed is the negative slope of range against time over
   the last three samples. Velocity is the gravity-corrected least-squares
   fit ported from `estimateVelocity`. Predicted arrival is the intersection
   of the fitted path with the rim plane, ported from `intersectPlane` with
   the horizon `predictionHorizonMs`.
8. **Inbound.** If closing speed is at least `minClosingMmS` (default 2000)
   on `inboundFrames` consecutive samples (default 3), emit `inbound` once
   with the predicted arrival, and set the deadline per 5.2.
9. **Projectile.** While inbound, if the component has at most
   `maxProjectileZones` (default 3 at 4x4) and 3D speed is at least
   `minProjectileSpeedMmS` (default 650, retune on real throws), emit
   `projectile` once.
10. **End of track.** No component for `endGapMs` (default 85) ends the
    track. If inbound, the deadline logic in `sc_core_tick` decides
    `in`, `miss`, or `lapsed`.
11. **Confirmation.** `sc_core_confirm` while inbound emits `rim-crossed`
    then `in`, unless `FULL`. In `ARMED` with no track it applies the unseen
    make rule from 5.2.
12. **Trash.** `sc_core_set_beam_stuck` maps a beam held low for
    `stuckBeamMs` (default 2000) to `trash-full`, and its release to
    `trash-cleared`. The beam plane sits 10 to 20 mm below the rim, so a
    stuck beam means trash is at the rim.
13. **Attitude.** Every reprojection uses the pitch, roll, and yaw in the
    current config, or the accelerometer's pitch and roll when
    `angleSource` is `imu`. Changing the angle never requires a restart or
    a baseline reset beyond what the adaptive baseline does on its own.

### 6.4 Pi shell (`platform/pi/`)

- Python 3 standard library only, matching `tools/viz_server.py`. No pip
  dependencies beyond what the sensor library needs.
- Sensor: build the vendored ULD from `ShotCaller/Drivers/VL53L5CX_ULD_driver`
  with a Linux `platform.c` using `/dev/i2c-1`. **Trap:** the driver uploads
  84 KB of sensor firmware as three 32 KB writes, and Linux `i2c-dev` caps a
  single message at 8192 bytes. The platform write function must chunk large
  writes and re-send the 16 bit register address for each chunk. The same
  trap on the Nucleo appeared as a too-short I2C timeout.
- Expose the sensor as `libshotsensor.so` with five functions: open, init
  with resolution and rate and mode, start, poll_frame into an `sc_frame_t`,
  stop. Bind with ctypes.
- IMU, if fitted: read pitch and roll at 10 Hz over the same I2C bus,
  low-pass them, and pass them to `sc_core_set_attitude`.
- Beam GPIO: `libgpiod` event loop or a polling thread at 1 kHz on the
  falling edge; either is fine for a 40 mm object at 5 m/s, which occupies
  the beam plane for at least 8 ms.
- Audio: three WAV files in `platform/pi/sounds/`; play with `aplay`
  through a USB audio dongle. Replace the WebAudio synthesizer; do not port
  it.
- HTTP and SSE: extend the pattern in `tools/viz_server.py` (stdlib
  `http.server`, one-directional SSE). The API is section 9.
- Config persistence: `/var/lib/shotcaller/config.json`; the core's
  `sc_config_t` mirrors it field for field.
- Captures: continuous NDJSON recording of frames and events to
  `/var/lib/shotcaller/sessions/`, same schema as `captures/sessions/`, so
  `replay.py` and the golden tests consume both.
- Service: a `systemd` unit, `Restart=always`. Make the root filesystem
  read-only with an overlay once it works.
- Development on the Mac: `replay.py` feeds a capture through the core and
  `shotd.py --replay <file>` serves the web client from replayed data, so the
  web client can be built without hardware.

### 6.5 ESP32-S3 shell (`platform/esp32/`)

- ESP-IDF 5.x. `idf.py` is **not** installed on the bench Mac; say so in the
  handoff if you cannot build.
- Copy or symlink `core/` as a component. It must compile with `-Wall
  -Werror` under the IDF toolchain with no changes.
- ULD platform layer over the IDF I2C master driver at 1 MHz, or SPI at
  3 MHz for the L8CX. Same chunking rule does not apply, but the IDF I2C
  driver has its own per-transaction limits; check `i2c_master_transmit`
  documentation for the version in use.
- Beam: GPIO ISR on the falling edge, timestamp with `esp_timer_get_time`,
  push to a queue; the main loop calls `sc_core_confirm`.
- Audio: I2S to a MAX98357A style amplifier, WAV files in SPIFFS or
  LittleFS.
- Web: `esp_http_server` serving `web/index.html` from flash and the SSE
  endpoint as a chunked response. Config in NVS, mirrored to JSON for the
  API.
- WiFi: station mode with credentials in NVS; provisioning is out of scope
  for version one, a hardcoded build-time SSID is acceptable for the bench
  **only if it is injected from the environment, never committed.**

---

## 7. Config schema

One JSON document, mirrored by `sc_config_t`. Units in the key name. All
fields editable from the web client. Defaults are starting points, and the
ones marked "retune" have no measured basis yet.

```json
{
  "can": { "widthMm": 260, "depthMm": 240, "rimAboveFloorMm": 700 },
  "tracker": {
    "sensor": "vl53l5cx",
    "resolution": 4, "hz": 60, "mode": "autonomous", "integrationMs": 5,
    "angleSource": "manual", "pitchDeg": -30, "yawDeg": 0, "rollDeg": 0,
    "heightMm": 36, "setbackMm": 0, "offsetXMm": 0,
    "fovHorizontalDeg": 45, "fovVerticalDeg": 45, "flipX": false, "flipY": false,
    "trackRangeMm": 3000, "foregroundDeltaMm": 140,
    "baselineFrames": 60, "baselineTolMm": 60,
    "minClosingMmS": 2000, "inboundFrames": 3,
    "maxProjectileZones": 3, "minProjectileSpeedMmS": 650,
    "velocityWindowMs": 120, "predictionHorizonMs": 900, "endGapMs": 85
  },
  "imu": { "enabled": false, "model": "lis3dh", "address": 24, "mountOffsetPitchDeg": 0, "mountOffsetRollDeg": 0 },
  "confirm": {
    "source": "beam",
    "beamGpio": 17, "beamActiveLow": true, "stuckBeamMs": 2000,
    "unseenMakesEnabled": true
  },
  "timing": { "minWindowMs": 500, "arrivalMarginMs": 300, "cooldownMs": 700 },
  "audio": { "inbound": "inbound.wav", "in": "in.wav", "miss": "miss.wav", "full": "full.wav", "volume": 0.8 }
}
```

Sign convention: `pitchDeg` follows the repo's existing convention where
**positive points down into the can**, so 30 degrees up is `-30`. `rollDeg`
is positive when the sensor's right edge drops. `angleSource` is `manual`
or `imu`; with `imu`, pitch and roll come from the accelerometer plus the
mount offsets and yaw stays manual.

Retune on real throws: `minClosingMmS`, `minProjectileSpeedMmS`,
`maxProjectileZones`, `foregroundDeltaMm`, `integrationMs`.

---

## 8. Validation plan

Version one is not done until every item here is true.

1. **Golden tests.** `core/tests/golden` replays every file in
   `captures/sessions/` and `captures/throws/` through the C core and
   through `tools/shot_model.js` and compares event sequences, allowing
   differences only where this plan changes behavior (dead-zone baseline,
   nearest weighting, the new events). Record each intentional difference in
   the test as an explicit expectation, not a tolerance.
2. **Unit tests in C**, written before the implementation per `AGENTS.md`:
   - a zone with no valid baseline detects a later foreground return;
   - a synthetic object closing at 3 m/s emits `inbound` on the third sample
     with the correct sign and magnitude;
   - a synthetic walker closing at 1 m/s never emits `inbound`;
   - `confirm` inside the window emits `rim-crossed` then `in`;
   - deadline with `projectile` emits `miss`; without it emits `lapsed`;
   - beam stuck for `stuckBeamMs` emits `trash-full` and suppresses `in`;
   - determinism: the same input twice gives byte-identical events.
3. **Bench replay.** `platform/pi/replay.py` on the Mac against the archived
   4x4 at 60 Hz session produces the same events as the C tests expect.
4. **Live sensor on the Pi.** `shotd.py` reports 60 Hz at 4x4 sustained for
   five minutes with zero parse errors and no reinitializations, measured
   from the device's own status endpoint.
5. **Recorded throws with people present.** At least fifty labelled throws
   per mounted geometry, thrower seated and standing, with someone else
   walking in the room. Report separately: acquisition lead, false `inbound`
   with no throw, false `miss` on makes, false `in` on misses, unseen makes
   caught by the beam alone, invalid-return streaks. Never hide these in one
   number.
6. **Acceptance for version one:** zero false `miss` sounds on makes, under
   one false `inbound` per ten minutes of ordinary room activity, and the
   anticipation sound audibly starting before the object reaches the rim on
   front throws from 2 m.

Never ask the owner to make a test throw until the device's status endpoint
reports an active continuous recorder with an advancing frame count.

---

## 9. Device HTTP API

Served by the device on port 8420. JSON everywhere. No authentication in
version one on the assumption of a home network; add a shared token before
anything leaves the bench.

| Method and path | Purpose |
|---|---|
| `GET /` | serves `web/index.html` |
| `GET /api/status` | `{ state, uptimeS, sensor: { model, resolution, hz, mode, framesPerS, reinits, lastFrameAgeMs }, attitude: { source, pitchDeg, yawDeg, rollDeg, imuPresent }, confirm: { source, beamLevel, stuckMs }, recording: { active, framesRecorded, file }, wifi: { rssi, ip } }` |
| `GET /api/config` | the full document in section 7 |
| `PUT /api/config` | replace; the device validates ranges, applies live without restart, persists, and returns the stored document |
| `POST /api/config/reset` | restore defaults |
| `GET /events` | SSE stream. Event types: `frame` (raw frame, throttled to 20 per second for the browser), `observation` (world point, zones, closing speed, velocity, prediction), `event` (section 5.1 events), `status` (every second) |
| `POST /api/label` | `{ "truth": "in" | "miss" }` saves the last event window with geometry, same schema as `captures/throws/` |
| `GET /api/sessions` and `GET /api/sessions/<name>` | list and download recordings |
| `POST /api/sound/<name>` | play a sound for testing |
| `POST /api/baseline/reset` | force recalibration |
| `POST /api/calibrate/angle` | runs section 4.7 method 3 on the stored labelled throws; returns `{ pitchDeg, yawDeg, rollDeg, residual, throwsUsed }` and does **not** apply it; the client shows it beside the current values and the owner applies with `PUT /api/config` |

The web client must work with nothing but these endpoints. If a feature
needs computation, the computation goes in the device and is exposed here.

---

## 10. Web tuning client (`web/index.html`)

- Single file, no build step, no external resources, same discipline as
  `tools/viz.html`. Served by the device; also runnable on the Mac against
  `shotd.py --replay`.
- Panels: live state and event log with timestamps; the 4x4 or 8x8 raster
  with invalid statuses greyed, as `viz.html` already does; the orbitable 3D
  view of can, sensor cone, live points, fitted velocity, and predicted
  crossing, ported from `viz.html`'s rendering code **without** any of its
  detector code; a config form generated from the section 7 schema with
  units and a "apply" that PUTs and shows the stored result; scoreboard from
  labels; sound test buttons; recording status.
- The angle controls are the point of the app. Pitch, yaw, and roll sliders
  redraw the cone in the 3D view immediately and observations reproject on
  the next frame after apply. Show the accelerometer's live pitch and roll
  next to the sliders when an IMU is present, and a "calibrate from throws"
  button that calls `POST /api/calibrate/angle` and shows the proposal
  beside the current values. Nothing applies without the owner pressing
  apply.
- Remove the "Arm system" button. The device is always armed; the baseline
  is adaptive.
- Do not port `ShotDetector`, `FrameProjector`, or any physics into the
  client. If the page needs a value, the device sends it.

---

## 11. Build order for the next agent

Each step ends with a commit. All on one feature branch. Open one PR when
the owner asks, not before.

1. Write `core/shotcaller_core.h` exactly as section 6.2, plus
   `sc_config_t` from section 7. Commit.
2. Write the C unit tests in section 8.2 so they fail. Commit.
3. Implement `core/` until the tests pass. Port geometry from
   `tools/shot_model.js` function by function, keeping names. Commit.
4. Write the golden replay test against `captures/sessions/session-20260905-054301.ndjson.gz`.
   It will fail on the intentional differences; encode them as expectations.
   Commit.
5. Build `platform/pi/sensor/` with the Linux platform layer and chunked
   writes. Test on the Pi with `st-info`-equivalent evidence: the device
   answers at address 0x52 and `vl53l5cx_is_alive` passes. Commit.
6. `shotcore.py` ctypes binding and `replay.py`. Replay must match the C
   golden test. Commit.
7. `shotd.py` with `--replay` serving the section 9 API. Commit.
8. `web/index.html` against `--replay`. Commit.
9. Live sensor on the Pi, beam on GPIO, sounds. Section 8 item 4. Commit.
10. Fifty labelled throws with people moving. Section 8 item 5. Commit the
    report under `docs/testing/`, not the captures.
11. Pitch sweep per section 4.7: ten throws at each of 0, 10, 20, 30, 40,
    50, and 60 degrees up, with the beam as truth. Report lead and coverage
    per pitch. Then implement `sc_core_calibrate_angle` against those
    recordings and report how close its estimate lands to the dialed
    angle. Commit the report.
12. ESP32 shell. Section 6.5. Commit.

Do not start step 12 before step 10 has a report. The ESP32 port needs
retuned thresholds, and those come from real throws.

---

## 12. Pitfalls, all of them

- **PWR_EN must be driven high** or the VL53L5CX is unpowered and every
  I2C probe fails. This was the bring-up bug that cost the most time.
- **Sensor firmware upload is 84 KB in three 32 KB writes.** On the Nucleo
  the I2C timeout had to be 2000 ms. On Linux `i2c-dev` the writes must be
  chunked under 8192 bytes.
- **`vl53l5cx_stop_ranging` burns a full 5 s timeout** if the sensor was
  not ranging. Track ranging state and only call it when ranging.
- **Never call the HAL UART receive inside the ranging loop** on the Nucleo;
  read `RXNE` and `DR` directly. Irrelevant on the Pi and ESP32 but keep the
  Nucleo firmware working as the bench reference.
- **VL53L8CX I/O is 1.2 V or 1.8 V.** A bare module on a 3.3 V bus is
  damaged. Use a carrier with level shifters.
- **Continuous mode integrates for the whole frame period.** Blur is 66 mm
  per frame at throw speeds. Autonomous mode with a short integration is
  the fix, and it is noisier; both must be selectable at runtime.
- **The readout time and the measured frame rate disagree** (3.2). Put a
  logic analyzer on the bus before assuming either.
- **Roll is real on a tilting module.** A rolled sensor swaps part of
  vertical into lateral. Either read it from the IMU or expose it as a
  tunable; never assume zero.
- **Zones with no valid background must not be dead.** Verified bug in the
  JavaScript detector; do not port it.
- **`trackRangeMm` of 1800 discards the first frames of any throw from
  beyond about 2 m.** Default 3000 on the device.
- **Delta-weighted centroids favor far backgrounds.** Weight by nearness.
- **Do not re-baseline through a full can.** Trash full is a message, not
  a calibration problem.
- **The default branch is `main`.** The remote had not been created as of
  2026-09-06; `git remote -v` was empty.
- **Secrets never enter the repo.** WiFi credentials come from the
  environment or NVS. If a `.env` appears, it is rendered from 1Password,
  never hand-edited.
- **Deploying is not pushing.** The Pi is updated by rsync and a service
  restart; verify with `/api/status` that the new build is the one running.
- **Never hardcode a `/dev/cu.usbmodem*` suffix** in tools; autodetect or
  read `SHOTCALLER_PORT`.
- **Never ask for a test throw** until the recorder is active and the frame
  count is advancing.

---

## 13. The simulation (`tools/throw_sim.js`)

Run with Node from the repo root. Environment variables select cases:

```
N=15 PITCH="-30,-35" OBJ="wad,can" MODES="4x4@60 cont|4x4@60 auto5" \
  THROWS="lob 2.0m|hard 2.5m|side lob 2m" node tools/throw_sim.js
DEBUG=1 N=1 PITCH=-30 OBJ=wad MODES="4x4@60 cont" THROWS="lob 2.0m" node tools/throw_sim.js
FG=60 ... lowers foregroundDeltaMm for the run
READOUT_MS=3 ... changes the assumed readout delay
```

Columns: pitch, mode, object, throw, mean speed at the rim, mean descent
angle, percent of trials with any detection, mean frames detected before
crossing, mean zones per detected frame, mean distinct zones over the
throw, first-sight lead, inbound lead with the count of trials that fired,
absolute velocity error, predicted crossing error, verdict correctness, and
verdict delay after crossing.

Assumptions that are guesses, in order of how much they matter: the
detection threshold (calibrated so a full-zone white target detects to
2.5 m at 60 Hz continuous), the range noise model (12 mm base at 60 Hz,
growing with lower coverage), the aluminum can's reflectance and flicker,
the room surfaces used for baselines, and the absence of multipath. The
geometry, frame timing, drag, and gravity are not guesses. Treat every
percentage as a comparison between configurations, never as an absolute.

---

## 14. Open questions for the owner

1. Battery or USB power. Decides whether the ESP32 is the product or the
   Pi is.
2. Where people throw from. Decides whether one forward-facing tracking
   sensor is enough or a wider or second sensor is needed.
3. Whether unseen makes (beam edge with no inbound) should count, given
   that the beam alone cannot tell a throw from a hand drop. Default in
   this plan is yes.
4. Whether to put an accelerometer on the tilting module. This plan
   recommends it (section 4.7) but does not require it.
