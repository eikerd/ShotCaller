/**
 * platform.h -- STM32 HAL I2C platform layer for the VL53L5CX ULD driver.
 * Written for ShotCaller / NUCLEO-F446RE (replaces the ESP-IDF platform
 * this driver source was originally paired with).
 */
#ifndef _PLATFORM_H_
#define _PLATFORM_H_

#ifdef __cplusplus
extern "C" {
#endif

#include <stdint.h>
#include <string.h>
#include "stm32f4xx_hal.h"

#define VL53L5CX_NB_TARGET_PER_ZONE 1U
#define VL53L5CX_MAX_CLK_SPEED 1000000

typedef struct
{
    I2C_HandleTypeDef *hi2c;
    uint16_t address;      /* 8-bit-shifted I2C address, e.g. 0x52 */
} VL53L5CX_Platform;

uint8_t VL53L5CX_RdByte(VL53L5CX_Platform *p_platform, uint16_t RegisterAdress, uint8_t *p_value);
uint8_t VL53L5CX_WrByte(VL53L5CX_Platform *p_platform, uint16_t RegisterAdress, uint8_t value);
uint8_t VL53L5CX_RdMulti(VL53L5CX_Platform *p_platform, uint16_t RegisterAdress, uint8_t *p_values, uint32_t size);
uint8_t VL53L5CX_WrMulti(VL53L5CX_Platform *p_platform, uint16_t RegisterAdress, uint8_t *p_values, uint32_t size);
uint8_t VL53L5CX_Reset_Sensor(VL53L5CX_Platform *p_platform);
void VL53L5CX_SwapBuffer(uint8_t *buffer, uint16_t size);
uint8_t VL53L5CX_WaitMs(VL53L5CX_Platform *p_platform, uint32_t TimeMs);

#ifdef __cplusplus
}
#endif

#endif /* _PLATFORM_H_ */
