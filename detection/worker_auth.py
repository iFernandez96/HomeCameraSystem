"""Python 3.6-compatible file-backed worker credential helpers."""
import re


_SECRET_RE = re.compile(br"^[0-9a-f]{64}$")


def load_secret(path):
    with open(str(path), "rb") as handle:
        raw = handle.read(67)
    if raw.endswith(b"\r\n"):
        candidate = raw[:-2]
    elif raw.endswith(b"\n"):
        candidate = raw[:-1]
    else:
        candidate = raw
    if len(raw) > 66 or _SECRET_RE.match(candidate) is None:
        raise ValueError("invalid worker authentication secret")
    return candidate.decode("ascii")


def add_authorization(request, secret):
    if secret:
        request.add_header("Authorization", "Bearer " + secret)
    return request
