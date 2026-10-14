package com.patterncatalyst.shipping.booking;

/**
 * Ch23 grpc-web & JSON/HTTP transcoding — {@code POST /booking/quote}'s
 * request body, the hand-written REST shim this chapter contrasts against
 * Envoy's generic {@code grpc_json_transcoder}. Jackson serializes record
 * component names as-is, so the JSON field is {@code cargoKg} (camelCase),
 * matching the Python stack's pydantic {@code alias_generator=to_camel}
 * model byte for byte — see python/app/models.py.
 */
public record BookingQuoteRequest(String origin, String destination, double cargoKg) {
}
