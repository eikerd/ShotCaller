#!/usr/bin/env python3
"""
capture_serial.py -- read the ShotCaller board's debug UART for a fixed
duration and dump it to a log file. Lets an agent (or a human) inspect
firmware output without needing an interactive terminal session.

Usage:
    python3 capture_serial.py [seconds] [output_file]

Defaults: 5 seconds, build/serial_capture.log
Port and baud are fixed to this project's known values (ST-LINK VCP on
NUCLEO-F446RE, USART2 at 115200 8N1) -- override with SHOTCALLER_PORT env
var if the device path changes (check `ls /dev/cu.usbmodem*`).
"""
import sys
import os
import time
import serial

PORT = os.environ.get("SHOTCALLER_PORT", "/dev/cu.usbmodem2244103")
BAUD = int(os.environ.get("SHOTCALLER_BAUD", "921600"))

def main():
    duration = float(sys.argv[1]) if len(sys.argv) > 1 else 5.0
    outfile = sys.argv[2] if len(sys.argv) > 2 else "build/serial_capture.log"

    os.makedirs(os.path.dirname(outfile) or ".", exist_ok=True)

    try:
        ser = serial.Serial(PORT, BAUD, timeout=0.5)
    except serial.SerialException as e:
        print(f"ERROR opening {PORT}: {e}", file=sys.stderr)
        print("Check the port with: ls /dev/cu.usbmodem*", file=sys.stderr)
        sys.exit(1)

    print(f"Capturing {PORT} @ {BAUD} for {duration}s -> {outfile}")
    start = time.time()
    data = b""
    while time.time() - start < duration:
        chunk = ser.read(4096)
        if chunk:
            data += chunk
    ser.close()

    with open(outfile, "wb") as f:
        f.write(data)

    text = data.decode("utf-8", errors="replace")
    print(f"--- {len(data)} bytes captured ---")
    print(text)

if __name__ == "__main__":
    main()
