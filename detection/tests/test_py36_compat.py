"""Static guard against modern syntax sneaking into the worker.

JetPack 4.x ships Python 3.6 on the Jetson host where the detection
worker (`homecam-detect.service`) runs. The dev venv at
`/tmp/homecam-venv` is 3.10+, so most modern syntax compiles fine and
the existing detection unit tests pass — but at boot on the Jetson the
systemd unit silently fails with `TypeError: 'type' object is not
subscriptable` (PEP 585) or `SyntaxError` (PEP 604, walrus, match).
By the time the operator notices, the worker is in the StartLimitBurst
trap and `worker_alive` is false in the UI.

This test walks the AST of every 3.6-compat detection module and fails
on patterns that crash on Python 3.6. The guarded modules are listed
in CLAUDE.md "Sharp edges that have been ground down — don't
reintroduce them" under the "detection/*.py must stay Python 3.6
compatible" bullet. Add to `_GUARDED_MODULES` whenever a new
3.6-compat module is added.

Coverage (iter-171 expanded from PEP 585 only):
- **PEP 585** (`list[X]`, `dict[K, V]`, `tuple[...]` etc. on the bare
  builtins): Python 3.9+. On 3.6 raises `TypeError: 'type' object
  is not subscriptable` at the moment the annotation is evaluated.
- **PEP 604 unions** (`int | None` style annotations): Python 3.10+
  in annotation contexts. On 3.6 raises `TypeError: unsupported
  operand type(s) for |: 'type' and 'type'` at evaluation; on 3.10
  the runtime supports it but 3.6 doesn't.
- **Walrus operator** (`name := expr`): Python 3.8+. On 3.6 it's a
  `SyntaxError` at parse time — the systemd unit would
  StartLimitBurst-trap immediately.
- **Match statements** (`match ...: case ...`): Python 3.10+. Same
  parse-time SyntaxError on 3.6.

We do NOT have a Python 3.6 runtime in CI; this scanner is the
substitute. iter-161 audit caught `encode_known_faces.py:58-59`
(PEP 585) which iter-163 fixed; iter-171 extended the scanner to
the other three categories.
"""
from __future__ import annotations

import ast
import os

import pytest

# Files that must run on Python 3.6 (per CLAUDE.md sharp edge). Paths
# are relative to the repo root, resolved via `_repo_root()` below.
_GUARDED_MODULES = (
    "detection/detect.py",
    "detection/applog.py",
    "detection/box_norm.py",
    "detection/camera_ident.py",
    "detection/decision_ledger.py",
    "detection/memory_guard.py",
    "detection/thermal_guard.py",
    "detection/schedule.py",
    "detection/metrics.py",
    "detection/mediamtx_watchdog.py",
    "detection/zones.py",
    "detection/recording.py",
    "detection/preroll.py",
    "detection/tracks.py",
    "detection/presence.py",
    "detection/visit.py",
    "detection/visit_runtime.py",
    "detection/sdnotify.py",
    "detection/face_recog/recognizer.py",
    "detection/face_recog/encode_known_faces.py",
    "detection/face_recog/capture.py",
    "detection/face_recog/detector.py",
)

# Builtins whose subscripted form (`list[X]`) is PEP 585 — Python 3.9+
# only. On 3.6 this raises `TypeError: 'type' object is not subscriptable`
# at the moment the annotation is evaluated. That's at module load for
# annotated assignments; at function call for parameter annotations.
_PEP585_BUILTINS = frozenset(
    {"list", "tuple", "dict", "set", "frozenset", "type"}
)


def _repo_root() -> str:
    # detection/tests/test_py36_compat.py -> repo root is two levels up.
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.dirname(os.path.dirname(here))


def _walk_subscripts(tree: ast.AST):
    for node in ast.walk(tree):
        if isinstance(node, ast.Subscript):
            yield node


@pytest.mark.parametrize("rel_path", _GUARDED_MODULES)
def test_no_pep585_generics_in_guarded_module(rel_path: str) -> None:
    abs_path = os.path.join(_repo_root(), rel_path)
    assert os.path.exists(abs_path), (
        "guarded module {} not found — was it moved or renamed? Update "
        "_GUARDED_MODULES to match.".format(rel_path)
    )
    with open(abs_path) as f:
        source = f.read()
    tree = ast.parse(source, filename=abs_path)

    offenses = []
    for sub in _walk_subscripts(tree):
        base = sub.value
        # `list[X]` -> Subscript(value=Name(id='list'), slice=...)
        # `typing.List[X]` -> Subscript(value=Attribute(...), slice=...) — fine.
        if isinstance(base, ast.Name) and base.id in _PEP585_BUILTINS:
            offenses.append((sub.lineno, base.id))

    assert not offenses, (
        "PEP 585 generics in {} would TypeError on Python 3.6 "
        "(CLAUDE.md 'detection/*.py must stay Python 3.6 compatible' "
        "sharp edge). Offenses: {}. Replace with bare types or "
        "typing.List/Dict/Tuple.".format(
            rel_path, ", ".join("line {}: {}[...]".format(ln, name) for ln, name in offenses)
        )
    )


def _annotations_in_tree(tree: ast.AST):
    """Yield every annotation expression appearing in the tree.

    Annotations live on AnnAssign (`x: T = ...`), arguments
    (`def f(x: T)`), and function returns (`def f() -> T`). Each
    of those is itself an expression that may be deeply nested
    (`Optional[Union[int, str]]`), so the caller still needs to
    `ast.walk` each yielded subtree to find PEP 604 `int | None`
    inside.
    """
    for node in ast.walk(tree):
        if isinstance(node, ast.AnnAssign) and node.annotation is not None:
            yield node.annotation
        elif isinstance(node, ast.arg) and node.annotation is not None:
            yield node.annotation
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.returns is not None:
            yield node.returns


@pytest.mark.parametrize("rel_path", _GUARDED_MODULES)
def test_no_pep604_unions_in_guarded_module(rel_path: str) -> None:
    """PEP 604: `int | None`-style union annotations. Python 3.10+
    only. On 3.6 the `|` between two types fails at evaluation."""
    abs_path = os.path.join(_repo_root(), rel_path)
    with open(abs_path) as f:
        source = f.read()
    tree = ast.parse(source, filename=abs_path)

    offenses = []
    for annotation in _annotations_in_tree(tree):
        for sub in ast.walk(annotation):
            if isinstance(sub, ast.BinOp) and isinstance(sub.op, ast.BitOr):
                offenses.append(sub.lineno)

    assert not offenses, (
        "PEP 604 union annotations (e.g. `int | None`) in {} would "
        "TypeError on Python 3.6 (CLAUDE.md sharp edge). Offenses at "
        "line(s): {}. Replace with `Optional[X]` / `Union[X, Y]` from "
        "`typing`.".format(rel_path, ", ".join(str(ln) for ln in offenses))
    )


@pytest.mark.parametrize("rel_path", _GUARDED_MODULES)
def test_no_walrus_in_guarded_module(rel_path: str) -> None:
    """Walrus `:=` (PEP 572). Python 3.8+. On 3.6 it's a SyntaxError
    at parse time — the systemd unit would StartLimitBurst-trap
    immediately on the next worker restart."""
    abs_path = os.path.join(_repo_root(), rel_path)
    with open(abs_path) as f:
        source = f.read()
    tree = ast.parse(source, filename=abs_path)

    offenses = [
        node.lineno
        for node in ast.walk(tree)
        if isinstance(node, ast.NamedExpr)
    ]

    assert not offenses, (
        "Walrus operator `:=` (PEP 572) in {} would SyntaxError on "
        "Python 3.6. Offenses at line(s): {}. Refactor to a plain "
        "assignment.".format(rel_path, ", ".join(str(ln) for ln in offenses))
    )


@pytest.mark.parametrize("rel_path", _GUARDED_MODULES)
def test_no_match_statement_in_guarded_module(rel_path: str) -> None:
    """`match` statements (PEP 634). Python 3.10+. On 3.6 it's a
    SyntaxError at parse time."""
    abs_path = os.path.join(_repo_root(), rel_path)
    with open(abs_path) as f:
        source = f.read()
    tree = ast.parse(source, filename=abs_path)

    # ast.Match was added in Python 3.10. On older Python ASTs
    # `ast.Match` doesn't exist — but this test runs in 3.10+ dev venv
    # so the symbol is always available here.
    offenses = [
        node.lineno
        for node in ast.walk(tree)
        if isinstance(node, ast.Match)
    ]

    assert not offenses, (
        "`match` statement (PEP 634) in {} would SyntaxError on "
        "Python 3.6. Offenses at line(s): {}. Refactor to "
        "if/elif/else.".format(rel_path, ", ".join(str(ln) for ln in offenses))
    )


def test_guard_set_is_complete() -> None:
    """Sanity check: every .py file under detection/ (except tests/ and
    face_recog/__pycache__/) is in `_GUARDED_MODULES`. A new detection
    module added without adding it to the guard set silently escapes
    the scanner."""
    detection_dir = os.path.join(_repo_root(), "detection")
    actual: list[str] = []  # noqa: this test file runs in 3.10+ dev venv only
    for dirpath, dirnames, filenames in os.walk(detection_dir):
        # Don't descend into tests/, __pycache__, refs/ (image data).
        dirnames[:] = [
            d for d in dirnames if d not in ("tests", "__pycache__", "refs")
        ]
        for f in filenames:
            if not f.endswith(".py"):
                continue
            if f == "__init__.py":
                continue
            full = os.path.join(dirpath, f)
            rel = os.path.relpath(full, _repo_root())
            actual.append(rel)
    missing = sorted(set(actual) - set(_GUARDED_MODULES))
    assert not missing, (
        "detection/*.py files not listed in `_GUARDED_MODULES`: {}. "
        "Either add them to the guard, or move them out of detection/ "
        "if they don't run on the Jetson host.".format(missing)
    )
