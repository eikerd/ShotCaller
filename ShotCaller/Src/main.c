/**
 * ShotCaller -- VL53L5CX 8x8 zone ToF bring-up on NUCLEO-F446RE.
 * Streams the raw 8x8 distance grid over USART2 (ST-LINK VCP) so we can
 * watch it in a serial terminal and validate the sensor + wiring before
 * building hit/miss classification logic on top.
 *
 * Wiring (X-NUCLEO-53L5A1 on Arduino header):
 *   I2C1_SCL -> PB8 (D15)
 *   I2C1_SDA -> PB9 (D14)
 *   PWR_EN   -> PB0 (A3)   -- gates the shield's AVDD load switch
 *   LPn      -> PB4 (D5)   -- must be high for the sensor to talk on I2C
 *   I2C_RST  -> PB3 (D3)   -- pulse high to reset the sensor's I2C block
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
static void VL53_PowerUp(void);
static void I2C_BusScan(void);
static void StreamFrame(VL53L5CX_ResultsData *r, uint32_t frame_id);
static void ApplyConfig(VL53L5CX_Configuration *dev);
static void PollCommands(VL53L5CX_Configuration *dev);

/* Live sensor configuration, retunable from the host over UART (see
 * PollCommands). The product default is 4x4 at 60Hz: trajectory tracking is
 * limited by time resolution long before it is limited by zone count. */
static uint8_t g_res       = VL53L5CX_RESOLUTION_4X4;
static uint8_t g_hz        = 60;
static uint8_t g_mode      = VL53L5CX_RANGING_MODE_CONTINUOUS;
static uint8_t g_streaming = 1;
/* Tracked because vl53l5cx_stop_ranging() polls for a stop acknowledgement the
 * sensor never sends when it was not ranging, burning its full 5s timeout
 * (vl53l5cx_api.c:642) on every such call -- including the very first config
 * apply at boot. */
static uint8_t g_ranging   = 0;

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

    VL53_PowerUp();
    I2C_BusScan();

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
    printf("# init OK\r\n");

    ApplyConfig(&dev);

    VL53L5CX_ResultsData results;
    uint32_t frame_id = 0;

    while (1) {
        PollCommands(&dev);

        uint8_t ready = 0;
        vl53l5cx_check_data_ready(&dev, &ready);

        if (ready) {
            vl53l5cx_get_ranging_data(&dev, &results);
            if (g_streaming) {
                StreamFrame(&results, frame_id++);
            }
            HAL_GPIO_TogglePin(LD2_GPIO_Port, LD2_Pin);
        }

        /* No HAL_Delay here: at 60Hz (4x4) a frame lands every ~16ms, and a
         * fixed sleep would alias against the sensor's cadence and cost us
         * frames -- exactly the timing resolution we are trying to measure. */
    }
}

/* ---- Host streaming protocol ------------------------------------------
 * One line per frame, parsed by tools/viz_server.py:
 *
 *   F,<id>,<t_ms>,<res>,<hz>,<d>:<st>:<sig>,<d>:<st>:<sig>,...
 *
 * where res is 4 or 8 (grid edge), one zone triple follows per zone in
 * raster order, d = distance_mm, st = target_status, sig = signal_per_spad
 * (kcps/SPAD). Lines beginning with '#' are human-readable log/banner text
 * and 'C,' lines report the active configuration.
 *
 * The whole frame is composed into one buffer and pushed with a single
 * blocking UART transmit. Going through printf() would issue one
 * HAL_UART_Transmit per *character* (see __io_putchar), which at 8x8 is
 * ~900 separate blocking calls per frame -- enough overhead to throttle the
 * capture rate we are trying to characterize. */
static char frame_buf[2048];

static void UartWrite(const char *s, int len)
{
    HAL_UART_Transmit(&huart2, (uint8_t *)s, (uint16_t)len, HAL_MAX_DELAY);
}

static void StreamFrame(VL53L5CX_ResultsData *r, uint32_t frame_id)
{
    int zones = (g_res == VL53L5CX_RESOLUTION_8X8) ? 64 : 16;
    int edge = (g_res == VL53L5CX_RESOLUTION_8X8) ? 8 : 4;
    int n = 0;

    n += snprintf(frame_buf + n, sizeof(frame_buf) - n, "F,%lu,%lu,%d,%u",
                  (unsigned long)frame_id, (unsigned long)HAL_GetTick(),
                  edge, g_hz);

    for (int i = 0; i < zones; i++) {
        int idx = VL53L5CX_NB_TARGET_PER_ZONE * i;
        n += snprintf(frame_buf + n, sizeof(frame_buf) - n, ",%d:%u:%lu",
                      r->distance_mm[idx],
                      r->target_status[idx],
                      (unsigned long)r->signal_per_spad[idx]);
    }

    n += snprintf(frame_buf + n, sizeof(frame_buf) - n, "\r\n");
    UartWrite(frame_buf, n);
}

/* Reconfigure and (re)start ranging. Ranging must be stopped before
 * resolution or frequency can change -- the sensor rejects the write
 * otherwise, which is a quiet way to end up convinced a setting "didn't do
 * anything". */
static void ApplyConfig(VL53L5CX_Configuration *dev)
{
    if (g_ranging) {
        vl53l5cx_stop_ranging(dev);
        g_ranging = 0;
    }

    vl53l5cx_set_resolution(dev, g_res);
    vl53l5cx_set_ranging_frequency_hz(dev, g_hz);
    vl53l5cx_set_ranging_mode(dev, g_mode);
    /* A small projectile is normally in front of a stronger, static wall or
     * bin return. Closest-first keeps that projectile in target slot zero,
     * which is the slot streamed to the host. */
    vl53l5cx_set_target_order(dev, VL53L5CX_TARGET_ORDER_CLOSEST);

    vl53l5cx_start_ranging(dev);
    g_ranging = 1;

    int edge = (g_res == VL53L5CX_RESOLUTION_8X8) ? 8 : 4;
    int n = snprintf(frame_buf, sizeof(frame_buf),
                     "C,res=%d,hz=%u,mode=%s,max_hz=%d,target=closest\r\n",
                     edge, g_hz,
                     (g_mode == VL53L5CX_RANGING_MODE_CONTINUOUS) ? "cont" : "auto",
                     (g_res == VL53L5CX_RESOLUTION_8X8) ? 15 : 60);
    UartWrite(frame_buf, n);
}

/* Single-character commands from the host, polled non-blocking so the
 * ranging loop never stalls waiting on input. Lets the web UI retune the
 * sensor live instead of requiring a rebuild+reflash per experiment. */
static void PollCommands(VL53L5CX_Configuration *dev)
{
    /* Deliberately a raw register poll rather than HAL_UART_Receive(): that
     * call locks the UART handle, and a byte arriving while we are inside
     * ApplyConfig() (tens of ms) overruns the receiver. The HAL's error path
     * can then leave the handle in a state where every subsequent
     * HAL_UART_Transmit() returns BUSY -- the board keeps ranging but goes
     * permanently silent, recoverable only by reset. Reading SR then DR here
     * also clears ORE, so an overrun self-heals. */
    if (__HAL_UART_GET_FLAG(&huart2, UART_FLAG_ORE)) {
        __HAL_UART_CLEAR_OREFLAG(&huart2);
    }
    if (!__HAL_UART_GET_FLAG(&huart2, UART_FLAG_RXNE)) {
        return;
    }
    uint8_t c = (uint8_t)(huart2.Instance->DR & 0xFFU);

    switch (c) {
    case '4': /* 4x4 -- up to 60Hz, the mode that can actually track a throw */
        g_res = VL53L5CX_RESOLUTION_4X4;
        if (g_hz > 60) g_hz = 60;
        ApplyConfig(dev);
        break;
    case '8': /* 8x8 -- 4x the spatial detail, but capped at 15Hz */
        g_res = VL53L5CX_RESOLUTION_8X8;
        if (g_hz > 15) g_hz = 15;
        ApplyConfig(dev);
        break;
    case '+': {
        uint8_t max_hz = (g_res == VL53L5CX_RESOLUTION_8X8) ? 15 : 60;
        if (g_hz < max_hz) { g_hz++; ApplyConfig(dev); }
        break;
    }
    case '-':
        if (g_hz > 1) { g_hz--; ApplyConfig(dev); }
        break;
    case 'M': /* jump straight to the ceiling for the current resolution.
               * Worth having as its own command: RX is polled one byte at a
               * time with no buffer, so a burst of '+' sent while we are
               * inside ApplyConfig() is silently overrun and lost. */
        g_hz = (g_res == VL53L5CX_RESOLUTION_8X8) ? 15 : 60;
        ApplyConfig(dev);
        break;
    case 'm': /* continuous vs autonomous ranging mode */
        g_mode = (g_mode == VL53L5CX_RANGING_MODE_CONTINUOUS)
               ? VL53L5CX_RANGING_MODE_AUTONOMOUS
               : VL53L5CX_RANGING_MODE_CONTINUOUS;
        ApplyConfig(dev);
        break;
    case 'p':
        g_streaming = !g_streaming;
        break;
    case '?':
        ApplyConfig(dev);
        break;
    default:
        break;
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
    __HAL_RCC_GPIOB_CLK_ENABLE();

    HAL_GPIO_WritePin(LD2_GPIO_Port, LD2_Pin, GPIO_PIN_RESET);

    GPIO_InitStruct.Pin = LD2_Pin;
    GPIO_InitStruct.Mode = GPIO_MODE_OUTPUT_PP;
    GPIO_InitStruct.Pull = GPIO_NOPULL;
    GPIO_InitStruct.Speed = GPIO_SPEED_FREQ_LOW;
    HAL_GPIO_Init(LD2_GPIO_Port, &GPIO_InitStruct);

    /* Shield control pins start in their "sensor held off" state: power gate
     * open, LPn low (sensor mute on I2C), I2C_RST released low. */
    HAL_GPIO_WritePin(VL53_PWR_EN_GPIO_Port, VL53_PWR_EN_Pin, GPIO_PIN_RESET);
    HAL_GPIO_WritePin(VL53_LPN_GPIO_Port, VL53_LPN_Pin, GPIO_PIN_RESET);
    HAL_GPIO_WritePin(VL53_I2C_RST_GPIO_Port, VL53_I2C_RST_Pin, GPIO_PIN_RESET);

    GPIO_InitStruct.Pin = VL53_PWR_EN_Pin | VL53_LPN_Pin | VL53_I2C_RST_Pin;
    GPIO_InitStruct.Mode = GPIO_MODE_OUTPUT_PP;
    GPIO_InitStruct.Pull = GPIO_NOPULL;
    GPIO_InitStruct.Speed = GPIO_SPEED_FREQ_LOW;
    HAL_GPIO_Init(GPIOB, &GPIO_InitStruct);
}

/* Bring the X-NUCLEO-53L5A1 up in the same order ST's own driver does:
 * enable the AVDD load switch, let it settle, pulse I2C_RST, then release LPn
 * high so the sensor answers on the bus. Skipping the PWR_EN step leaves the
 * sensor unpowered and silent -- which is exactly how this bring-up failed
 * before the pin mapping was tracked down. */
static void VL53_PowerUp(void)
{
    HAL_GPIO_WritePin(VL53_PWR_EN_GPIO_Port, VL53_PWR_EN_Pin, GPIO_PIN_SET);
    HAL_Delay(10);

    HAL_GPIO_WritePin(VL53_LPN_GPIO_Port, VL53_LPN_Pin, GPIO_PIN_RESET);
    HAL_Delay(10);

    HAL_GPIO_WritePin(VL53_I2C_RST_GPIO_Port, VL53_I2C_RST_Pin, GPIO_PIN_SET);
    HAL_Delay(10);
    HAL_GPIO_WritePin(VL53_I2C_RST_GPIO_Port, VL53_I2C_RST_Pin, GPIO_PIN_RESET);
    HAL_Delay(10);

    HAL_GPIO_WritePin(VL53_LPN_GPIO_Port, VL53_LPN_Pin, GPIO_PIN_SET);
    HAL_Delay(10);
}

/* Raw 7-bit address sweep. Distinguishes "sensor answering at an unexpected
 * address" from "nothing on the bus at all" -- the two failure modes look
 * identical from vl53l5cx_is_alive() alone. */
static void I2C_BusScan(void)
{
    int found = 0;

    printf("I2C1 scan:");
    for (uint8_t addr = 0x08; addr < 0x78; addr++) {
        if (HAL_I2C_IsDeviceReady(&hi2c1, (uint16_t)(addr << 1), 2, 5) == HAL_OK) {
            printf(" 0x%02X", addr);
            found++;
        }
    }
    if (!found) {
        printf(" (no devices responded)");
    }
    printf("\r\n  expecting 0x29 (7-bit) = 0x52 (8-bit) for VL53L5CX\r\n");
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
    /* 921600 rather than 115200: an 8x8 frame with distance+status+signal is
     * ~900 bytes, so 15Hz needs ~13.5KB/s and 115200 baud only carries
     * ~11.5KB/s. At that rate the UART, not the sensor, would set the frame
     * rate -- useless when measuring how fast the sensor can actually see. */
    huart2.Init.BaudRate = 921600;
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
