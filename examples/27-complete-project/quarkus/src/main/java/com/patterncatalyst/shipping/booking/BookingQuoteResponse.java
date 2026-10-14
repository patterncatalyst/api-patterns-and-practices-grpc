package com.patterncatalyst.shipping.booking;

/**
 * Ch27 final project — {@code POST /booking/quote}'s response body.
 * {@code traceId} is the hex W3C trace id of the span this request ran
 * under — the same id {@code RoutingServiceImpl} and {@code QuoteServiceImpl}
 * both logged handling the two mTLS+JWT gRPC hops underneath this call.
 */
public record BookingQuoteResponse(String traceId, BookingMoney quote, BookingRoute route) {
}
