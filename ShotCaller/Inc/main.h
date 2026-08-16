#ifndef __MAIN_H
#define __MAIN_H

#ifdef __cplusplus
extern "C" {
#endif

#include "stm32f4xx_hal.h"

/* User LED on NUCLEO-F446RE: LD2, PA5 */
#define LD2_Pin        GPIO_PIN_5
#define LD2_GPIO_Port  GPIOA

/* X-NUCLEO-53L5A1 control pins.
 * ST's Arduino driver for this shield uses PWREN=A3, LPn=D5, I2C_RST=D3
 * (stm32duino/X-NUCLEO-53L5A1 examples). Translated to NUCLEO-F446RE via the
 * Nucleo-64 Arduino pin map: A3=PB0, D5=PB4, D3=PB3.
 *
 * PWR_EN gates the shield's AVDD load switch -- with it low the sensor has no
 * power at all and cannot ACK on I2C. LPn must be high for the sensor to
 * respond on the bus; toggling it low->high is the sensor's reset.
 *
 * PB3/PB4 are JTDO/NJTRST after reset; safe to repurpose as GPIO because we
 * debug over 2-wire SWD (PA13/PA14) only. */
#define VL53_PWR_EN_Pin        GPIO_PIN_0
#define VL53_PWR_EN_GPIO_Port  GPIOB
#define VL53_LPN_Pin           GPIO_PIN_4
#define VL53_LPN_GPIO_Port     GPIOB
#define VL53_I2C_RST_Pin       GPIO_PIN_3
#define VL53_I2C_RST_GPIO_Port GPIOB

void Error_Handler(void);

#ifdef __cplusplus
}
#endif

#endif /* __MAIN_H */
