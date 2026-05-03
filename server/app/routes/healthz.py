"""Liveness endpoint at app root (iter-195).

`GET /healthz` returns 200 with `{ok: true}`. Unauthenticated by
design — Docker / Kubernetes liveness probes don't speak browser
cookies, and the iter-184 hard-cutover gate on `/api/*` would
permanently 401 a probe hitting `/api/status`. Same exposure-tier
reasoning as iter-189's `/metrics`: operator-side fronting
(Tailscale, Caddy, firewall rule) is the right control if `/healthz`
needs to be hidden from the LAN.

Semantics: "process is alive". The probe verifies the FastAPI
event loop is still scheduling requests — a deadlocked or
GIL-frozen server would fail here. Deeper invariants (worker
liveness, camera state, thermal headroom) are exposed via the
authenticated `/api/status` and the unauthenticated `/metrics`
(iter-189). A future iter could split into `/healthz` (liveness)
and `/readyz` (full-stack readiness) per the K8s convention if
the operator stack ever needs that distinction; today the
single endpoint is the pragmatic surface.

iter-184 silently broke the docker-compose healthcheck by gating
`/api/status`; this iter closes the bug AND the iter-169
"healthcheck-no-actor" carry-forward at the same time.
"""
from __future__ import annotations

from fastapi import APIRouter


router = APIRouter()


@router.get("/healthz")
async def healthz() -> dict[str, bool]:
    return {"ok": True}
