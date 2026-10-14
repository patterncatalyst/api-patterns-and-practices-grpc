"""Ch27 final project — deterministic token minter (demo only; no IdP, no network).

Mints an HS256 JWT at RUNTIME, not baked into the image, so its `exp` claim is
always computed against the moment verify.sh calls a gRPC method — never a
timestamp that goes stale between a build and a later run. Invoked from the
already-built python image, no second image needed:

    docker compose -p ch27-final-project run --rm --entrypoint python python -m app.mint_token valid
    docker compose -p ch27-final-project run --rm --entrypoint python python -m app.mint_token expired
    docker compose -p ch27-final-project run --rm --entrypoint python python -m app.mint_token wrong-scope
    docker compose -p ch27-final-project run --rm --entrypoint python python -m app.mint_token bad-sig

Prints exactly the encoded JWT to stdout and nothing else.

  valid        Signed with SECRET. exp 5 minutes in the future. scope covers
               every RPC this example's happy path calls: "quote:read
               tracking:read tracking:write routes:negotiate" — NOT
               routes:admin (ListRoutes stays gated).
  expired      Identical to valid, except exp is 5 minutes in the PAST.
  wrong-scope  Valid signature and exp, but scope is "shipments:write" —
               authenticates fine, but lacks ListRoutes' routes:admin scope.
  bad-sig      Identical claims to valid, but signed with WRONG_SECRET.
"""
from __future__ import annotations

import sys
import time

import jwt

from app.auth import ALGORITHM, SECRET, WRONG_SECRET

_CASES = ("valid", "expired", "wrong-scope", "bad-sig")
_ALL_SCOPES = "quote:read tracking:read tracking:write routes:negotiate"


def mint(case: str) -> str:
    if case not in _CASES:
        raise SystemExit(f"mint_token: unknown case '{case}' (one of {_CASES})")

    now = int(time.time())
    claims = {
        "sub": "demo-client",
        "scope": _ALL_SCOPES,
        "iat": now,
        "exp": now + 300,
    }
    secret = SECRET

    if case == "expired":
        claims["exp"] = now - 300
    elif case == "wrong-scope":
        claims["scope"] = "shipments:write"
    elif case == "bad-sig":
        secret = WRONG_SECRET

    return jwt.encode(claims, secret, algorithm=ALGORITHM)


def main() -> int:
    if len(sys.argv) != 2:
        print(f"usage: python -m app.mint_token <{'|'.join(_CASES)}>", file=sys.stderr)
        return 2
    print(mint(sys.argv[1]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
