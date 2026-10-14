package com.patterncatalyst.shipping.booking;

/**
 * Ch21 observability ANCHOR — {@code POST /booking/quote}'s response body.
 * {@code traceId} is the hex W3C trace id of the span this request ran
 * under — the same id {@code RoutingServiceImpl} and {@code QuoteServiceImpl}
 * both logged while handling the two gRPC hops underneath this call. Take it
 * straight to {@code http://localhost:3200/api/traces/<traceId>} on the
 * always-on Tempo instance (see compose.yaml) to see the whole trace.
 */
public record BookingQuoteResponse(String traceId, BookingMoney quote, BookingRoute route) {
}
