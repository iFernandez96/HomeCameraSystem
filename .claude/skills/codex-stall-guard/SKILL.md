---
name: codex-stall-guard
description: Use whenever launching a codex exec run (proof-program steps or any delegated coding). Wraps the invocation in a stall watchdog so a hung codex session is auto-killed and retried instead of silently stalling the pipeline.
---

# Codex stall guard

`codex exec` occasionally hangs at startup: process alive, **zero CPU, no
session log, no output, forever**. Observed 2026-07-08 (proof-program step P1:
24 minutes, 0:00 CPU, no `~/.codex/sessions/...jsonl` ever opened). A hung
step silently stalls an autonomous pipeline until a human notices — never
launch codex bare.

## The rule

Every codex invocation goes through the wrapper:

```bash
.claude/scripts/codex-guard.sh <logfile> codex exec --sandbox workspace-write --model gpt-5.5 -C <repo> "<prompt>"
```

- `<logfile>`: per-step log (put it in the session scratchpad or a task-logs
  dir; the guard appends attempt markers + full codex output). Do NOT pipe
  codex output through `tail`/`head` yourself — a pipe buffers stdout and
  blinds the liveness check; read the tail of the logfile afterwards instead.
- Liveness = logfile grew OR process-group CPU advanced (so a long quiet
  pytest run inside codex's sandbox still counts as progress).
- No progress for `CODEX_STALL_SECS` (default 300) → the whole process group
  is SIGKILLed and the command retried, up to `CODEX_ATTEMPTS` (default 3)
  total attempts. All attempts stalled → exit 97.
- Tune per call via env: `CODEX_STALL_SECS`, `CODEX_ATTEMPTS`,
  `CODEX_POLL_SECS` (poll interval, default 15).

## Detecting an already-running bare session

If a codex run was launched without the guard and looks dead, confirm before
killing — the hang signature is ALL THREE:

1. `ps -o etime,time -p <vendor-pid>` shows minutes elapsed but ~0:00 CPU;
2. no session file open: `ls /proc/<vendor-pid>/fd | xargs -I{} readlink /proc/<vendor-pid>/fd/{} 2>/dev/null | grep -c sessions/` is 0;
3. its target files/dir never appeared in the tree.

A session with growing `~/.codex/sessions/<date>/rollout-*.jsonl` or accruing
CPU is WORKING (codex legitimately goes quiet on stdout while running tests);
leave it alone.

## After a kill

Re-issue the SAME atomic step verbatim (steps are idempotent by design — one
concern, gated by pytest before commit). Check whether the dead attempt left
partial files in the step's target dir and let the retry overwrite them; only
clean by hand if the retry complains.
