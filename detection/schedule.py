"""Pure-logic helper for the detection-pause schedule window.

Extracted from `RuntimeConfig.schedule_says_off()` so the
HH:MM-parsing + overnight-wraparound math can be unit-tested without
freezing wall-clock time. The tiny module is pure stdlib + Python 3.6
compatible (per the CLAUDE.md sharp edge for `detection/*.py`).
"""


def in_off_window(start, end, current_minutes):
    """True iff `current_minutes` (an int in 0..1439, minutes-since-midnight
    local) falls inside the daily off-window defined by `start` and
    `end` HH:MM strings.

    Semantics:
      - If either string is None/empty/malformed, return False
        (schedule not configured).
      - If start == end, the window is empty: return False. (Otherwise
        we'd have to choose between "always" and "never", and "never"
        matches what the UI implies for a same-time pair.)
      - If start < end, the window is the half-open [start, end) interval
        within a single day.
      - If start > end, the window wraps midnight: it's everything from
        start through end-of-day, plus midnight through end. This is
        the common case: 22:00-06:00 = "overnight off."

    No timezone math — `current_minutes` should already be local-time
    minutes-since-midnight.
    """
    if not start or not end:
        return False
    try:
        sh, sm = (int(x) for x in start.split(":", 1))
        eh, em = (int(x) for x in end.split(":", 1))
    except (ValueError, AttributeError):
        return False
    s_min = sh * 60 + sm
    e_min = eh * 60 + em
    if s_min == e_min:
        return False
    if s_min < e_min:
        return s_min <= current_minutes < e_min
    # Wrap: window straddles midnight.
    return current_minutes >= s_min or current_minutes < e_min
