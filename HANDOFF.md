# ShotCaller -- Handoff / Status

Trash-can trick-shot detector. VL53L5CX 8x8-zone ToF sensor mounted at the
rim classifies thrown objects as "in" vs "miss" and triggers audio samples.
Long-term target is a standalone ESP32 build; current phase is bring-up on
an STM32 Nucleo bench rig to validate the sensor before porting.

**Status: sensor works end to end.** Firmware builds, flashes, ranges, and
streams live 8x8 (or 4x4) frames over UART into a browser-based scope at
`tools/`. Full command-line build/flash/debug loop, no GUI needed.

Current phase is *characterisation*: using the scope to learn what the
sensor can actually see before writing any hit/miss classification.

## Hardware

- Sensor: STMicro VL53L5CX (8x8 zone ToF), on ST's **X-NUCLEO-53L5A1**
  expansion board (Arduino-shield form factor), stacked on the Nucleo.
- MCU: **NUCLEO-F446RE** -- confirmed via `st-info --probe` reading the
  actual chip ID over SWD (0x421 -> STM32F446), not read off a label.
  Not one of ST's officially pre-packaged X-NUCLEO-53L5A1 targets (those
  are F401RE / L476RG) -- required hand-porting the I2C platform layer
  and peripheral init.
- Wiring: I2C1 on PB8 (SCL) / PB9 (SDA), USART2 debug output on PA2 (TX)
  routed to the ST-LINK virtual COM port, **921600** 8N1 (raised from 115200
  so the link is not the bottleneck when streaming frames -- see below).
- Shield control pins, confirmed against ST's stm32duino X-NUCLEO-53L5A1
  examples (`PWREN_PIN A3`, `LPN_PIN 5`, `I2C_RST_PIN 3`) translated through
  the Nucleo-64 Arduino pin map:

  | Signal | Arduino | STM32 | Why it matters |
  |---|---|---|---|
  | PWR_EN | A3 | PB0 | gates the shield's AVDD load switch -- low = sensor completely unpowered |
  | LPn | D5 | PB4 | must be high or the sensor ignores the I2C bus |
  | I2C_RST | D3 | PB3 | pulse high-low to reset the sensor's I2C block |

  PB3/PB4 are JTDO/NJTRST at reset; repurposing them as GPIO is safe only
  because we debug over 2-wire SWD (PA13/PA14).
- Serial device: `/dev/cu.usbmodem2244103` (may change if unplugged/
  replugged -- check with `ls /dev/cu.usbmodem*`).

## Command-line workflow (no STM32CubeIDE GUI needed)

```
make          # build -- produces build/shotcaller.elf and .bin
make clean    # remove build/
make flash    # flash via st-flash (requires `brew install stlink`)
st-flash reset                        # reset the board without reflashing
python3 capture_serial.py [secs] [outfile]   # capture UART output to a file
```

`make` uses the `arm-none-eabi-gcc` bundled inside STM32CubeIDE.app
directly (path is hardcoded in the Makefile's `TOOLCHAIN_BIN` var) -- no
separate toolchain install needed. `stlink` (for `st-flash`/`st-info`) and
`pyserial` (for the capture script) are already installed via Homebrew/pip
on this machine.

Expected boot output:

```
--- ShotCaller / VL53L5CX bring-up ---
I2C1 scan: 0x29
  expecting 0x29 (7-bit) = 0x52 (8-bit) for VL53L5CX
VL53L5CX detected. Loading firmware (few hundred ms)...
# init OK
C,res=8,hz=15,mode=cont,max_hz=15
F,0,2697,8,15,1485:6:10,...
```

## The live scope (`tools/`)

```
python3 tools/viz_server.py     # then open http://localhost:8420
```

`viz_server.py` reads the frame stream off the serial port, fans it out to
the browser over Server-Sent Events, and relays single-character commands
back to the board. `viz.html` is the UI: a live per-zone distance heatmap,
measured frame-rate/jitter tiles, two strip charts (closest valid distance,
and time between frames), and an **event capture** trigger -- arm it, throw
something past the sensor, and it holds the frames around the event so you
can step through them one at a time.

SSE rather than WebSockets because the data is strictly one-directional at
up to 60Hz and SSE needs nothing outside the standard library.

Everything runs locally; nothing is uploaded anywhere.

### What the two bring-up bugs actually were

Recorded because both were non-obvious and both wasted real time:

1. **PWR_EN was never driven.** The X-NUCLEO-53L5A1 gates the sensor's AVDD
   behind a load switch on Arduino A3 (PB0). With it low the sensor is
   unpowered, so `vl53l5cx_is_alive()` could never pass no matter what was
   done to the I2C clock or address. The earlier guess-list had this as the
   4th thing to check; it was the only thing that mattered.
2. **The I2C timeout was ~7x too short for the firmware upload.**
   `vl53l5cx_init()` uploads an 84KB firmware image into the sensor as three
   single writes of 0x8000 (32768) bytes (`vl53l5cx_api.c:322-329`). At
   400kHz each chunk needs ~0.74s of bus time; the platform layer passed a
   100ms timeout, so the transfer aborted mid-flight and surfaced only as the
   generic `init failed, status=1`. Now 2000ms.

Two related traps worth remembering:

- `vl53l5cx_stop_ranging()` polls for a stop acknowledgement the sensor never
  sends if it was not ranging, burning its **full 5-second timeout**
  (`vl53l5cx_api.c:642`). `main.c` tracks `g_ranging` so it is only called
  when actually ranging.
- The UART command poll reads `RXNE`/`DR` **directly instead of calling
  `HAL_UART_Receive()`**. The HAL call locks the handle, and a byte arriving
  while the MCU sits inside `ApplyConfig()` overruns the receiver; the HAL
  error path could then leave every later `HAL_UART_Transmit()` returning
  BUSY, so the board kept ranging but went permanently silent until reset.
  Reading SR then DR also clears ORE, so overruns self-heal.

## Measured sensing profile (this is the design constraint)

Measured at the host, not quoted from a datasheet:

| Mode | Requested | Delivered | Mean interval | Jitter (sd) |
|---|---|---|---|---|
| 8x8 | 15 Hz | 15.1 Hz | 66.0 ms | 0.4-1.3 ms |
| 4x4 | 60 Hz | 60.5 Hz | 16.5 ms | 1.3 ms |

**The sensor's hard ceiling is 15Hz at 8x8 and 60Hz at 4x4**, and the rig
delivers both cleanly, so the UART/USB chain is not a limiting factor.

This is the whole feasibility question for the project. An object thrown at
~3 m/s crosses the sensor's field of view in roughly 250-300 ms, which is
about **4 frames at 8x8 but ~17 frames at 4x4**. Any classification scheme
that needs to see a trajectory (rather than a single silhouette) probably
has to live at 4x4/60Hz, trading spatial detail for temporal detail -- the
scope's resolution toggle exists precisely so this can be judged from real
throws rather than argued about.

Per-zone `target_status` is streamed alongside distance because it is the
difference between "that zone reads 0mm" and "that zone has no valid
target". Per ST (UM2884 table 4) only status **5** (range valid) and **9**
(valid, large pulse) are trustworthy; the scope greys out everything else
rather than drawing it as a distance.

## Project layout

`/Users/ernestoikerd/repos/gedgets/ShotCaller/` is now a git repo (initial
commit made this session). Note the doubled `ShotCaller/ShotCaller/` path
-- the outer dir is the Eclipse workspace root; the inner one is the
actual CubeIDE project. The `Makefile`, `capture_serial.py`, and this file
live at the outer/repo level.

```
ShotCaller/                     <- repo root, git-initialized
  Makefile                      <- CLI build (see above)
  capture_serial.py             <- UART capture helper
  tools/
    viz_server.py               <- serial -> browser bridge (SSE + commands)
    viz.html                    <- the live scope UI
  captures/                     <- saved frame captures (gitignored)
  HANDOFF.md                    <- this file
  .gitignore                    <- excludes build/, .metadata/, .settings/
  ShotCaller/                   <- actual CubeIDE project dir
    Inc/
      main.h
      stm32f4xx_hal_conf.h      -- trimmed module set (GPIO/RCC/CORTEX/PWR/FLASH/I2C/UART/DMA)
      stm32f4xx_it.h
    Src/
      main.c                    -- sensor init + 8x8 ranging loop, printf via UART2
      stm32f4xx_hal_msp.c       -- clock enables + pin AF config for I2C1, USART2
      stm32f4xx_it.c            -- interrupt handlers (SysTick, faults)
      syscalls.c / sysmem.c     -- from CubeIDE template, unmodified
    Startup/
      startup_stm32f446retx.s   -- from CubeIDE template, unmodified
    STM32F446RETX_FLASH.ld / _RAM.ld  -- from CubeIDE template, unmodified
    Drivers/
      CMSIS/Include/                          -- ARM core headers (ARM-software/CMSIS_5)
      CMSIS/Device/ST/STM32F4xx/              -- F446 register defs + system_stm32f4xx.c
                                                  (STMicroelectronics/cmsis_device_f4)
      STM32F4xx_HAL_Driver/{Src,Inc}/         -- full HAL driver, incl. Inc/Legacy/
                                                  (STMicroelectronics/stm32f4xx_hal_driver)
      VL53L5CX_ULD_driver/{Src,Inc}/          -- ULD driver core (plain C), sourced from
                                                  RJRP44/VL53L5CX-Library (BSD-3-Clause,
                                                  originally ST source ported for ESP-IDF)
        Src/platform.c, Inc/platform.h        -- HAND-WRITTEN: STM32 HAL I2C
                                                  implementation replacing the ESP-IDF
                                                  version that shipped with that repo
```

### Dependency versions (commit SHAs at time of cloning, for reproducibility)

| Repo | Commit |
|---|---|
| STMicroelectronics/stm32f4xx_hal_driver | `1f6451c3e07728b4c830744de380e56bf5bc0026` |
| STMicroelectronics/cmsis_device_f4 | `a833f4af71410f25b01468f976560d7ff63a2fc9` |
| ARM-software/CMSIS_5 | `55b19837f5703e418ca37894d5745b1dc05e4c91` |
| RJRP44/VL53L5CX-Library | `aab8a7e092756914ff040a8ee958c63dc18bc9bd` |

All from `main`/`master` branches, unpinned to a release tag -- worth
noting if a future `git pull`-style refresh of these files ever happens.
All BSD-3-Clause / original STMicroelectronics license headers are intact
in each file. None of this was downloaded through ST's gated myST portal.

## What main.c does

1. `HAL_Init()`, clock config (HSI 16MHz -> PLL -> 84MHz SYSCLK -- chosen
   to avoid depending on HSE/MCO stability), GPIO/I2C1/USART2 init.
2. `VL53_PowerUp()` -- PWR_EN high, settle, pulse I2C_RST, release LPn high.
3. `I2C_BusScan()` -- raw 7-bit sweep, prints what ACKs. Distinguishes
   "wrong address" from "dead bus"; should report `0x29`.
4. `vl53l5cx_is_alive()`, then `vl53l5cx_init()` (the 84KB firmware upload).
5. `ApplyConfig()` -- set resolution / frequency / ranging mode and start.
6. Loop: poll for commands, poll `vl53l5cx_check_data_ready()`, and on each
   new frame emit one `F,...` line and toggle LD2 as a heartbeat.

### Host streaming protocol

```
F,<id>,<t_ms>,<edge>,<hz>,<d>:<st>:<sig>,<d>:<st>:<sig>,...
```

`edge` is 4 or 8; one `distance_mm:target_status:signal_per_spad` triple per
zone in raster order. `C,` lines report active config; `#` lines are human
log text. Each frame is composed into one buffer and pushed with a single
`HAL_UART_Transmit` -- going through `printf()` would issue one blocking HAL
call *per character* (~900 per 8x8 frame), which alone would throttle the
frame rate being measured.

### Single-character commands (UART RX, also driven by the scope UI)

| Key | Effect |
|---|---|
| `8` / `4` | 8x8 (max 15Hz) / 4x4 (max 60Hz) |
| `+` / `-` | raise / lower requested ranging frequency by 1 |
| `M` | jump to the max rate for the current resolution |
| `m` | toggle continuous / autonomous ranging mode |
| `p` | pause / resume streaming |
| `?` | re-announce current config (`C,` line) |

`M` exists because RX is polled one byte at a time with no buffer: a burst
of `+` sent while the MCU is inside `ApplyConfig()` is overrun and lost.

This is bring-up/characterisation code only -- no hit/miss classification
logic yet.

## STM32CubeIDE GUI note (why we went CLI-only)

This particular STM32CubeIDE install's New Project wizard does not expose
the classic CubeMX/.ioc board-selector flow -- "STM32CubeIDE Empty
Project" only sets the target chip for linker/startup files, generating no
HAL drivers or peripheral init code. Rather than continuing to fight the
GUI, we hand-assembled the firmware and built a CLI Makefile instead (see
above) -- this also happens to be much more agent-friendly than a GUI loop.
If you want the GUI's `.ioc` visual pin/clock editor for future peripheral
changes, try Help -> Manage Embedded Software Packages first to install
the STM32F4 MCU package, which may unlock the normal wizard.

## Next steps

1. **Characterise with real throws.** Open the scope, arm the capture
   trigger, and throw things past the sensor at both 8x8/15Hz and
   4x4/60Hz. The questions to answer from the recordings:
   - How many frames does a thrown object actually appear in?
   - Does it register as a clean distance dip, or as zones dropping to
     "no valid target" (status 255) because a fast/small/dark object
     doesn't return enough signal?
   - Does the closest-zone position trace a readable path across the grid,
     or does it jump around?
   - How different does an "in" trajectory look from a "miss"?
2. Mount the sensor at the actual rim and record a calibration baseline
   (the empty trash-can opening) -- classification will be a comparison
   against that baseline, so it needs to be stable first.
3. Only then build hit/miss classification, informed by 1 and 2 rather
   than guessed: likely tracking the minimum-distance zone across frames
   against a calibrated opening mask.
4. Audio playback trigger (I2S DAC, e.g. MAX98357A) once classification
   works.
5. Longer-term: port the validated classification logic to a standalone
   ESP32 + VL53L5CX carrier board (Pololu/SparkFun), dropping the Nucleo
   dev-rig entirely for the final clip-on form factor. The ESP32 can serve
   the same scope UI over WiFi directly, no host bridge needed.

## Open questions / not yet investigated

- **Integration time and sharpener** (`vl53l5cx_set_integration_time_ms`,
  `vl53l5cx_set_sharpener_percent`) are untouched at defaults. Integration
  time trades signal quality against max rate and is likely the next knob
  worth exposing in the scope once throw recordings show whether weak
  returns are the problem.
- **Autonomous vs continuous ranging mode** is toggleable (`m`) but has not
  been compared on real data.
- Motion indicator and detection-threshold plugins ship with the ULD driver
  and are unused; they may be a cheaper path to "something moved through
  the opening" than frame-by-frame analysis on the host.
