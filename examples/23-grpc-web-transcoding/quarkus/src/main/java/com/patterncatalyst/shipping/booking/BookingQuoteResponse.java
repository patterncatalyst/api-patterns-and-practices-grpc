package com.patterncatalyst.shipping.booking;

/**
 * Ch23 grpc-web & JSON/HTTP transcoding — {@code POST /booking/quote}'s
 * response body. Unlike Ch21's version, there is no {@code traceId} field —
 * this chapter is not about tracing, and LGTM stays opt-in (see
 * ../../../../../../compose.yaml's `observability` profile).
 */
public record BookingQuoteResponse(BookingMoney quote, BookingRoute route) {
}
