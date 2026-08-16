/**
 * platform.c -- STM32 HAL I2C implementation of the VL53L5CX platform layer.
 * Uses HAL_I2C_Mem_Write/Read with 16-bit register addressing, matching the
 * VL53L5CX's register protocol.
 */
#include "platform.h"

#define VL53L5CX_I2C_TIMEOUT_MS 100

uint8_t VL53L5CX_RdByte(VL53L5CX_Platform *p_platform, uint16_t RegisterAdress, uint8_t *p_value)
{
    return VL53L5CX_RdMulti(p_platform, RegisterAdress, p_value, 1);
}

uint8_t VL53L5CX_WrByte(VL53L5CX_Platform *p_platform, uint16_t RegisterAdress, uint8_t value)
{
    return VL53L5CX_WrMulti(p_platform, RegisterAdress, &value, 1);
}

uint8_t VL53L5CX_RdMulti(VL53L5CX_Platform *p_platform, uint16_t RegisterAdress, uint8_t *p_values, uint32_t size)
{
    HAL_StatusTypeDef status = HAL_I2C_Mem_Read(
        p_platform->hi2c,
        p_platform->address,
        RegisterAdress,
        I2C_MEMADD_SIZE_16BIT,
        p_values,
        size,
        VL53L5CX_I2C_TIMEOUT_MS);

    return (status == HAL_OK) ? 0 : 1;
}

uint8_t VL53L5CX_WrMulti(VL53L5CX_Platform *p_platform, uint16_t RegisterAdress, uint8_t *p_values, uint32_t size)
{
    HAL_StatusTypeDef status = HAL_I2C_Mem_Write(
        p_platform->hi2c,
        p_platform->address,
        RegisterAdress,
        I2C_MEMADD_SIZE_16BIT,
        p_values,
        size,
        VL53L5CX_I2C_TIMEOUT_MS);

    return (status == HAL_OK) ? 0 : 1;
}

uint8_t VL53L5CX_Reset_Sensor(VL53L5CX_Platform *p_platform)
{
    /* No LPn/reset GPIO wired on the X-NUCLEO-53L5A1 by default -- power-on
     * reset only. Return OK; add GPIO toggling here if you wire LPn. */
    (void)p_platform;
    return 0;
}

void VL53L5CX_SwapBuffer(uint8_t *buffer, uint16_t size)
{
    uint32_t i, tmp;

    for (i = 0; i < size; i = i + 4) {
        tmp = ((uint32_t)buffer[i] << 24)
            | ((uint32_t)buffer[i + 1] << 16)
            | ((uint32_t)buffer[i + 2] << 8)
            | ((uint32_t)buffer[i + 3]);
        memcpy(&(buffer[i]), &tmp, 4);
    }
}

uint8_t VL53L5CX_WaitMs(VL53L5CX_Platform *p_platform, uint32_t TimeMs)
{
    (void)p_platform;
    HAL_Delay(TimeMs);
    return 0;
}
