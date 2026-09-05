import struct
import unittest

from tools import swd_transport


class SwdFrameDecodeTests(unittest.TestCase):
    def make_frame(self, *, sequence=12, sequence_end=12, magic=None):
        distances = list(range(500, 564))
        statuses = [5] * 64
        signals = list(range(1000, 1064))
        return swd_transport.SWD_FRAME_STRUCT.pack(
            swd_transport.SWD_FRAME_MAGIC if magic is None else magic,
            sequence,
            41,
            1700,
            8,
            15,
            64,
            *distances,
            *statuses,
            *signals,
            sequence_end,
        )

    def test_decodes_a_consistent_8x8_frame(self):
        frame = swd_transport.decode_swd_frame(self.make_frame(), received_at=99.5)

        self.assertEqual(frame["id"], 41)
        self.assertEqual(frame["edge"], 8)
        self.assertEqual(frame["hz"], 15)
        self.assertEqual(frame["d"], list(range(500, 564)))
        self.assertEqual(frame["s"], [5] * 64)
        self.assertEqual(frame["sig"], list(range(1000, 1064)))
        self.assertEqual(frame["rx"], 99.5)

    def test_rejects_in_progress_torn_or_unrecognized_memory(self):
        self.assertIsNone(decode(self.make_frame(sequence=11, sequence_end=11)))
        self.assertIsNone(decode(self.make_frame(sequence_end=14)))
        self.assertIsNone(decode(self.make_frame(magic=0)))


def decode(payload):
    return swd_transport.decode_swd_frame(payload, received_at=1.0)


if __name__ == "__main__":
    unittest.main()
