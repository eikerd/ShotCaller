#!/usr/bin/env python3
"""
capture_serial.py -- read the ShotCaller board's debug UART for a fixed
duration and dump it to a log file. Lets an agent (or a human) inspect
firmware output without needing an interactive terminal session.

Usage:
    python3 capture_serial.py [seconds] [output_file]

Defaults: 5 seconds, build/serial_capture.log. The ST-LINK virtual serial
device is autodetected on macOS/Linux; SHOTCALLER_PORT and SHOTCALLER_BAUD can
override the detected port and the 921600-baud project default.
"""
import glob
import sys
import os
import time
import serial

def autodetect_port():
    candidates = sorted(glob.glob("/dev/cu.usbmodem*"))
    if not candidates:
        candidates = sorted(glob.glob("/dev/ttyACM*"))
    return candidates[0] if candidates else None


PORT = os.environ.get("SHOTCALLER_PORT") or autodetect_port()
BAUD = int(os.environ.get("SHOTCALLER_BAUD", "921600"))

def main():
    duration = float(sys.argv[1]) if len(sys.argv) > 1 else 5.0
    outfile = sys.argv[2] if len(sys.argv) > 2 else "build/serial_capture.log"

    os.makedirs(os.path.dirname(outfile) or ".", exist_ok=True)

    try:
        if not PORT:
            raise serial.SerialException("no Nucleo serial device found")
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
