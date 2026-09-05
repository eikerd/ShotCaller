#!/usr/bin/env python3
"""Fail unless the real ShotCaller stream and continuous log are advancing."""

import argparse
import json
import sys
import time
import urllib.error
import urllib.request


def fetch_status(url):
    with urllib.request.urlopen(url, timeout=2) as response:
        return json.load(response)


def evaluate(before, after, expected_edge):
    failures = []
    expected = str(expected_edge)
    config = after.get("config") or {}
    recording = after.get("recording") or {}
    before_recording = before.get("recording") or {}

    if not after.get("connected"):
        failures.append("serial bridge is disconnected")
    if config.get("res") != expected:
        failures.append(
            f"expected {expected}x{expected}, got {config.get('res') or 'no config'}"
        )
    if after.get("frames_seen", 0) <= before.get("frames_seen", 0):
        failures.append("real sensor frame count did not advance")
    if not recording.get("active"):
        failures.append(f"continuous recorder is inactive: {recording.get('error')}")
    if recording.get("frames_recorded", 0) <= before_recording.get(
        "frames_recorded", 0
    ):
        failures.append("continuous recording frame count did not advance")
    if after.get("parse_errors", 0) != before.get("parse_errors", 0):
        failures.append("parse error count increased")
    return failures


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--url",
        default="http://127.0.0.1:8420/api/status",
        help="live bridge status endpoint",
    )
    parser.add_argument("--seconds", type=float, default=2.0)
    parser.add_argument("--expect-edge", type=int, choices=(4, 8), default=8)
    args = parser.parse_args()

    try:
        before = fetch_status(args.url)
        time.sleep(args.seconds)
        after = fetch_status(args.url)
    except (OSError, urllib.error.URLError, json.JSONDecodeError) as error:
        print(f"LIVE FAIL: cannot read bridge status: {error}", file=sys.stderr)
        return 1

    failures = evaluate(before, after, args.expect_edge)
    summary = {
        "edge": (after.get("config") or {}).get("res"),
        "frames_seen_delta": after.get("frames_seen", 0)
        - before.get("frames_seen", 0),
        "frames_recorded_delta": (after.get("recording") or {}).get(
            "frames_recorded", 0
        )
        - (before.get("recording") or {}).get("frames_recorded", 0),
        "parse_errors_delta": after.get("parse_errors", 0)
        - before.get("parse_errors", 0),
    }
    print(json.dumps(summary, sort_keys=True))
    if failures:
        for failure in failures:
            print(f"LIVE FAIL: {failure}", file=sys.stderr)
        return 1
    print("LIVE PASS: real sensor frames and continuous recording are advancing")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
