#!/usr/bin/env python3
"""Poll /api/status at a fixed cadence; append one JSON line per sample.
Python 3.6 compatible. /api/status IS auth-gated, so a cookie jar must
be supplied.

Usage:
    status_log.py --url http://127.0.0.1:8000/api/status \\
        --interval 10 --out status.jsonl --pidfile status.pid \\
        [--cookie-jar /path/to/jar.txt]

The cookie-jar format is the Netscape cookie file the operator dumped via:
    curl -c jar.txt -X POST -H 'Content-Type: application/json' \\
        -d '{"username":"israel","password":"…"}' \\
        http://127.0.0.1:8000/api/auth/login

If no cookie jar is supplied OR it's empty, the logger still records
HTTP-status outcomes so the run isn't a black hole — every sample line
will have ok=false + error="HTTPError 401" but the timestamp series is
still useful for parsing uptime.
"""
from __future__ import print_function

import argparse
import json
import os
import re
import signal
import sys
import time

try:
    from urllib.request import build_opener, HTTPCookieProcessor, Request
    from urllib.error import URLError, HTTPError
    from http.cookiejar import MozillaCookieJar
except ImportError:
    from urllib2 import build_opener, HTTPCookieProcessor, Request
    from urllib2 import URLError, HTTPError
    from cookielib import MozillaCookieJar  # type: ignore


def _utc_iso():
    import datetime
    return datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")


def _build_opener(cookie_jar_path):
    jar = MozillaCookieJar()
    if cookie_jar_path and os.path.exists(cookie_jar_path):
        try:
            jar.load(cookie_jar_path, ignore_discard=True, ignore_expires=True)
        except (OSError, IOError) as e:
            sys.stderr.write("[status_log] could not load cookie jar: {}\n".format(e))
    return build_opener(HTTPCookieProcessor(jar))


def _sample(opener, url, timeout_s):
    req = Request(url, headers={"Accept": "application/json"})
    try:
        with opener.open(req, timeout=timeout_s) as resp:
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
    p.add_argument("--cookie-jar", default="")
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

    opener = _build_opener(args.cookie_jar)
    out = open(args.out, "a", buffering=1)
    try:
        next_at = time.time()
        while not stop["flag"]:
            now = time.time()
            if now < next_at:
                time.sleep(min(0.5, next_at - now))
                continue
            ok, payload = _sample(opener, args.url, args.timeout)
            line = {"sampled_at": _utc_iso(), "ok": ok}
            if ok:
                line["snapshot"] = payload
            else:
                line["error"] = payload
            out.write(json.dumps(line) + "\n")
            next_at += args.interval
            if next_at < time.time():
                next_at = time.time() + args.interval
    finally:
        out.close()


if __name__ == "__main__":
    main(sys.argv[1:])
