#ifndef __MAIN_H
#define __MAIN_H

#ifdef __cplusplus
extern "C" {
#endif

#include "stm32f4xx_hal.h"

/* User LED on NUCLEO-F446RE: LD2, PA5 */
#define LD2_Pin        GPIO_PIN_5
#define LD2_GPIO_Port  GPIOA

void Error_Handler(void);

#ifdef __cplusplus
}
#endif

#endif /* __MAIN_H */
