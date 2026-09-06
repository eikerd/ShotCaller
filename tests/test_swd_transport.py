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

            def read(self, _address, size):
                # The iterator now brackets the slot copy with a standalone
                # read of the leading seqlock marker, so the fake has to answer
                # a sequence-sized read without consuming a scripted entry.
                if size == swd_transport.SEQUENCE_SIZE:
                    return swd_transport.SEQUENCE_STRUCT.pack(2)
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


class SwdTornReadTests(unittest.TestCase):
    """The seqlock only works if the sequence is sampled around the copy.

    Reading the leading marker, the payload and the trailing marker in one
    non-atomic SWD transfer lets a writer that starts mid-transfer leave two
    matching stale markers wrapped around mixed payload -- and the host accepts
    it as a good frame.
    """

    def _slot(self, sequence, frame_id, fill):
        return swd_transport.SWD_FRAME_STRUCT.pack(
            sequence, frame_id, 1700, 8, 15, 64, *([fill] * 64), sequence
        )

    def test_a_frame_torn_by_a_concurrent_write_is_rejected(self):
        header = swd_transport.SWD_RING_HEADER_STRUCT.pack(
            swd_transport.SWD_FRAME_MAGIC, 1
        )
        good = self._slot(12, 41, 40)
        # Same markers on both ends, payload from the next frame: exactly what
        # a torn single-shot read produces.
        torn = self._slot(12, 41, 77)

        reads = []

        class FakeProbe:
            def __enter__(self_inner):
                return self_inner

            def __exit__(self_inner, *exc):
                return False

            def read(self_inner, address, size):
                reads.append((address, size))
                if size == swd_transport.SWD_RING_HEADER_STRUCT.size:
                    return header
                # First observation of the sequence is stale-but-even; by the
                # time the payload is copied the writer has moved on.
                if size == 4:
                    return b"\x0c\x00\x00\x00" if len(reads) < 4 else b"\x0d\x00\x00\x00"
                return torn

            def close(self_inner):
                pass

        frames = []
        calls = {"n": 0}

        def stop():
            calls["n"] += 1
            return calls["n"] > 3

        with mock.patch.object(swd_transport, "SwdProbe", FakeProbe), \
                mock.patch.object(swd_transport, "find_symbol_address",
                                  return_value=0x20000000), \
                mock.patch.object(swd_transport.time, "sleep"):
            frames = list(swd_transport.iter_frames("fake.elf", stop_requested=stop))

        self.assertEqual(
            frames, [],
            "a slot whose sequence changed while it was being copied must be "
            "discarded, not handed to the recorder and detector",
        )
        self.assertTrue(
            any(size == 4 for _, size in reads),
            "the leading sequence must be sampled on its own, before and after "
            "the slot copy",
        )

    def test_a_stable_slot_is_still_accepted(self):
        header = swd_transport.SWD_RING_HEADER_STRUCT.pack(
            swd_transport.SWD_FRAME_MAGIC, 1
        )
        good = self._slot(12, 41, 40)

        class FakeProbe:
            def __enter__(self_inner):
                return self_inner

            def __exit__(self_inner, *exc):
                return False

            def read(self_inner, address, size):
                if size == swd_transport.SWD_RING_HEADER_STRUCT.size:
                    return header
                if size == 4:
                    return b"\x0c\x00\x00\x00"
                return good

            def close(self_inner):
                pass

        calls = {"n": 0}

        def stop():
            calls["n"] += 1
            return calls["n"] > 2

        with mock.patch.object(swd_transport, "SwdProbe", FakeProbe), \
                mock.patch.object(swd_transport, "find_symbol_address",
                                  return_value=0x20000000), \
                mock.patch.object(swd_transport.time, "sleep"):
            frames = list(swd_transport.iter_frames("fake.elf", stop_requested=stop))

        self.assertEqual(len(frames), 1)
        self.assertEqual(frames[0]["id"], 41)


if __name__ == "__main__":
    unittest.main()

