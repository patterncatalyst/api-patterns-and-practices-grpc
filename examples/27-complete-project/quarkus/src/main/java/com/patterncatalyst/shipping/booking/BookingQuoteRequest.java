package com.patterncatalyst.shipping.booking;

/** Ch27 final project — {@code POST /booking/quote}'s request body. */
public record BookingQuoteRequest(String origin, String destination, double cargoKg) {
}
