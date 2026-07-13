#!/usr/bin/env python3
"""Poll /api/_internal/heartbeat at a fixed cadence; append one JSON line
per sample to the output file. Python 3.6 compatible (runs on the JetPack
4.x Jetson Nano host where the worker also runs).

PR-102 made /api/_internal/heartbeat worker-authenticated. This historical soak
helper does not yet load that credential and is therefore not a valid PR-102
health proof; updating its request behavior is intentionally tracked outside
PR-102. It was originally intended to return the most recent heartbeat
snapshot stored on the server side.

Usage:
    heartbeat_log.py --url http://127.0.0.1:8000/api/_internal/heartbeat \\
        --interval 10 --out heartbeat.jsonl --pidfile heartbeat.pid

Each output line:
    {"sampled_at": "2026-05-04T12:34:56Z", "ok": true,
     "snapshot": {<server-side last_seen heartbeat>}}

Failure mode: a missed sample writes a line with "ok": false + "error":
"<repr>" so the parser can compute uptime accurately.
"""
from __future__ import print_function

import argparse
import json
import os
import signal
import sys
import time

try:
    from urllib.request import urlopen, Request
    from urllib.error import URLError, HTTPError
except ImportError:
    # Py2 fallback (won't trigger on Jetson but keeps file portable).
    from urllib2 import urlopen, Request, URLError, HTTPError


def _utc_iso():
    # Python 3.6: datetime.fromtimestamp(t, tz=timezone.utc) works.
    import datetime
    return datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")


def _sample(url, timeout_s):
    req = Request(url, headers={"Accept": "application/json"})
    try:
        with urlopen(req, timeout=timeout_s) as resp:
            body = resp.read().decode("utf-8")
        return True, json.loads(body)
    except (URLError, HTTPError, ValueError, OSError) as e:
        return False, repr(e)


def main(argv):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--url", required=True)
    p.add_argument("--interval", type=float, default=10.0)
    p.add_argument("--out", required=True)
    p.add_argument("--pidfile", default=None)
    p.add_argument("--timeout", type=float, default=4.0)
    args = p.parse_args(argv)

    if args.pidfile:
        with open(args.pidfile, "w") as f:
            f.write(str(os.getpid()))

    stop = {"flag": False}

    def _sigterm(_sig, _frm):
        stop["flag"] = True

    signal.signal(signal.SIGTERM, _sigterm)
    signal.signal(signal.SIGINT, _sigterm)

    # Append (don't truncate) — parent restarts the logger on resume.
    out = open(args.out, "a", buffering=1)
    try:
        next_at = time.time()
        while not stop["flag"]:
            now = time.time()
            if now < next_at:
                # Sleep in short slices so SIGTERM is responsive.
                time.sleep(min(0.5, next_at - now))
                continue
            ok, payload = _sample(args.url, args.timeout)
            line = {"sampled_at": _utc_iso(), "ok": ok}
            if ok:
                line["snapshot"] = payload
            else:
                line["error"] = payload
            out.write(json.dumps(line) + "\n")
            next_at += args.interval
            # Don't drift: if we fell behind, catch up to the next
            # whole interval.
            if next_at < time.time():
                next_at = time.time() + args.interval
    finally:
        out.close()


if __name__ == "__main__":
    main(sys.argv[1:])
