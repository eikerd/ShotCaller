import unittest
from unittest import mock

from tools import swd_transport


class SwdFrameDecodeTests(unittest.TestCase):
    def make_frame(self, *, sequence=12, sequence_end=12, frame_id=41):
        distances_q16 = list(range(32, 96))
        return swd_transport.SWD_FRAME_STRUCT.pack(
            sequence,
            frame_id,
            1700,
            8,
            15,
            64,
            *distances_q16,
            sequence_end,
        )

    def test_decodes_a_consistent_8x8_frame(self):
        frame = swd_transport.decode_swd_frame(self.make_frame(), received_at=99.5)

        self.assertEqual(frame["id"], 41)
        self.assertEqual(frame["edge"], 8)
        self.assertEqual(frame["hz"], 15)
        self.assertEqual(frame["d"], list(range(512, 1536, 16)))
        self.assertEqual(frame["s"], [5] * 64)
        self.assertEqual(frame["sig"], [1] * 64)
        self.assertEqual(frame["rx"], 99.5)

    def test_rejects_in_progress_torn_or_unrecognized_memory(self):
        self.assertIsNone(decode(self.make_frame(sequence=11, sequence_end=11)))
        self.assertIsNone(decode(self.make_frame(sequence_end=14)))

    def test_ring_header_rejects_unrecognized_memory(self):
        valid = swd_transport.SWD_RING_HEADER_STRUCT.pack(
            swd_transport.SWD_FRAME_MAGIC, 19
        )
        invalid = swd_transport.SWD_RING_HEADER_STRUCT.pack(0, 19)

        self.assertEqual(swd_transport.decode_ring_header(valid), 19)
        self.assertIsNone(swd_transport.decode_ring_header(invalid))

    def test_iterator_does_not_confuse_equal_slot_sequences_for_same_frame(self):
        reads = [
            swd_transport.SWD_RING_HEADER_STRUCT.pack(
                swd_transport.SWD_FRAME_MAGIC, 1
            ),
            self.make_frame(sequence=2, sequence_end=2, frame_id=101),
            swd_transport.SWD_RING_HEADER_STRUCT.pack(
                swd_transport.SWD_FRAME_MAGIC, 2
            ),
            self.make_frame(sequence=2, sequence_end=2, frame_id=102),
        ]

        class FakeProbe:
            def __enter__(self):
                return self

            def __exit__(self, *_):
                pass

            def read(self, _address, _size):
                return reads.pop(0)

        with (
            mock.patch.object(swd_transport, "SwdProbe", return_value=FakeProbe()),
            mock.patch.object(swd_transport, "find_symbol_address", return_value=0x2000),
        ):
            frames = swd_transport.iter_frames("unused.elf", poll_seconds=0)
            try:
                self.assertEqual(next(frames)["id"], 101)
                self.assertEqual(next(frames)["id"], 102)
            finally:
                frames.close()


def decode(payload):
    return swd_transport.decode_swd_frame(payload, received_at=1.0)


if __name__ == "__main__":
    unittest.main()
