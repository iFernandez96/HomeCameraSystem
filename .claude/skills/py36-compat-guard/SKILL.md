---
name: py36-compat-guard
description: >-
  Python 3.6 compatibility guard for the detection/ worker. Invoke this skill
  BEFORE writing, editing, or refactoring ANY file under detection/ — or any
  code that runs on the Jetson host (libargus / TensorRT / NVDEC / jetson-utils
  / jetson_inference). The Jetson ships JetPack 4.x = Python 3.6, but dev venvs
  are 3.10+, so modern syntax (list[X], int | None, match, walrus) PARSES
  CLEANLY on the dev box and then crash-loops the worker at boot on the device —
  a failure unit tests on the dev machine cannot see until the AST scanner or a
  real Jetson catches it. Use this whenever you touch detection worker code,
  add a new detection/*.py module, see import errors involving jetson_inference
  / jetson_utils / cv2 / dlib, or are about to run the detection test suite.
---

# Python 3.6 compatibility guard (detection/ worker)

The `detection/` worker runs on the Jetson host under **Python 3.6** (JetPack
4.x — outside the server's Docker container, because it needs libargus /
TensorRT / NVDEC). Your dev venv is 3.10+. Modern syntax compiles fine locally
and then **bricks the worker at boot** (`StartLimitBurst`, `worker_alive=false`,
operator notices ~24 h later). This skill keeps you inside the 3.6 envelope
*while writing* — before the AST scanner or a real Jetson catches it after.

## Forbidden syntax in `detection/*.py` (pinned by `detection/tests/test_py36_compat.py`)

The AST scanner rejects all four. Do not use them in any guarded module:

| Construct | Example | Why it breaks on 3.6 |
|---|---|---|
| **PEP 585 builtin generics** | `list[X]`, `dict[K, V]`, `tuple[...]`, `set[X]` | `TypeError: 'type' object is not subscriptable` |
| **PEP 604 unions** | `int | None`, `str | bytes` in annotations | `SyntaxError` (3.10+ only) |
| **Walrus** | `if (n := f()):` | `SyntaxError` (3.8+ only) |
| **`match` statements** | `match x: case ...:` | `SyntaxError` (3.10+ only) |
| **`from __future__ import annotations`** | (header) | Also banned — masks the above by stringifying annotations, defeating the guard |

**Use instead:**
- `from typing import List, Dict, Tuple, Optional, Union` → `List[X]`, `Optional[int]`, `Union[str, bytes]`. `typing.List[X]` (a `Subscript` on an `Attribute`/`Name` from typing) is fine; only the *bare builtins* are forbidden.
- Replace walrus with an explicit assignment on the line above.
- Replace `match` with `if/elif` chains.
- Plain `.format()` / `%` are fine; f-strings are syntactically fine on 3.6 BUT are banned **in log calls** for a different reason (they defeat level-gating — see logging conventions).

## Two import-order / lazy-import traps (not caught by the AST scanner)

1. **`cv2` must be imported BEFORE `jetson_inference` / `jetson_utils`.** CUDA
   fills static-TLS first → libgomp can't load if cv2 comes after. In
   `detect.py` the SDK imports sit at module top (`detect.py:59-60`); if you add
   `cv2`, put it *above* them.
2. **Never eagerly `import face_recognition`.** `init_face_recognizer()`
   lazy-imports it only when `encodings.pkl` exists — eager import hangs every
   Nano boot (dlib v20 deadlocks in `PyInit__dlib_pybind11`). Keep it lazy.

## Logging shape on the worker (so failures are visible in journald)

- `detect.py main()` calls `applog.configure()` **first**, before any worker thread.
- Leaf libs use stdlib `logging`; hot-loop modules use `applog.emit("tag", msg)` (EPIPE-safe). No per-frame logging — gate hot paths.
- Every failure path logs WHY (operation + reason + ids); never a bare `except: pass`.

## When you add a NEW `detection/*.py` module

Add its path to `_GUARDED_MODULES` in `detection/tests/test_py36_compat.py` —
the scanner only checks listed modules, and there's an exhaustiveness test that
will fail if a new 3.6 module is unguarded. Test *helpers/fixtures* that only
run in the dev venv should NOT be added (they're allowed modern syntax).

## Verify before you commit

Run the scanner (and the worker's pure-logic tests) locally — no Jetson needed:

```bash
/tmp/homecam-venv/bin/python -m pytest detection/tests/test_py36_compat.py -q
```

If the venv is gone (it lives in `/tmp`, ephemeral on this NTFS box — recreate
with `python3 -m venv /tmp/homecam-venv && /tmp/homecam-venv/bin/pip install -r
detection/requirements.txt` or the relevant reqs), recreate it first.

A green scanner means the syntax is 3.6-safe. It does **not** prove the
import-order / lazy-import traps above — those you must hold in your head while
writing, because they only surface on a real Jetson boot.
