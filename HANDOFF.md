# ShotCaller -- Handoff / Status

Trash-can trick-shot detector. VL53L5CX 8x8-zone ToF sensor mounted at the
rim classifies thrown objects as "in" vs "miss" and triggers audio samples.
Long-term target is a standalone ESP32 build; current phase is bring-up on
an STM32 Nucleo bench rig to validate the sensor before porting.

## Hardware

- Sensor: STMicro VL53L5CX (8x8 zone ToF), on ST's **X-NUCLEO-53L5A1**
  expansion board (Arduino-shield form factor).
- MCU: **NUCLEO-F446RE** -- confirmed via `st-info --probe` reading the
  actual chip ID over SWD (0x421 -> STM32F446), *not* read off a label.
  This is NOT one of ST's officially pre-packaged X-NUCLEO-53L5A1 targets
  (those are F401RE / L476RG) -- pin-compatible via the same Arduino Uno R3
  + ST Morpho connectors, but required hand-porting the I2C platform layer
  and peripheral init instead of using ST's prebuilt example.
- Wiring in use: I2C1 on PB8 (SCL) / PB9 (SDA), USART2 debug output on
  PA2 (TX) routed to the ST-LINK virtual COM port, 115200 8N1.

## Toolchain

- STM32CubeIDE installed on the Mac (Apple Silicon), via manual download
  from st.com (myST account required -- not automatable).
- `stlink` CLI tools installed via Homebrew (`brew install stlink`) for
  probing the board over SWD (`st-info --probe`).
- **Known IDE quirk**: this STM32CubeIDE install's New Project wizard does
  NOT expose the classic CubeMX/.ioc board-selector flow (no MCU firmware
  package downloaded yet, or a changed wizard layout -- unconfirmed which).
  "STM32CubeIDE Empty Project" only sets the target chip for the
  linker/startup files; it does not generate HAL drivers, a `.ioc` file,
  or any peripheral init code. We worked around this by hand-assembling
  the firmware (see below) rather than continuing to fight the GUI.
  Worth revisiting: Help -> Manage Embedded Software Packages, to install
  the STM32F4 MCU package, which may unlock the normal board-based wizard
  for future projects.

## Project layout

`/Users/ernestoikerd/repos/gedgets/ShotCaller/ShotCaller/` (note the
doubled `ShotCaller/ShotCaller` -- the outer dir is the Eclipse workspace
root, set to the repo folder; the inner one is the actual CubeIDE project).

```
ShotCaller/ShotCaller/
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
    CMSIS/Include/                          -- ARM core headers (from ARM-software/CMSIS_5)
    CMSIS/Device/ST/STM32F4xx/              -- F446 register defs + system_stm32f4xx.c
                                                (from STMicroelectronics/cmsis_device_f4)
    STM32F4xx_HAL_Driver/{Src,Inc}/         -- full HAL driver
                                                (from STMicroelectronics/stm32f4xx_hal_driver)
    VL53L5CX_ULD_driver/{Src,Inc}/          -- ULD driver core (plain C), sourced from
                                                RJRP44/VL53L5CX-Library (BSD-3-Clause,
                                                originally ST source ported for ESP-IDF)
      Src/platform.c, Inc/platform.h        -- HAND-WRITTEN by us: STM32 HAL I2C
                                                implementation replacing the ESP-IDF
                                                version that shipped with that repo
```

All third-party source was cloned directly from GitHub (not downloaded
through ST's gated myST portal) -- see repo URLs above. BSD-3-Clause /
STMicroelectronics original license headers are intact in each file.

## What main.c does

1. `HAL_Init()`, clock config (HSI 16MHz -> PLL -> 84MHz SYSCLK -- chosen to
   avoid depending on HSE/MCO stability), GPIO/I2C1/USART2 init.
2. `vl53l5cx_is_alive()` check, then `vl53l5cx_init()` (loads sensor
   firmware over I2C, takes a few hundred ms).
3. Sets 8x8 resolution, 15Hz ranging frequency, starts ranging.
4. Loop: poll `vl53l5cx_check_data_ready()`, on a new frame print the full
   8x8 distance grid (mm) over USART2, toggle the onboard LED (PA5/LD2) as
   a heartbeat.

This is bring-up/validation code only -- no hit/miss classification logic
yet. That's the next real feature once the sensor is confirmed working.

## NOT yet done / next steps

1. **Has never been built.** No compile attempt yet in STM32CubeIDE --
   this codebase has not been verified to actually compile. Likely issues:
   - Include paths: `Drivers/**/Inc` folders are not yet added to the
     project's C/C++ Build include search path. This almost certainly
     needs to be done via STM32CubeIDE's Project Properties -> C/C++
     Build -> Settings -> MCU GCC Compiler -> Include Paths (add all four
     `Inc`/`Include` dirs listed in the tree above), since this project's
     `.cproject`/`.settings` don't appear to auto-discover new folders
     added outside the IDE.
   - Possible missing-symbol or type mismatches between the HAL version
     pulled from GitHub `main` branch (unpinned, whatever was latest at
     clone time) and the CMSIS device header version, since we didn't
     pin specific tags/releases when cloning -- worth checking these are
     mutually compatible versions if build errors mention type/macro
     mismatches.
   - `vl53l5cx_buffers.h` is large (~22k lines, the embedded sensor
     firmware blob) -- first build will be slow.
2. Once it builds: flash + open a serial terminal (screen, minicom, or
   CubeIDE's built-in console) on `/dev/cu.usbmodem2244103` at 115200 to
   watch the 8x8 grid stream.
3. Debug sensor bring-up issues if `vl53l5cx_is_alive()` fails (I2C
   wiring/address, pull-ups, power).
4. Once raw ranging data is confirmed working: build the hit/miss
   classification logic (track the position of the minimum-distance zone
   across frames, compare against a calibrated "opening" zone mask for
   this specific trash can).
5. Audio playback trigger (I2S DAC, e.g. MAX98357A) once classification
   works.
6. Longer-term: port the validated classification logic to a standalone
   ESP32 + VL53L5CX carrier board (Pololu/SparkFun), dropping the Nucleo
   dev-rig entirely for the final clip-on form factor.
