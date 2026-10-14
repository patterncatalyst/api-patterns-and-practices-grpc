package com.patterncatalyst.shipping.booking;

import java.util.List;

/** Ch21 observability ANCHOR — the {@code route} field of a booking-quote response. */
public record BookingRoute(String id, List<BookingLeg> legs) {
}
