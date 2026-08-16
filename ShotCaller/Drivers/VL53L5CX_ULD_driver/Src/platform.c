/**
 * platform.c -- STM32 HAL I2C implementation of the VL53L5CX platform layer.
 * Uses HAL_I2C_Mem_Write/Read with 16-bit register addressing, matching the
 * VL53L5CX's register protocol.
 */
#include "platform.h"
#include "main.h"   /* VL53_LPN_* / VL53_I2C_RST_* shield pin definitions */

/* vl53l5cx_init() uploads the sensor firmware as three single writes of
 * 0x8000 (32768) bytes. At 400kHz that is ~32768*9/400000 = ~0.74s of bus time
 * per chunk, so the timeout has to clear that with margin -- a 100ms timeout
 * aborts the upload mid-flight and surfaces as a generic init status=1. */
#define VL53L5CX_I2C_TIMEOUT_MS 2000

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
    (void)p_platform;

    /* Sensor reset on the X-NUCLEO-53L5A1 is an LPn low->high toggle, with the
     * I2C block reset pulsed in between (same sequence as ST's Arduino driver). */
    HAL_GPIO_WritePin(VL53_LPN_GPIO_Port, VL53_LPN_Pin, GPIO_PIN_RESET);
    HAL_Delay(10);

    HAL_GPIO_WritePin(VL53_I2C_RST_GPIO_Port, VL53_I2C_RST_Pin, GPIO_PIN_SET);
    HAL_Delay(10);
    HAL_GPIO_WritePin(VL53_I2C_RST_GPIO_Port, VL53_I2C_RST_Pin, GPIO_PIN_RESET);
    HAL_Delay(10);

    HAL_GPIO_WritePin(VL53_LPN_GPIO_Port, VL53_LPN_Pin, GPIO_PIN_SET);
    HAL_Delay(10);

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
