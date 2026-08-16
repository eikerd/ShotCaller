/**
 * ShotCaller -- VL53L5CX 8x8 zone ToF bring-up on NUCLEO-F446RE.
 * Streams the raw 8x8 distance grid over USART2 (ST-LINK VCP) so we can
 * watch it in a serial terminal and validate the sensor + wiring before
 * building hit/miss classification logic on top.
 *
 * Wiring (X-NUCLEO-53L5A1 on Arduino header):
 *   I2C1_SCL -> PB8 (D15)
 *   I2C1_SDA -> PB9 (D14)
 *   USART2   -> PA2 (TX) / PA3 (RX), routed to ST-LINK VCP, 115200 8N1
 */
#include "main.h"
#include <stdio.h>
#include <string.h>
#include "vl53l5cx_api.h"

I2C_HandleTypeDef hi2c1;
UART_HandleTypeDef huart2;

static void SystemClock_Config(void);
static void MX_GPIO_Init(void);
static void MX_I2C1_Init(void);
static void MX_USART2_UART_Init(void);

int __io_putchar(int ch)
{
    HAL_UART_Transmit(&huart2, (uint8_t *)&ch, 1, HAL_MAX_DELAY);
    return ch;
}

int main(void)
{
    HAL_Init();
    SystemClock_Config();
    MX_GPIO_Init();
    MX_I2C1_Init();
    MX_USART2_UART_Init();

    printf("\r\n--- ShotCaller / VL53L5CX bring-up ---\r\n");

    VL53L5CX_Configuration dev;
    memset(&dev, 0, sizeof(dev));
    dev.platform.hi2c = &hi2c1;
    dev.platform.address = VL53L5CX_DEFAULT_I2C_ADDRESS; /* 0x52, 8-bit */

    uint8_t is_alive = 0;
    uint8_t status = vl53l5cx_is_alive(&dev, &is_alive);
    if (status != VL53L5CX_STATUS_OK || !is_alive) {
        printf("ERROR: VL53L5CX not detected on I2C1 (check wiring/addr)\r\n");
        Error_Handler();
    }
    printf("VL53L5CX detected. Loading firmware (few hundred ms)...\r\n");

    status = vl53l5cx_init(&dev);
    if (status != VL53L5CX_STATUS_OK) {
        printf("ERROR: vl53l5cx_init failed, status=%u\r\n", status);
        Error_Handler();
    }
    printf("Init OK. Starting 8x8 ranging.\r\n");

    vl53l5cx_set_resolution(&dev, VL53L5CX_RESOLUTION_8X8);
    vl53l5cx_set_ranging_frequency_hz(&dev, 15);
    vl53l5cx_start_ranging(&dev);

    VL53L5CX_ResultsData results;

    while (1) {
        uint8_t ready = 0;
        vl53l5cx_check_data_ready(&dev, &ready);

        if (ready) {
            vl53l5cx_get_ranging_data(&dev, &results);

            printf("\r\n--- frame (mm) ---\r\n");
            for (int row = 0; row < 8; row++) {
                for (int col = 0; col < 8; col++) {
                    int idx = row * 8 + col;
                    printf("%5d", results.distance_mm[idx]);
                }
                printf("\r\n");
            }

            HAL_GPIO_TogglePin(LD2_GPIO_Port, LD2_Pin);
        }

        HAL_Delay(5);
    }
}

void Error_Handler(void)
{
    __disable_irq();
    while (1) {
        HAL_GPIO_TogglePin(LD2_GPIO_Port, LD2_Pin);
        HAL_Delay(100);
    }
}

/* HSI (16MHz, internal) -> PLL -> 84MHz SYSCLK. Avoids depending on the
 * ST-LINK's HSE/MCO being present or correctly configured. */
static void SystemClock_Config(void)
{
    RCC_OscInitTypeDef RCC_OscInitStruct = {0};
    RCC_ClkInitTypeDef RCC_ClkInitStruct = {0};

    __HAL_RCC_PWR_CLK_ENABLE();
    __HAL_PWR_VOLTAGESCALING_CONFIG(PWR_REGULATOR_VOLTAGE_SCALE1);

    RCC_OscInitStruct.OscillatorType = RCC_OSCILLATORTYPE_HSI;
    RCC_OscInitStruct.HSIState = RCC_HSI_ON;
    RCC_OscInitStruct.HSICalibrationValue = RCC_HSICALIBRATION_DEFAULT;
    RCC_OscInitStruct.PLL.PLLState = RCC_PLL_ON;
    RCC_OscInitStruct.PLL.PLLSource = RCC_PLLSOURCE_HSI;
    RCC_OscInitStruct.PLL.PLLM = 8;
    RCC_OscInitStruct.PLL.PLLN = 168;
    RCC_OscInitStruct.PLL.PLLP = RCC_PLLP_DIV4;
    RCC_OscInitStruct.PLL.PLLQ = 7;
    if (HAL_RCC_OscConfig(&RCC_OscInitStruct) != HAL_OK) {
        Error_Handler();
    }

    RCC_ClkInitStruct.ClockType = RCC_CLOCKTYPE_HCLK | RCC_CLOCKTYPE_SYSCLK
        | RCC_CLOCKTYPE_PCLK1 | RCC_CLOCKTYPE_PCLK2;
    RCC_ClkInitStruct.SYSCLKSource = RCC_SYSCLKSOURCE_PLLCLK;
    RCC_ClkInitStruct.AHBCLKDivider = RCC_SYSCLK_DIV1;
    RCC_ClkInitStruct.APB1CLKDivider = RCC_HCLK_DIV2;
    RCC_ClkInitStruct.APB2CLKDivider = RCC_HCLK_DIV1;
    if (HAL_RCC_ClockConfig(&RCC_ClkInitStruct, FLASH_LATENCY_2) != HAL_OK) {
        Error_Handler();
    }
}

static void MX_GPIO_Init(void)
{
    GPIO_InitTypeDef GPIO_InitStruct = {0};

    __HAL_RCC_GPIOA_CLK_ENABLE();

    HAL_GPIO_WritePin(LD2_GPIO_Port, LD2_Pin, GPIO_PIN_RESET);

    GPIO_InitStruct.Pin = LD2_Pin;
    GPIO_InitStruct.Mode = GPIO_MODE_OUTPUT_PP;
    GPIO_InitStruct.Pull = GPIO_NOPULL;
    GPIO_InitStruct.Speed = GPIO_SPEED_FREQ_LOW;
    HAL_GPIO_Init(LD2_GPIO_Port, &GPIO_InitStruct);
}

static void MX_I2C1_Init(void)
{
    hi2c1.Instance = I2C1;
    hi2c1.Init.ClockSpeed = 400000; /* 400kHz fast mode */
    hi2c1.Init.DutyCycle = I2C_DUTYCYCLE_2;
    hi2c1.Init.OwnAddress1 = 0;
    hi2c1.Init.AddressingMode = I2C_ADDRESSINGMODE_7BIT;
    hi2c1.Init.DualAddressMode = I2C_DUALADDRESS_DISABLE;
    hi2c1.Init.OwnAddress2 = 0;
    hi2c1.Init.GeneralCallMode = I2C_GENERALCALL_DISABLE;
    hi2c1.Init.NoStretchMode = I2C_NOSTRETCH_DISABLE;
    if (HAL_I2C_Init(&hi2c1) != HAL_OK) {
        Error_Handler();
    }
}

static void MX_USART2_UART_Init(void)
{
    huart2.Instance = USART2;
    huart2.Init.BaudRate = 115200;
    huart2.Init.WordLength = UART_WORDLENGTH_8B;
    huart2.Init.StopBits = UART_STOPBITS_1;
    huart2.Init.Parity = UART_PARITY_NONE;
    huart2.Init.Mode = UART_MODE_TX_RX;
    huart2.Init.HwFlowCtl = UART_HWCONTROL_NONE;
    huart2.Init.OverSampling = UART_OVERSAMPLING_16;
    if (HAL_UART_Init(&huart2) != HAL_OK) {
        Error_Handler();
    }
}
