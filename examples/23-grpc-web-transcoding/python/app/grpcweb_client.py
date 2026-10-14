"""Ch23 grpc-web & JSON/HTTP transcoding — a deterministic grpc-web client:
this book's CI stand-in for a browser's `grpc-web` JavaScript library (a real
browser client is shown as an illustrative snippet in the chapter, not run
here). It reuses this module's OWN generated stubs
(`shipping.routing.v1.routing_pb2`) to build the identical
`GetQuoteRequest` every other path in this chapter builds, frames it exactly
as `grpc-web` would, POSTs it to Envoy's `grpc_web` filter
(../envoy/envoy-*.yaml), and decodes the framed response back into a
`GetQuoteResponse`.

Run it against either stack's Envoy listener:

    docker compose -p ch23-grpc-web run --rm python \\
      python -m app.grpcweb_client envoy-quarkus:10000
    docker compose -p ch23-grpc-web run --rm python \\
      python -m app.grpcweb_client envoy-python:10000

Only the standard library (`urllib.request`, `struct`) and `protobuf` are
used — no JavaScript runtime, no `grpc-web` npm package. What makes this a
*grpc-web* call rather than a native gRPC call is entirely in the wire
framing and the `content-type` header, not in any special client library:
gRPC itself needs HTTP/2 trailers to carry the final status, and a browser's
`fetch`/`XMLHttpRequest` cannot read HTTP/2 trailers or send an HTTP/2
request directly — so `grpc-web` moves the final status into one more
length-prefixed frame inside the ordinary HTTP response body, and Envoy's
`grpc_web` filter is what translates between this framing and a real native
gRPC call to the upstream app. See the chapter's "grpc-web wire framing"
section for the full picture.
"""
from __future__ import annotations

import argparse
import struct
import urllib.error
import urllib.request

from google.protobuf import json_format

from shipping.routing.v1 import routing_pb2
from shipping.type.v1 import types_pb2

# The grpc-web frame header: 1 flag byte + a 4-byte big-endian length,
# prepended to every message AND every trailer block. Flag bit 0x80 marks a
# TRAILER frame; flag 0x00 marks a DATA frame carrying one serialized
# protobuf message. This is the same length-prefixed-message idea native
# gRPC uses over HTTP/2 (RFC "Length-Prefixed-Message": 1 compression byte +
# 4-byte length + message), reused here as an HTTP/1.1-body-safe envelope.
_FRAME_HEADER_LEN = 5
_FLAG_TRAILER = 0x80


def frame(message: bytes) -> bytes:
    """Prepend the 5-byte grpc-web frame header to a serialized protobuf
    message: flag 0x00 (uncompressed DATA frame) + the message's length as a
    4-byte unsigned big-endian integer."""
    return struct.pack(">BI", 0x00, len(message)) + message


def _unframe_all(body: bytes) -> list[tuple[int, bytes]]:
    """Split a grpc-web response body into its (flag, payload) frames. A
    response normally carries exactly one DATA frame (the message) followed
    by exactly one TRAILER frame (the final grpc-status/grpc-message, encoded
    as HTTP/1.1-style `key: value\\r\\n` text instead of real HTTP/2
    trailers — the whole reason grpc-web needs its own framing instead of
    riding on native gRPC's)."""
    frames: list[tuple[int, bytes]] = []
    offset = 0
    while offset < len(body):
        if len(body) - offset < _FRAME_HEADER_LEN:
            raise ValueError(f"truncated grpc-web frame header at offset {offset}")
        flag, length = struct.unpack(">BI", body[offset : offset + _FRAME_HEADER_LEN])
        offset += _FRAME_HEADER_LEN
        payload = body[offset : offset + length]
        if len(payload) != length:
            raise ValueError(f"truncated grpc-web frame payload at offset {offset}: "
                              f"wanted {length} bytes, got {len(payload)}")
        offset += length
        frames.append((flag, payload))
    return frames


def _parse_trailer(payload: bytes) -> dict[str, str]:
    trailers: dict[str, str] = {}
    for line in payload.decode("utf-8").strip().split("\r\n"):
        if not line:
            continue
        key, _, value = line.partition(":")
        trailers[key.strip().lower()] = value.strip()
    return trailers


def call_get_quote(
    envoy_target: str, origin: str, destination: str, weight_kg: float
) -> routing_pb2.GetQuoteResponse:
    """POST a grpc-web-framed GetQuote call to `envoy_target` (host:port of
    an Envoy listener running the grpc_web filter) and return the decoded
    GetQuoteResponse. Raises RuntimeError if the trailer's grpc-status is
    nonzero or no DATA frame came back."""
    request = routing_pb2.GetQuoteRequest(
        origin=types_pb2.Location(un_locode=origin),
        destination=types_pb2.Location(un_locode=destination),
        cargo=[types_pb2.Cargo(weight_kg=weight_kg)],
    )
    body = frame(request.SerializeToString())

    # The path is the standard gRPC "/package.Service/Method" convention —
    # identical to what a native grpc-core channel dials, and identical to
    # what Envoy's grpc_json_transcoder auto-maps a JSON POST onto (see
    # envoy/envoy-*.yaml). grpc-web changes the FRAMING and the content-type,
    # never the RPC's address.
    url = f"http://{envoy_target}/shipping.routing.v1.RoutingService/GetQuote"
    http_request = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "content-type": "application/grpc-web+proto",
            "x-grpc-web": "1",
            "accept": "application/grpc-web+proto",
        },
    )
    try:
        with urllib.request.urlopen(http_request, timeout=10) as http_response:
            response_body = http_response.read()
    except urllib.error.HTTPError as exc:
        # A grpc-web proxy answers plain HTTP errors (4xx/5xx) only for
        # transport-level failures (bad routing, upstream unreachable); a
        # normal RPC failure still comes back as HTTP 200 with a nonzero
        # grpc-status trailer frame, handled below.
        raise RuntimeError(f"grpc-web HTTP transport error: {exc.code} {exc.reason}") from exc

    response_message: routing_pb2.GetQuoteResponse | None = None
    grpc_status: str | None = None
    grpc_message: str | None = None
    for flag, payload in _unframe_all(response_body):
        if flag & _FLAG_TRAILER:
            trailers = _parse_trailer(payload)
            grpc_status = trailers.get("grpc-status")
            grpc_message = trailers.get("grpc-message")
        else:
            response_message = routing_pb2.GetQuoteResponse()
            response_message.ParseFromString(payload)

    if grpc_status is not None and grpc_status != "0":
        raise RuntimeError(f"grpc-web call failed: grpc-status={grpc_status} grpc-message={grpc_message!r}")
    if response_message is None:
        raise RuntimeError("grpc-web response carried no DATA frame")
    return response_message


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Deterministic grpc-web client (the browser's CI stand-in): "
        "frames a GetQuoteRequest exactly as the grpc-web JavaScript library "
        "would, POSTs it to an Envoy grpc_web listener, and prints the decoded "
        "GetQuoteResponse as JSON."
    )
    parser.add_argument("target", help="Envoy host:port, e.g. envoy-quarkus:10000")
    parser.add_argument("--origin", default="USNYC")
    parser.add_argument("--destination", default="NLRTM")
    parser.add_argument("--weight-kg", type=float, default=1000.0)
    args = parser.parse_args()

    response = call_get_quote(args.target, args.origin, args.destination, args.weight_kg)
    print(json_format.MessageToJson(response))


if __name__ == "__main__":
    main()
