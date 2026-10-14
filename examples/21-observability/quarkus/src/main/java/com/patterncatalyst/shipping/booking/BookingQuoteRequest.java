package com.patterncatalyst.shipping.booking;

/**
 * Ch21 observability ANCHOR — {@code POST /booking/quote}'s request body.
 * Jackson serializes record component names as-is, so the JSON field is
 * {@code cargoKg} (camelCase), matching the Python stack's pydantic
 * {@code alias_generator=to_camel} model byte for byte — see
 * python/app/models.py.
 */
public record BookingQuoteRequest(String origin, String destination, double cargoKg) {
}
