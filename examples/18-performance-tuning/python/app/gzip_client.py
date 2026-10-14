"""Ch18 performance-tuning — the gzip-enabled call demo client.

Both servers are configured with `compression=grpc.Compression.Gzip` (see
../main.py / quarkus.grpc.server.compression=gzip), so every response they
send is already gzip-compressed on the wire — decompression happens
transparently inside grpc's framing layer before the application ever sees
the message. This script's job is the FUNCTIONAL gate the chapter claims:
request the large ListRoutes page once with the request's own compression
left at its default (NoCompression, which only governs what this CLIENT
sends — the server still compresses its response per its own config) and
once with `compression=grpc.Compression.Gzip` explicitly set on the call,
and assert the two decoded responses are identical. Compression changes
wire bytes, never message content, so a mismatch here would mean a real
bug, not an expected side effect.

Wire-size numbers (compressed vs uncompressed byte counts) are illustrative
only — see "On the wire" in the chapter — because grpc's high-level Python
API does not expose the compressed frame size; this script proves
correctness, not the compression ratio.

Run against EITHER stack's server (verify.sh invokes it via `docker compose
run --rm python python -m app.gzip_client <host:port> [page_size]`, pointed
at the `quarkus`/`python` compose service's in-network address, container
port 9000). Prints "MATCH" on success; exits non-zero and prints the
mismatch on failure.

Usage:
    python -m app.gzip_client quarkus:9000 25
    python -m app.gzip_client python:9000 25
"""
from __future__ import annotations

import asyncio
import sys

import grpc

from shipping.routing.v1 import routing_pb2, routing_pb2_grpc

# A large ListRoutes page easily clears grpc's own 4MB default RECEIVE cap —
# the same cap grpcurl enforces by default (see "On the wire"). Raising it
# here on the CLIENT side is the native-stub equivalent of grpcurl's
# `-max-msg-sz`: both ends have to opt in before a payload this size gets
# through, which is the point "max-message-size" makes twice over in this
# chapter.
_MAX_MESSAGE_BYTES = 16 * 1024 * 1024


async def run(target: str, page_size: int) -> int:
    channel = grpc.aio.insecure_channel(
        target, options=[("grpc.max_receive_message_length", _MAX_MESSAGE_BYTES)]
    )
    stub = routing_pb2_grpc.RoutingServiceStub(channel)
    request = routing_pb2.ListRoutesRequest(page_size=page_size)

    try:
        plain = await stub.ListRoutes(request)
        gzipped = await stub.ListRoutes(request, compression=grpc.Compression.Gzip)
    finally:
        await channel.close()

    print(f"gzip_client: target={target} page_size={page_size} "
          f"plain_routes={len(plain.routes)} gzip_routes={len(gzipped.routes)}", file=sys.stderr)

    if len(plain.routes) != page_size:
        print(f"gzip_client: FAIL — expected {page_size} routes in the plain call, "
              f"got {len(plain.routes)}", file=sys.stderr)
        return 1

    if plain != gzipped:
        print("gzip_client: FAIL — gzip-enabled call returned a DIFFERENT payload "
              "than the default call", file=sys.stderr)
        return 1

    print(f"gzip_client: ok — {page_size}-route page identical with and without "
          "per-call gzip compression requested", file=sys.stderr)
    print("MATCH")
    return 0


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: python -m app.gzip_client <host:port> [page_size]", file=sys.stderr)
        return 2
    target = sys.argv[1]
    page_size = int(sys.argv[2]) if len(sys.argv) > 2 else 25
    return asyncio.run(run(target, page_size))


if __name__ == "__main__":
    raise SystemExit(main())
