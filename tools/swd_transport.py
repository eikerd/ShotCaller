"""Read live ShotCaller ToF frames from MCU SRAM through ST-LINK SWD."""

import ctypes
import glob
import os
import struct
import subprocess
import time


SWD_FRAME_MAGIC = 0x544F4853  # "SHOT" in little-endian memory order.
SWD_RING_SLOTS = 32
SWD_RING_HEADER_STRUCT = struct.Struct("<II")
SWD_FRAME_STRUCT = struct.Struct("<IIIBBH64BI")
STLINK_Q_BUFFER_SIZE = 1024 * 100
# The seqlock marker leading each ring slot, read on its own around a copy.
SEQUENCE_SIZE = 4
SEQUENCE_STRUCT = struct.Struct("<I")


class SwdUnavailable(RuntimeError):
    """The local ST-LINK library, probe, ELF, or shared frame is unavailable."""


class _StlinkMemory(ctypes.Structure):
    # Stable prefix of stlink_t from libstlink's public stlink.h. The read API
    # writes target memory into q_buf; fields after it are deliberately omitted.
    _fields_ = [
        ("backend", ctypes.c_void_p),
        ("backend_data", ctypes.c_void_p),
        ("c_buf", ctypes.c_ubyte * 32),
        ("q_buf", ctypes.c_ubyte * STLINK_Q_BUFFER_SIZE),
    ]


def _find_library():
    override = os.environ.get("SHOTCALLER_STLINK_LIB")
    candidates = [
        override,
        "/opt/homebrew/opt/stlink/lib/libstlink.dylib",
        "/usr/local/opt/stlink/lib/libstlink.dylib",
    ]
    for candidate in candidates:
        if candidate and os.path.isfile(candidate):
            return candidate
    raise SwdUnavailable("libstlink was not found")


def _find_nm():
    override = os.environ.get("SHOTCALLER_NM")
    candidates = [override]
    candidates.extend(glob.glob(
        "/Applications/STM32CubeIDE.app/Contents/Eclipse/plugins/"
        "com.st.stm32cube.ide.mcu.externaltools.gnu-tools-for-stm32.*"
        "/tools/bin/arm-none-eabi-nm"
    ))
    for candidate in candidates:
        if candidate and os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    raise SwdUnavailable("arm-none-eabi-nm was not found")


def find_symbol_address(elf_path, symbol="g_swd_frame"):
    """Resolve the shared-frame address from the exact firmware ELF."""
    if not os.path.isfile(elf_path):
        raise SwdUnavailable(f"firmware ELF was not found: {elf_path}")
    try:
        result = subprocess.run(
            [_find_nm(), "-an", elf_path],
            check=True,
            capture_output=True,
            text=True,
        )
    except (OSError, subprocess.CalledProcessError) as exc:
        raise SwdUnavailable(f"could not inspect firmware ELF: {exc}") from exc
    for line in result.stdout.splitlines():
        fields = line.split()
        if len(fields) >= 3 and fields[-1] == symbol:
            return int(fields[0], 16)
    raise SwdUnavailable(f"{symbol} is missing from {elf_path}")


def decode_swd_frame(payload, received_at=None):
    """Decode one compact seqlock-protected frame from the SRAM ring."""
    if len(payload) < SWD_FRAME_STRUCT.size:
        return None
    values = SWD_FRAME_STRUCT.unpack_from(payload)
    sequence, frame_id, tick_ms, edge, hz, zones = values[:6]
    sequence_end = values[-1]
    if (
        sequence & 1
        or sequence != sequence_end
        or edge not in (4, 8)
        or zones != edge * edge
    ):
        return None

    quantized = list(values[6:70])[:zones]
    distances = [value * 16 if value != 0xFF else 0 for value in quantized]
    statuses = [5 if value != 0xFF else 0 for value in quantized]
    signals = [1 if value != 0xFF else 0 for value in quantized]
    return {
        "id": frame_id,
        "t": tick_ms,
        "edge": edge,
        "hz": hz,
        "d": distances,
        "s": statuses,
        "sig": signals,
        "rx": time.time() if received_at is None else received_at,
        "_sequence": sequence,
    }


def decode_slot_sequence(payload):
    """The leading seqlock marker of a ring slot, or None if unreadable."""
    if len(payload) < SEQUENCE_SIZE:
        return None
    return SEQUENCE_STRUCT.unpack_from(payload)[0]


def decode_ring_header(payload):
    if len(payload) < SWD_RING_HEADER_STRUCT.size:
        return None
    magic, write_count = SWD_RING_HEADER_STRUCT.unpack_from(payload)
    return write_count if magic == SWD_FRAME_MAGIC else None


class SwdProbe:
    """Minimal libstlink wrapper that reads SRAM without halting the MCU."""

    def __init__(self, library_path=None):
        self.library = ctypes.CDLL(library_path or _find_library())
        handle_type = ctypes.POINTER(_StlinkMemory)
        self.library.stlink_open_usb.argtypes = [
            ctypes.c_int,
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_int32,
        ]
        self.library.stlink_open_usb.restype = handle_type
        self.library.stlink_read_mem32.argtypes = [
            handle_type,
            ctypes.c_uint32,
            ctypes.c_uint16,
        ]
        self.library.stlink_read_mem32.restype = ctypes.c_int32
        self.library.stlink_close.argtypes = [handle_type]
        self.library.stlink_close.restype = None
        # UERROR=20, CONNECT_HOT_PLUG=0, 1.8 MHz divisor=1. Hot-plug was
        # physically verified to leave the STM32 in TARGET_RUNNING state.
        self.handle = self.library.stlink_open_usb(20, 0, None, 1)
        if not self.handle:
            raise SwdUnavailable("ST-LINK debug probe could not be opened")

    def read(self, address, size):
        aligned_size = (size + 3) & ~3
        if aligned_size > 0xFFFF:
            raise ValueError("one SWD read cannot exceed 65535 bytes")
        result = self.library.stlink_read_mem32(
            self.handle, address, aligned_size
        )
        if result != 0:
            raise SwdUnavailable(f"ST-LINK SRAM read failed: {result}")
        return bytes(self.handle.contents.q_buf[:size])

    def close(self):
        if self.handle:
            self.library.stlink_close(self.handle)
            self.handle = None

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        self.close()


def iter_frames(elf_path, stop_requested=lambda: False, poll_seconds=0.008):
    """Yield each new, internally consistent live frame from MCU SRAM."""
    address = find_symbol_address(elf_path)
    last_write_count = None
    with SwdProbe() as probe:
        while not stop_requested():
            header = probe.read(address, SWD_RING_HEADER_STRUCT.size)
            write_count = decode_ring_header(header)
            if write_count is None or write_count == 0:
                time.sleep(poll_seconds)
                continue
            slot_index = (write_count - 1) % SWD_RING_SLOTS
            slot_address = (
                address + SWD_RING_HEADER_STRUCT.size
                + slot_index * SWD_FRAME_STRUCT.size
            )
            # Sample the leading sequence on its own, either side of the copy.
            # Taking both markers and the payload in one non-atomic SWD read is
            # not a seqlock: a writer that starts after the host has read the
            # old leading marker but before it reaches the trailing one leaves
            # two matching stale markers wrapped around mixed payload, and the
            # torn frame is accepted.
            before = decode_slot_sequence(probe.read(slot_address, SEQUENCE_SIZE))
            body = probe.read(slot_address, SWD_FRAME_STRUCT.size)
            after = decode_slot_sequence(probe.read(slot_address, SEQUENCE_SIZE))
            if (
                before is None or after is None
                or before != after or before & 1
            ):
                time.sleep(poll_seconds)
                continue
            frame = decode_swd_frame(body)
            if frame is not None and write_count != last_write_count:
                last_write_count = write_count
                frame.pop("_sequence")
                yield frame
            time.sleep(poll_seconds)
