# ShotCaller -- Handoff / Status

Trash-can trick-shot detector. VL53L5CX 8x8-zone ToF sensor mounted at the
rim classifies thrown objects as "in" vs "miss" and triggers audio samples.
Long-term target is a standalone ESP32 build; current phase is bring-up on
an STM32 Nucleo bench rig to validate the sensor before porting.

**Status: firmware builds, flashes, and runs. Sensor is not yet detected on
I2C -- that's the next concrete thing to debug (see "Current known issue"
below).** Full command-line build/flash/debug loop is set up so no GUI is
needed for iteration.

## Hardware

- Sensor: STMicro VL53L5CX (8x8 zone ToF), on ST's **X-NUCLEO-53L5A1**
  expansion board (Arduino-shield form factor), stacked on the Nucleo.
- MCU: **NUCLEO-F446RE** -- confirmed via `st-info --probe` reading the
  actual chip ID over SWD (0x421 -> STM32F446), not read off a label.
  Not one of ST's officially pre-packaged X-NUCLEO-53L5A1 targets (those
  are F401RE / L476RG) -- required hand-porting the I2C platform layer
  and peripheral init.
- Wiring: I2C1 on PB8 (SCL) / PB9 (SDA), USART2 debug output on PA2 (TX)
  routed to the ST-LINK virtual COM port, 115200 8N1.
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

**Verified working end-to-end** as of this session: `make` builds clean
(106KB flash used, well under the 512KB budget), `make flash` writes and
verifies successfully, and `capture_serial.py` reads real boot output over
UART. Confirmed output on a successful flash + reset:

```
--- ShotCaller / VL53L5CX bring-up ---
ERROR: VL53L5CX not detected on I2C1 (check wiring/addr)
```

This proves HAL_Init, clock config (HSI->PLL->84MHz), GPIO, I2C1
peripheral init, and USART2 (including printf retargeting) all work
correctly -- the failure is specifically `vl53l5cx_is_alive()` returning
not-alive, i.e. the sensor isn't ACKing on the I2C bus.

## Current known issue: sensor not detected

`vl53l5cx_is_alive()` fails immediately after boot. Things to check, in
likely order of usefulness:
1. **Is the X-NUCLEO-53L5A1 shield actually seated on the Arduino header
   right now?** It may have been removed/reseated during the STM32CubeIDE
   GUI wrangling earlier in this session -- verify physically.
2. Re-check the I2C1 pin assignment against the actual X-NUCLEO-53L5A1
   schematic -- we assumed PB8/PB9 (the standard Nucleo-64 Arduino D15/D14
   I2C pins) based on general Nucleo convention, but this was not
   cross-checked against the X-NUCLEO-53L5A1's specific schematic/datasheet.
   If wrong, check the shield's silkscreen or ST's UM2884/quick start PDF
   for the actual I2C routing.
3. Try a slower I2C clock speed first (100kHz instead of 400kHz) in
   `MX_I2C1_Init()` in `main.c` -- rules out signal integrity issues.
4. Check whether the sensor needs its LPn pin driven high to boot into I2C
   mode -- `VL53L5CX_Reset_Sensor()` in
   `Drivers/VL53L5CX_ULD_driver/Src/platform.c` currently does nothing
   (no LPn GPIO wired). If the shield requires LPn to be actively driven
   rather than relying on an onboard pull-up, that would explain a
   consistently silent bus.
5. Add a raw I2C bus scan (loop `HAL_I2C_IsDeviceReady()` over all 7-bit
   addresses) to rule out an address mismatch vs. a totally dead bus --
   would help distinguish "wrong address" from "no ACK from anything."

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
2. `vl53l5cx_is_alive()` check -- **currently fails here**, see above.
3. (Once alive check passes) `vl53l5cx_init()`, set 8x8 resolution, 15Hz
   ranging frequency, start ranging.
4. Loop: poll `vl53l5cx_check_data_ready()`, on a new frame print the full
   8x8 distance grid (mm) over USART2, toggle the onboard LED (PA5/LD2) as
   a heartbeat.

This is bring-up/validation code only -- no hit/miss classification logic
yet.

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

1. **Debug the I2C detection issue** (see above) -- this is the immediate
   blocker.
2. Once `vl53l5cx_is_alive()` passes: confirm `vl53l5cx_init()` succeeds
   (loads sensor firmware over I2C, takes a few hundred ms) and that the
   8x8 ranging loop produces sane distance values -- use
   `capture_serial.py` with a longer duration to grab a few frames.
3. Build hit/miss classification logic: track the position of the
   minimum-distance zone across frames, compare against a calibrated
   "opening" zone mask for this specific trash can.
4. Audio playback trigger (I2S DAC, e.g. MAX98357A) once classification
   works.
5. Longer-term: port the validated classification logic to a standalone
   ESP32 + VL53L5CX carrier board (Pololu/SparkFun), dropping the Nucleo
   dev-rig entirely for the final clip-on form factor.
