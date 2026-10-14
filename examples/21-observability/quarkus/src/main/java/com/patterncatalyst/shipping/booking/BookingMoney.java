package com.patterncatalyst.shipping.booking;

/** Ch21 observability ANCHOR — the {@code quote} field of a booking-quote response. */
public record BookingMoney(String currency, String amount) {
}
