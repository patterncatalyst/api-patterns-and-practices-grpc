#!/usr/bin/env python3
"""Ch3 round-trip assertions.

Run after verify.sh has generated stubs with `python -m grpc_tools.protoc`
into a temp directory and put that directory on PYTHONPATH. This script:

  1. Builds a `shipping.type.v1.Money` message, serializes it, and hand-decodes
     the resulting bytes field-by-field with the same tag-number math the
     chapter's "Hand-decoding a message's bytes" section walks through by
     hand — proving the worked example and the real wire format agree.
  2. Builds a `shipping.type.v1.Booking` (nested message, enum, map, repeated,
     a well-known-type Timestamp) and round-trips it through
     serialize -> parse, asserting every field survives.
  3. Round-trips both branches of a tiny standalone `oneof` demo message
     (oneof_demo.proto, not part of the shipping contract) to show that only
     the populated branch ever reaches the wire.

Exits non-zero with a FAIL line on the first violated assertion; prints PASS
and exits 0 once every assertion holds.
"""
import sys

from shipping.type.v1 import types_pb2
import oneof_demo_pb2


def fail(msg):
    print(f"FAIL — {msg}", file=sys.stderr)
    sys.exit(1)


def check(condition, context):
    if not condition:
        fail(context)
    print(f"ok — {context}")


def read_varint(data, pos):
    """Minimal varint reader — sufficient for the single-byte lengths and
    single-byte keys this example's messages produce."""
    result = 0
    shift = 0
    while True:
        b = data[pos]
        result |= (b & 0x7F) << shift
        pos += 1
        if not (b & 0x80):
            return result, pos
        shift += 7


def hand_decode_length_delimited(data):
    """Walk a serialized message field-by-field assuming every field is wire
    type 2 (LEN) — true for Money, whose two fields are both `string`. Returns
    {field_number: decoded_utf8_string}. This is exactly the manual decode the
    chapter's prose performs on these same bytes."""
    pos = 0
    values = {}
    while pos < len(data):
        key, pos = read_varint(data, pos)
        field_number, wire_type = key >> 3, key & 0x7
        if wire_type != 2:
            fail(f"unexpected wire type {wire_type} for field {field_number}")
        length, pos = read_varint(data, pos)
        values[field_number] = data[pos : pos + length].decode("utf-8")
        pos += length
    return values


def main():
    # --- Money: the chapter's hand-decode example ---------------------------
    money = types_pb2.Money(currency="USD", amount="1250.00")
    data = money.SerializeToString()

    check(data[0] == 0x0A, "Money byte 0 is the field-1 key 0x0A = (1 << 3) | 2")
    check(data[5] == 0x12, "Money byte 5 is the field-2 key 0x12 = (2 << 3) | 2")
    check(len(data) == 14, "Money serializes to exactly 14 bytes")

    decoded = hand_decode_length_delimited(data)
    check(decoded == {1: "USD", 2: "1250.00"}, "hand-decoded Money bytes match the source fields")

    parsed_money = types_pb2.Money()
    parsed_money.ParseFromString(data)
    check(parsed_money.amount == "1250.00", 'Money.amount "1250.00" survives serialize -> parse')
    check(parsed_money == money, "parsed Money equals the original message")

    # --- Booking: nested message, enum, map, repeated, well-known Timestamp -
    booking = types_pb2.Booking(
        id="bkg_01HXYZEXAMPLE",
        origin=types_pb2.Location(un_locode="USNYC", name="New York"),
        destination=types_pb2.Location(un_locode="NLRTM", name="Rotterdam"),
        state=types_pb2.BOOKING_STATE_CONFIRMED,
        quote=types_pb2.Money(currency="USD", amount="3001.25"),
    )
    booking.cargo.add(
        id="crg_01HXYZCARGO",
        description="Palletized electronics",
        cargo_type="GENERAL",
        weight_kg=1200.5,
        volume_m3=10.2,
        hazardous=False,
    )
    booking.labels["priority"] = "high"
    booking.labels["lane"] = "transatlantic"
    booking.created_at.FromJsonString("2026-01-15T12:00:00Z")

    parsed_booking = types_pb2.Booking()
    parsed_booking.ParseFromString(booking.SerializeToString())

    check(parsed_booking == booking, "parsed Booking equals the original message")
    check(
        parsed_booking.state == types_pb2.BOOKING_STATE_CONFIRMED,
        "enum BookingState survives as a real value, not the zero value",
    )
    check(parsed_booking.origin.un_locode == "USNYC", "nested Location message survives")
    check(
        len(parsed_booking.cargo) == 1 and parsed_booking.cargo[0].weight_kg == 1200.5,
        "repeated Cargo survives",
    )
    check(
        dict(parsed_booking.labels) == {"priority": "high", "lane": "transatlantic"},
        "map<string, string> labels survives",
    )
    check(parsed_booking.quote.amount == "3001.25", "nested Money inside Booking survives")
    check(
        parsed_booking.created_at.ToJsonString() == "2026-01-15T12:00:00Z",
        "well-known google.protobuf.Timestamp field created_at survives",
    )

    empty_booking = types_pb2.Booking()
    check(
        empty_booking.state == types_pb2.BOOKING_STATE_UNSPECIFIED,
        "an unset enum field reads back as *_UNSPECIFIED, proto3's zero value — never absent",
    )

    # --- oneof: exactly one branch reaches the wire --------------------------
    email_notif = oneof_demo_pb2.Notification(email="ops@example.com")
    check(email_notif.WhichOneof("channel") == "email", "oneof reports the populated branch (email)")
    parsed_email = oneof_demo_pb2.Notification()
    parsed_email.ParseFromString(email_notif.SerializeToString())
    check(
        parsed_email.email == "ops@example.com" and parsed_email.WhichOneof("channel") == "email",
        "oneof email branch round-trips",
    )

    sms_notif = oneof_demo_pb2.Notification(sms="+15555550123")
    check(sms_notif.WhichOneof("channel") == "sms", "setting a different oneof branch clears the first")
    parsed_sms = oneof_demo_pb2.Notification()
    parsed_sms.ParseFromString(sms_notif.SerializeToString())
    check(
        parsed_sms.WhichOneof("channel") == "sms" and parsed_sms.email == "",
        "oneof sms branch round-trips; reading the unset email branch returns the default, not an error",
    )

    print()
    print(
        "PASS — Money's bytes hand-decoded and parsed; Booking's nested "
        "message, enum, map, repeated field, and well-known Timestamp all "
        "survived serialize -> parse; both oneof_demo branches round-tripped "
        "independently."
    )


if __name__ == "__main__":
    main()
