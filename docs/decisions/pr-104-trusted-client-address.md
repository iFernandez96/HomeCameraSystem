# PR-104 trusted-client address decision

Status: accepted for the one-household Tailscale Serve deployment.

## Canonical value

The canonical client address is `request.client.host` from the ASGI request
scope after Uvicorn proxy-header processing, normalized with Python's
`ipaddress.ip_address` representation. IPv4-mapped IPv6 is collapsed to IPv4.
Missing or non-IP peers use the literal `unknown` bucket.

Application code never reads `Forwarded`, `X-Real-IP`, or
`X-Forwarded-For`. Tailscale Serve is the production HTTPS reverse proxy and
sets `X-Forwarded-For` to the original tailnet client address. Uvicorn may use
that value only when the immediate TCP peer is one of these fixed trusted hops:

- `127.0.0.1` or `::1` for host-local proxy/development paths;
- `172.30.0.1`, the statically configured HomeCam Docker gateway through which
  the host's loopback-published port reaches the server container.

`FORWARDED_ALLOW_IPS` is a literal Compose value. It must never be `*`, a
tailnet range, the whole Docker subnet, or an operator-supplied request header.
A direct request from another container or any non-allowlisted peer keeps its
actual socket address even if it supplies forwarding headers.

MediaMTX is different: it runs on the host and Tailscale Serve connects to its
loopback WHEP listener directly. Its existing `webrtcTrustedProxies` therefore
remains loopback-only and must not gain the Docker gateway.

## Login backoff contract

`POST /api/auth/login` uses a persistent bucket keyed by:

1. the literal endpoint identity;
2. `NFKC(strip(username)).casefold()` (authentication lookup itself remains
   exact and existing behavior is unchanged);
3. the canonical client address above.

Failures one and two return the existing indistinguishable 401 response.
Failure three returns 429 with `Retry-After: 1`; later post-delay failures
progress through 2, 4, 8, 16, 32, then at most 60 seconds. An active backoff is
checked before password hashing, so even correct credentials wait until the
current bounded delay expires. A successful login then clears exactly its own
endpoint/account/source bucket. Fifteen minutes without a failure resets the
progression. Clock rollback invalidates stale state rather than creating an
unbounded lockout.

State is an atomic SQLite table in private `audit.db`, capped at 4,096 recent
buckets and pruned after fifteen minutes. Runtime storage failure returns a
uniform 503 and refuses to authenticate; server boot already fails closed when
`audit.db` cannot initialize. This control is deliberately not global
middleware, an IP-only lock, or a whole-house lockout.

## Verification obligations

- A trusted Docker-gateway request adopts Tailscale Serve's forwarded address.
- The same header from an untrusted peer is ignored.
- Account, source, and endpoint buckets remain isolated.
- Unknown-user and wrong-password wire responses match before and during
  backoff.
- State survives process restart, remains bounded, and clears only on the
  intended successful login.
