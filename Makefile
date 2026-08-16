# ShotCaller Makefile -- command-line build, no STM32CubeIDE GUI required.
# Uses the arm-none-eabi-gcc bundled inside STM32CubeIDE.app so no separate
# toolchain install is needed. Override TOOLCHAIN_BIN to point elsewhere.

PROJECT_DIR := ShotCaller
BUILD_DIR   := build

TOOLCHAIN_BIN ?= /Applications/STM32CubeIDE.app/Contents/Eclipse/plugins/com.st.stm32cube.ide.mcu.externaltools.gnu-tools-for-stm32.14.3.rel1.macosaarch64_1.0.0.202602081740/tools/bin

CC      := $(TOOLCHAIN_BIN)/arm-none-eabi-gcc
OBJCOPY := $(TOOLCHAIN_BIN)/arm-none-eabi-objcopy
SIZE    := $(TOOLCHAIN_BIN)/arm-none-eabi-size

TARGET := shotcaller

# --- Sources ---------------------------------------------------------------
C_SOURCES := \
  $(wildcard $(PROJECT_DIR)/Src/*.c) \
  $(filter-out %_template.c, $(wildcard $(PROJECT_DIR)/Drivers/STM32F4xx_HAL_Driver/Src/*.c)) \
  $(PROJECT_DIR)/Drivers/CMSIS/Device/ST/STM32F4xx/Source/Templates/system_stm32f4xx.c \
  $(wildcard $(PROJECT_DIR)/Drivers/VL53L5CX_ULD_driver/Src/*.c)

ASM_SOURCES := $(PROJECT_DIR)/Startup/startup_stm32f446retx.s

# --- Includes ----------------------------------------------------------
C_INCLUDES := \
  -I$(PROJECT_DIR)/Inc \
  -I$(PROJECT_DIR)/Drivers/CMSIS/Include \
  -I$(PROJECT_DIR)/Drivers/CMSIS/Device/ST/STM32F4xx/Include \
  -I$(PROJECT_DIR)/Drivers/STM32F4xx_HAL_Driver/Inc \
  -I$(PROJECT_DIR)/Drivers/VL53L5CX_ULD_driver/Inc

# --- Flags ---------------------------------------------------------------
MCU := -mcpu=cortex-m4 -mthumb -mfloat-abi=soft

C_DEFS := -DSTM32F446xx -DUSE_HAL_DRIVER

CFLAGS  := $(MCU) $(C_DEFS) $(C_INCLUDES) -Wall -Wno-unused-variable -O1 -g3 \
           -ffunction-sections -fdata-sections -std=gnu11
ASFLAGS := $(MCU) -g3

LDSCRIPT := $(PROJECT_DIR)/STM32F446RETX_FLASH.ld
LDFLAGS  := $(MCU) -specs=nano.specs -T$(LDSCRIPT) \
            -Wl,--gc-sections -Wl,-Map=$(BUILD_DIR)/$(TARGET).map -lc -lm

# --- Object files ------------------------------------------------------
OBJECTS := $(addprefix $(BUILD_DIR)/, $(notdir $(C_SOURCES:.c=.o)))
OBJECTS += $(addprefix $(BUILD_DIR)/, $(notdir $(ASM_SOURCES:.s=.o)))
vpath %.c $(sort $(dir $(C_SOURCES)))
vpath %.s $(sort $(dir $(ASM_SOURCES)))

.PHONY: all clean flash

all: $(BUILD_DIR)/$(TARGET).elf $(BUILD_DIR)/$(TARGET).bin
	$(SIZE) $(BUILD_DIR)/$(TARGET).elf

$(BUILD_DIR)/%.o: %.c | $(BUILD_DIR)
	$(CC) -c $(CFLAGS) $< -o $@

$(BUILD_DIR)/%.o: %.s | $(BUILD_DIR)
	$(CC) -x assembler-with-cpp -c $(ASFLAGS) $< -o $@

$(BUILD_DIR)/$(TARGET).elf: $(OBJECTS)
	$(CC) $(OBJECTS) $(LDFLAGS) -o $@

$(BUILD_DIR)/%.bin: $(BUILD_DIR)/%.elf
	$(OBJCOPY) -O binary $< $@

$(BUILD_DIR):
	mkdir -p $@

clean:
	rm -rf $(BUILD_DIR)

flash: $(BUILD_DIR)/$(TARGET).bin
	st-flash --reset write $(BUILD_DIR)/$(TARGET).bin 0x8000000
