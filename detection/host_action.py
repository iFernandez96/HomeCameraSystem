"""Pure host-action decisions and bounded journal helpers.

This module is imported by the host-side detection worker on JetPack 4.x, so
keep it Python 3.6 compatible. It intentionally contains no server polling,
disk writes, systemctl calls, or direct side effects except the injected
``runner`` used by ``tail_journal``.
"""
import re
import subprocess


PLAN_EXECUTE = "execute"
PLAN_SKIP_STALE = "skip_stale"
PLAN_SKIP_SEEN = "skip_seen"
PLAN_SKIP_UNKNOWN = "skip_unknown"

VALID_KINDS = ("mediamtx", "nvargus", "reboot", "logs", "focus_start", "focus_stop", "exposure_apply")
LOG_UNITS = ("homecam-detect", "mediamtx", "nvargus-daemon", "homecam-server")

_SINCE_RELATIVE_RE = re.compile(
    r"^-?\d{1,3}\s+(second|minute|hour|day)s?( ago)?$"
)
_SINCE_ABSOLUTE_RE = re.compile(
    r"^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$"
)

# CLAUDE.md logging guardrail: NEVER log passwords, token/cookie bytes, full
# request bodies, or full SDP. The log bridge redacts these before shipping.
_SECRET_WORD_RE = re.compile(
    r"(token|password|passwd|secret|authorization|bearer|cookie|set-cookie|"
    r"jwt|vapid|api[_-]?key|private[_-]?key|x-api-key)",
    re.IGNORECASE,
)
_SECRET_REST_VALUE_RE = re.compile(
    r"((?:authorization|cookie|set-cookie)\s*(?:=|:)\s*).*$",
    re.IGNORECASE,
)
_SECRET_VALUE_RE = re.compile(
    r"((?:token|password|passwd|secret|bearer|jwt|vapid|api[_-]?key|"
    r"private[_-]?key|x-api-key)"
    r"\s*(?:=|:)\s*)([^,\s;]+)",
    re.IGNORECASE,
)
_BASE64ISH_RE = re.compile(r"[A-Za-z0-9+/=]{24,}")
_HEX_RE = re.compile(r"\b[0-9a-fA-F]{24,}\b")


def plan_action(record, now, seen_ids, max_age_s=90.0):
    """Return the side-effect-free execution plan for a polled action."""
    if not record:
        return PLAN_SKIP_UNKNOWN

    rid = record.get("id")
    if record.get("kind") not in VALID_KINDS:
        return PLAN_SKIP_UNKNOWN
    if rid in seen_ids:
        return PLAN_SKIP_SEEN

    requested_at = record.get("requested_at")
    try:
        age = now - float(requested_at)
    except (TypeError, ValueError):
        return PLAN_SKIP_UNKNOWN

    if age < 0 or age > max_age_s:
        return PLAN_SKIP_STALE
    return PLAN_EXECUTE


def execute_action(record, deps):
    """Execute one already-claimed action through injected host callables.

    Returns ``(status, detail, result_dict_or_none)``. The callables are supplied
    by detect.py so this core stays free of systemctl, reboot, and journal I/O.
    """
    kind = record.get("kind") if record else None

    if kind == "mediamtx":
        ok = deps.restart_mediamtx()
        return _status_from_bool(ok, "mediamtx restart")

    if kind == "nvargus":
        ok = deps.restart_nvargus()
        return _status_from_bool(ok, "nvargus restart")

    if kind == "reboot":
        if not deps.allow_reboot:
            return (
                "failed",
                "reboot disabled by DETECT_WATCHDOG_ALLOW_REBOOT=0",
                None,
            )
        ok = deps.do_reboot()
        return _status_from_bool(ok, "reboot")

    if kind == "logs":
        args = record.get("args") or {}
        lines = deps.tail_journal(
            args.get("unit"), args.get("since"), args.get("lines")
        )
        return ("done", "logs fetched", {"lines": lines})

    if kind == "focus_start":
        result = deps.start_focus_mode()
        if result:
            return ("done", "1440p precision mode ready", result)
        return ("failed", "1440p precision mode unavailable", None)

    if kind == "focus_stop":
        ok = deps.stop_focus_mode()
        return _status_from_bool(ok, "shared camera mode confirmation")

    if kind == "exposure_apply":
        result = deps.apply_exposure(record.get("args") or {})
        if result:
            return ("done", "camera exposure applied", result)
        return ("failed", "camera exposure failed; previous settings restored", None)

    return ("failed", "unknown host action", None)


def _status_from_bool(ok, label):
    if ok:
        return ("done", label + " requested", None)
    return ("failed", label + " failed", None)


def is_valid_journal_unit(unit):
    return unit in LOG_UNITS


def _sanitize_since(since):
    """Whitelist journalctl --since values; reject by returning None."""
    if since is None:
        return None
    text = str(since).strip()
    if not text:
        return None
    if _SINCE_RELATIVE_RE.match(text):
        return text
    if _SINCE_ABSOLUTE_RE.match(text):
        return text
    return None


def scrub_lines(lines, max_lines=200):
    """Redact secret-bearing journal lines and cap output size.

    Lines with a secret keyword and a key/value shape keep context with the
    value redacted. Lines with a secret keyword but no key/value shape are
    dropped because there is no reliable value boundary to preserve.
    """
    try:
        limit = int(max_lines)
    except (TypeError, ValueError):
        limit = 200
    limit = max(0, limit)

    cleaned = []
    for raw in lines:
        if len(cleaned) >= limit:
            break
        line = "" if raw is None else str(raw)

        has_secret_word = _SECRET_WORD_RE.search(line) is not None
        if has_secret_word:
            line, rest_count = _SECRET_REST_VALUE_RE.subn(r"\1***", line)
            line, value_count = _SECRET_VALUE_RE.subn(r"\1***", line)
            if rest_count + value_count == 0:
                continue

        line = _BASE64ISH_RE.sub("***", line)
        line = _HEX_RE.sub("***", line)
        if len(line) > 2000:
            line = line[:2000]
        cleaned.append(line)
    return cleaned


def tail_journal(unit, since, lines, runner=subprocess.run, now=None):
    """Return scrubbed journal lines for one whitelisted unit."""
    if not is_valid_journal_unit(unit):
        return []
    try:
        n = int(lines or 200)
    except (TypeError, ValueError):
        n = 200
    n = max(1, min(n, 1000))

    cmd = [
        "sudo",
        "-n",
        "journalctl",
        "-u",
        unit,
        "-n",
        str(n),
        "--no-pager",
        "-o",
        "short-iso",
    ]
    since_arg = _sanitize_since(since)
    if since_arg:
        cmd += ["--since", since_arg]

    out = runner(
        cmd,
        timeout=10.0,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    text = out.stdout.decode("utf-8", "replace")
    return scrub_lines(text.splitlines(), max_lines=n)
