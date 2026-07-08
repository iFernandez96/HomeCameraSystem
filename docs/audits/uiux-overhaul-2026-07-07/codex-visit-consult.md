**Findings**

1. `visit.py` resets the absence timer correctly for a same-box/same-IoU return before grace expires. Ordinary continuation updates `last_seen = now` and emits only `extend` at [visit.py](/media/israel/Drive/Projects/Android/HomeCameraSystem/detection/visit.py:151), and `tick()` finalizes from `last_seen + absence_finalize_s` at [visit.py](/media/israel/Drive/Projects/Android/HomeCameraSystem/detection/visit.py:181). This is pinned by the reset test at [test_visit.py](/media/israel/Drive/Projects/Android/HomeCameraSystem/detection/tests/test_visit.py:111).

2. It is not an exact semantic match if “same subject returns” can move enough that IoU drops below `0.3`. The code computes `same_subject` from IoU at [visit.py](/media/israel/Drive/Projects/Android/HomeCameraSystem/detection/visit.py:113); if false, it finalizes the old visit and opens a new one even within grace at [visit.py](/media/israel/Drive/Projects/Android/HomeCameraSystem/detection/visit.py:141). That contradicts the module comment saying IoU is “ADVISORY … never gating” at [visit.py](/media/israel/Drive/Projects/Android/HomeCameraSystem/detection/visit.py:31). For strict user semantics, return-before-grace should reset regardless of IoU, or IoU should only help decide multi-person replacement.

3. Boundary nuance: both `observe()` and `tick()` use `now > deadline`, not `>=`, at [visit.py](/media/israel/Drive/Projects/Android/HomeCameraSystem/detection/visit.py:133) and [visit.py](/media/israel/Drive/Projects/Android/HomeCameraSystem/detection/visit.py:181). A detection exactly at expiry continues the same visit. If “expires” means inclusive, change to `>=`; if “before it expires” is strict, document this edge.

4. Runtime toggle bug is real. Config poll writes `runtime.continuous_capture` at [detect.py](/media/israel/Drive/Projects/Android/HomeCameraSystem/detection/detect.py:485), but the loop gates on `_VISIT_RUNNER is not None` at [detect.py](/media/israel/Drive/Projects/Android/HomeCameraSystem/detection/detect.py:1829) and [detect.py](/media/israel/Drive/Projects/Android/HomeCameraSystem/detection/detect.py:2067). `_VISIT_RUNNER` is only built during startup at [detect.py](/media/israel/Drive/Projects/Android/HomeCameraSystem/detection/detect.py:1548). So enabling in Settings does nothing until restart; disabling also does not disarm an already built runner.

**Runtime Recommendation**

Add a small main-loop reconciler before `_VISIT_RUNNER.tick()`:

- Desired on: `runtime.continuous_capture and recordings_dir and clip_recorder is not None`.
- If desired on and `_VISIT_RUNNER is None`: build it, then immediately run `_recover_open_visits(...)` and `sweep_orphans(...)` before allowing the first `observe()`. Since the loop already ticks before detection, this preserves “recovery before first open.”
- If desired off and `_VISIT_RUNNER is not None`: call `finalize_open_visits_for_escalation(now)` or a renamed `finalize_open_visits_now(now)` to close current visits at `last_seen`, persist, then set `_VISIT_RUNNER = None`. The legacy `start_clip` path will resume on the next detection because the XOR fallback is already `_VISIT_RUNNER is None` at [detect.py](/media/israel/Drive/Projects/Android/HomeCameraSystem/detection/detect.py:2061) and [detect.py](/media/israel/Drive/Projects/Android/HomeCameraSystem/detection/detect.py:2380).
- Keep this Python 3.6-simple: no context managers or async machinery, just a helper like `_reconcile_visit_runner(...)` returning the possibly new runner and logging transitions once.

**Defaults / Event Spam**

`max_visit_s=150` is within the plan’s 120-180s range, with expected clip size about 46 MB at the documented 0.31 MB/s stream rate [plan](/media/israel/Drive/Projects/Android/HomeCameraSystem/docs/continuous_capture_plan.md:15). It is sensible for usability and disk safety. I would default: `absence_finalize_s=10s`, `max_visit_s=180s` for fewer timeline rows, or `120s` on tighter SD cards. Avoid 600s unless retention/disk eviction is proven.

Cap-split continuation visits should not look like independent “new person arrived” events. Today every open posts an event with `clip_url` at [visit_runtime.py](/media/israel/Drive/Projects/Android/HomeCameraSystem/detection/visit_runtime.py:548) and [detect.py](/media/israel/Drive/Projects/Android/HomeCameraSystem/detection/detect.py:1045), despite the plan saying no `clip_url` at open [plan](/media/israel/Drive/Projects/Android/HomeCameraSystem/docs/continuous_capture_plan.md:34). For continuations, either suppress push/notification semantics or mark the POST as `continuation_of` / `segment_index>0` so UI/timelapse can group them. I would still create a row per physical clip, but suppress alerting for continuation opens.
