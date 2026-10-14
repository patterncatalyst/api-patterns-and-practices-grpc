package com.patterncatalyst.shipping.booking;

import java.util.List;

/** Ch27 final project — the {@code route} field of a booking-quote response. */
public record BookingRoute(String id, List<BookingLeg> legs) {
}
