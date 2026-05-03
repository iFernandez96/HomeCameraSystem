"""argon2-cffi password hashing wrapper (iter-178, Auth Plan Phase 1).

We use argon2id (the OWASP-recommended variant) with parameters tuned
for the Jetson Nano 2GB:

- `time_cost=2`        2 iterations — keeps latency under ~150 ms on
                       the Nano's ARM A57 cores. Higher would be more
                       brute-force-resistant but pushes login latency
                       past human-tolerable. Tunable.
- `memory_cost=65536`  64 MB — fits comfortably in the Nano's 1.4 GB
                       MemAvailable headroom; below this argon2 is
                       trivially GPU-parallelizable and the protection
                       degrades.
- `parallelism=2`      Match the Nano's 2 CPU cores. Higher gives no
                       speedup; lower wastes a core.
- `hash_len=32`        Output length in bytes. 32 is OWASP default.
- `salt_len=16`        Random salt per hash. 16 bytes of entropy is
                       enough that rainbow-table attacks are
                       infeasible.

Hash format: `argon2-cffi` produces strings like
`$argon2id$v=19$m=65536,t=2,p=2$<salt>$<hash>` — self-describing, so
future param changes don't break verification of old hashes (argon2
parses parameters from the stored hash).

Constant-time properties:
- Hash time depends ONLY on parameters, not on input length (within
  reason — strings under ~10 KB).
- Verify time on a wrong password is ~equal to verify time on a right
  password — argon2 derives the comparison hash and uses
  constant-time comparison internally.
- BUT: verify is only constant-time relative to a SUCCESSFUL hash. If
  the stored hash is malformed (corrupt, wrong format), verify fails
  fast — that's a separate code path. Phase 3's route handler MUST
  call `verify_password` against a dummy hash on user-not-found to
  preserve the timing-oracle defense.
"""
from __future__ import annotations

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError, InvalidHashError


# Module-level hasher with Jetson-tuned params. Re-using one instance
# across calls is the recommended pattern (it caches argon2's internal
# state) and is thread-safe for hash/verify operations.
_HASHER = PasswordHasher(
    time_cost=2,
    memory_cost=65536,
    parallelism=2,
    hash_len=32,
    salt_len=16,
)

# Pre-computed dummy hash for the route-layer timing-oracle defense.
# `passwords.verify_password(plain, _DUMMY_HASH)` will spend ~120 ms
# returning False — same wall-clock as a real wrong-password verify.
# Phase 3's `/api/auth/login` handler calls this on user-not-found
# instead of short-circuiting to 401, defeating username enumeration.
# Generated once at module import; the value never appears in the DB
# so there's no cross-instance correlation risk.
_DUMMY_HASH = _HASHER.hash("dummy-password-for-timing-oracle-defense")


def hash_password(plain: str) -> str:
    """Hash a plaintext password. Returns a self-describing argon2id
    hash string (~96 chars). Salt is generated per call.

    Raises `argon2.exceptions.HashingError` only if argon2 itself
    fails (out of memory, malformed params) — none of those should
    happen with the module-level hasher.
    """
    return _HASHER.hash(plain)


def verify_password(plain: str, hashed: str) -> bool:
    """Constant-time-ish verification. Returns True on match, False
    on mismatch OR malformed hash. Never raises.

    Use the boolean return — the route handler should NOT branch on
    "user exists" before calling this; instead, on user-not-found,
    call `verify_password(submitted, dummy_hash())` so wall-clock
    behaviour is identical for "wrong user" vs "wrong password" vs
    "right credentials".
    """
    try:
        _HASHER.verify(hashed, plain)
        return True
    except (VerifyMismatchError, InvalidHashError):
        return False


def dummy_hash() -> str:
    """The pre-computed dummy hash for timing-oracle defense.
    Returns a constant string — caller should NOT cache it elsewhere
    (re-importing always returns the same value).
    """
    return _DUMMY_HASH


def needs_rehash(hashed: str) -> bool:
    """True if the stored hash was generated with weaker parameters
    than the current hasher uses (e.g., we bumped `time_cost` after
    a security review). Caller decides what to do — typical pattern
    is "verify the password as-is, then if it matches, immediately
    re-hash and persist with current params." Phase 3's login
    handler MAY use this; for iter-178 the hook is here for the
    future.
    """
    return _HASHER.check_needs_rehash(hashed)
