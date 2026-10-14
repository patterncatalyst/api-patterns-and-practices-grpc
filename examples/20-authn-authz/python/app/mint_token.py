"""Ch20 authn-authz — deterministic token minter (demo only; no IdP, no network).

Mints an HS256 JWT at RUNTIME, not baked into the image, so its `exp` claim
is always computed against the moment verify.sh calls GetQuote or
ListRoutes — never a timestamp that goes stale between a build and a later
run. Invoked from the already-built python image, no second image needed:

    docker compose -p ch20-auth run --rm --entrypoint python python -m app.mint_token valid
    docker compose -p ch20-auth run --rm --entrypoint python python -m app.mint_token expired
    docker compose -p ch20-auth run --rm --entrypoint python python -m app.mint_token wrong-scope
    docker compose -p ch20-auth run --rm --entrypoint python python -m app.mint_token bad-sig

Prints exactly the encoded JWT to stdout and nothing else, so verify.sh
captures it directly: TOKEN="$(docker compose ... run ...)".

All four cases share the same claim shape (`sub`, `scope`, `iat`, `exp`); only
the one property each case is named for differs from the `valid` baseline:

  valid        Signed with SECRET. exp 5 minutes in the future. scope
               "quote:read" — GetQuote's required scope.
  expired      Identical to valid, except exp is 5 minutes in the PAST.
               Proves the interceptor checks exp, not just the signature.
  wrong-scope  Identical to valid (signature and exp both good), but scope
               is "shipments:write" — authenticates fine, but lacks
               ListRoutes' routes:admin scope. Passes authn, fails authz.
  bad-sig      Identical claims to valid, but signed with WRONG_SECRET — the
               token a caller gets by guessing wrong about the shared secret,
               or forging one without ever having seen it.
"""
from __future__ import annotations

import sys
import time

import jwt

from app.auth import ALGORITHM, SECRET, WRONG_SECRET

_CASES = ("valid", "expired", "wrong-scope", "bad-sig")


def mint(case: str) -> str:
    if case not in _CASES:
        raise SystemExit(f"mint_token: unknown case '{case}' (one of {_CASES})")

    now = int(time.time())
    claims = {
        "sub": "demo-client",
        "scope": "quote:read",
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
