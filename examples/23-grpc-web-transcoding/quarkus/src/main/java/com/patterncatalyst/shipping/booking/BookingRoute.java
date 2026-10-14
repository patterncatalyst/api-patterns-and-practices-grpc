package com.patterncatalyst.shipping.booking;

import java.util.List;

public record BookingRoute(String id, List<BookingLeg> legs) {
}
