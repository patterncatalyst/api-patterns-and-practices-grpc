#!/usr/bin/env python3
"""Ch6 measured comparison: protobuf bytes vs. proto3 JSON, and a hand-decode.

Run after verify.sh has generated stubs for `shipping.type.v1` and
`shipping.routing.v1` with `python -m grpc_tools.protoc` into a temp
directory and put that directory on PYTHONPATH. This script:

  1. Builds a representative `shipping.routing.v1.GetQuoteResponse` — the
     real `RoutingService.GetQuote` reply used as the anchor example since
     Chapter 2: a `Money` quote plus a `Route` with one `Leg`.
  2. Serializes it two ways: `SerializeToString()` (protobuf binary) and
     `google.protobuf.json_format.MessageToJson()` (proto3 JSON, the mapping
     Chapter 4 covers). Asserts the protobuf form is strictly smaller and
     prints both sizes and the ratio — the "gRPC is fast" claim, measured
     rather than asserted in prose.
  3. Hand-decodes the first bytes of the protobuf form against the same
     tag-number math Chapter 3's "Hand-decoding a message's bytes" section
     walks through on `Money` alone: `GetQuoteResponse.quote` is tag 1
     (key 0x0A), its embedded `Money` starts with the identical 0x0A key for
     `currency` (tag 1 again, one level down), and the byte immediately
     after that embedded `Money` is the tag-2 key (0x12) for `route`.

Exits non-zero with a FAIL line on the first violated assertion; prints PASS
and exits 0 once every assertion holds.
"""
import sys

from google.protobuf import json_format

from shipping.type.v1 import types_pb2
from shipping.routing.v1 import routing_pb2


def fail(msg):
    print(f"FAIL — {msg}", file=sys.stderr)
    sys.exit(1)


def check(condition, context):
    if not condition:
        fail(context)
    print(f"ok — {context}")


def read_varint(data, pos):
    """Minimal varint reader (same shape as Ch3's), used here only for the
    one length byte GetQuoteResponse's embedded Money needs."""
    result = 0
    shift = 0
    while True:
        b = data[pos]
        result |= (b & 0x7F) << shift
        pos += 1
        if not (b & 0x80):
            return result, pos
        shift += 7


def build_response():
    departs = types_pb2.Location(un_locode="USNYC", name="New York")
    arrives = types_pb2.Location(un_locode="NLRTM", name="Rotterdam")
    leg = types_pb2.Leg(carrier="MaerskLine", origin=departs, destination=arrives)
    leg.departs_at.FromJsonString("2026-02-01T08:00:00Z")
    leg.arrives_at.FromJsonString("2026-02-14T17:30:00Z")

    route = types_pb2.Route(
        id="rte_01HXYZEXAMPLE",
        price=types_pb2.Money(currency="USD", amount="1250.00"),
    )
    route.legs.append(leg)

    return routing_pb2.GetQuoteResponse(
        quote=types_pb2.Money(currency="USD", amount="1250.00"),
        route=route,
    )


def main():
    response = build_response()

    # --- Step 2: measure protobuf bytes vs. proto3 JSON bytes ---------------
    proto_bytes = response.SerializeToString()
    json_text = json_format.MessageToJson(response, indent=None)
    json_bytes = json_text.encode("utf-8")

    proto_len = len(proto_bytes)
    json_len = len(json_bytes)
    ratio = json_len / proto_len

    print(f"protobuf bytes : {proto_len}")
    print(f"proto3 JSON bytes: {json_len}")
    print(f"ratio (JSON / protobuf): {ratio:.2f}x")

    check(
        proto_len < json_len,
        f"protobuf encoding ({proto_len} bytes) is smaller than proto3 JSON ({json_len} bytes)",
    )

    # --- Step 3: hand-decode against Ch3's tag-number math -------------------
    # GetQuoteResponse.quote is field 1 (Money, a message -> wire type 2/LEN):
    # key byte = (1 << 3) | 2 = 0x0A — the exact key Ch3 derives for Money's
    # own field 1, one level up the message now instead of inside it.
    check(
        proto_bytes[0] == 0x0A,
        "byte 0 is 0x0A = (1 << 3) | 2 -> field 1 (quote), wire type 2 (LEN)",
    )

    quote_len, pos = read_varint(proto_bytes, 1)
    check(quote_len < 128, "the embedded Money length fits one varint byte (no continuation bit)")

    # The embedded Money starts at `pos` and begins with its own field 1
    # (currency) — the identical 0x0A key Ch3 decoded for standalone Money,
    # because a key byte encodes (field number, wire type), never depth.
    check(
        proto_bytes[pos] == 0x0A,
        "byte at the embedded Money's start is 0x0A again -> its own field 1 (currency), wire type 2",
    )

    quote_bytes = proto_bytes[pos : pos + quote_len]
    parsed_quote = types_pb2.Money()
    parsed_quote.ParseFromString(quote_bytes)
    check(
        parsed_quote.currency == "USD" and parsed_quote.amount == "1250.00",
        "the embedded Money decodes to currency=USD, amount=1250.00",
    )

    # Immediately after the embedded Money, the next key belongs to
    # GetQuoteResponse.route: field 2, wire type 2/LEN -> (2 << 3) | 2 = 0x12.
    route_key_pos = pos + quote_len
    route_key = proto_bytes[route_key_pos]
    route_field_number, route_wire_type = route_key >> 3, route_key & 0x7
    check(
        route_field_number == 2 and route_wire_type == 2,
        f"byte {route_key_pos} is 0x{route_key:02X} -> field 2 (route), wire type 2 (LEN)",
    )

    # --- Round-trip sanity: the whole message survives serialize -> parse ---
    parsed_response = routing_pb2.GetQuoteResponse()
    parsed_response.ParseFromString(proto_bytes)
    check(parsed_response == response, "the full GetQuoteResponse survives serialize -> parse")
    check(
        len(parsed_response.route.legs) == 1
        and parsed_response.route.legs[0].carrier == "MaerskLine",
        "the nested Route.legs[0] (a Leg, nested two levels deep) survives",
    )

    print()
    print(
        f"PASS — protobuf ({proto_len}B) beat proto3 JSON ({json_len}B) by "
        f"{ratio:.2f}x on the same GetQuoteResponse, and the tag-number math "
        "from Chapter 3 decoded the real bytes at every level: the outer "
        "message's quote field, Money's own currency field one level down, "
        "and the route field immediately after it."
    )


if __name__ == "__main__":
    main()
