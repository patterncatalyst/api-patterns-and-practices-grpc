package com.patterncatalyst.shipping.tracking;

import java.util.List;

import com.google.protobuf.Timestamp;

import shipping.tracking.v1.Tracking;
import shipping.type.v1.Types;

/**
 * The fixed, deterministic 4-event WatchShipment sequence this book has used
 * since Chapter 8: PENDING@USNYC -> CONFIRMED@USNYC -> IN_TRANSIT@NLRTM ->
 * DELIVERED@NLRTM, for any requested booking id.
 */
public final class TrackingEvents {

    private TrackingEvents() {
    }

    public static List<Tracking.TrackingEvent> sequence(String bookingId) {
        Types.Location usnyc = Types.Location.newBuilder().setUnLocode("USNYC").setName("New York").build();
        Types.Location nlrtm = Types.Location.newBuilder().setUnLocode("NLRTM").setName("Rotterdam").build();

        return List.of(
                event(bookingId, usnyc, Types.BookingState.BOOKING_STATE_PENDING, "booking received", 1),
                event(bookingId, usnyc, Types.BookingState.BOOKING_STATE_CONFIRMED, "carrier confirmed", 2),
                event(bookingId, nlrtm, Types.BookingState.BOOKING_STATE_IN_TRANSIT, "arrived at destination port", 3),
                event(bookingId, nlrtm, Types.BookingState.BOOKING_STATE_DELIVERED, "delivered", 4));
    }

    private static Tracking.TrackingEvent event(String bookingId, Types.Location location,
            Types.BookingState state, String note, int hourOffset) {
        return Tracking.TrackingEvent.newBuilder()
                .setBookingId(bookingId)
                .setLocation(location)
                .setState(state)
                .setAt(Timestamp.newBuilder().setSeconds(1_700_000_000L + hourOffset * 3600L).build())
                .setNote(note)
                .build();
    }
}
