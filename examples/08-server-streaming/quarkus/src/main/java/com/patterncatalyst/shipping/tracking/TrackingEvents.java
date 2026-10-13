package com.patterncatalyst.shipping.tracking;

import java.time.Instant;
import java.util.List;

import com.google.protobuf.Timestamp;

import shipping.tracking.v1.Tracking;
import shipping.type.v1.Types;

/**
 * Ch8 server-streaming example — the DETERMINISTIC event sequence
 * {@code WatchShipment} streams back, shared by both stacks (see
 * ../../../python/app/events.py). Four {@code TrackingEvent}s, one per
 * {@code BookingState} transition, with fixed, strictly increasing
 * timestamps and a fixed location per event — so the Quarkus and Python
 * responses are byte-for-byte comparable, not just independently plausible.
 */
final class TrackingEvents {

    private TrackingEvents() {
    }

    static List<Tracking.TrackingEvent> sequence(String bookingId) {
        Types.Location usnyc = Types.Location.newBuilder().setUnLocode("USNYC").setName("New York").build();
        Types.Location nlrtm = Types.Location.newBuilder().setUnLocode("NLRTM").setName("Rotterdam").build();

        return List.of(
                event(bookingId, usnyc, Types.BookingState.BOOKING_STATE_PENDING,
                        "2026-01-02T08:00:00Z", "Booking accepted; container released to terminal"),
                event(bookingId, usnyc, Types.BookingState.BOOKING_STATE_CONFIRMED,
                        "2026-01-02T14:00:00Z", "Export customs cleared; loaded onboard MAERSK vessel"),
                event(bookingId, nlrtm, Types.BookingState.BOOKING_STATE_IN_TRANSIT,
                        "2026-01-15T09:30:00Z", "Vessel arrived at Rotterdam; awaiting discharge"),
                event(bookingId, nlrtm, Types.BookingState.BOOKING_STATE_DELIVERED,
                        "2026-01-16T11:00:00Z", "Container discharged and delivered to consignee"));
    }

    private static Tracking.TrackingEvent event(String bookingId, Types.Location location,
            Types.BookingState state, String isoInstant, String note) {
        Instant instant = Instant.parse(isoInstant);
        Timestamp at = Timestamp.newBuilder()
                .setSeconds(instant.getEpochSecond())
                .setNanos(instant.getNano())
                .build();
        return Tracking.TrackingEvent.newBuilder()
                .setBookingId(bookingId)
                .setLocation(location)
                .setState(state)
                .setAt(at)
                .setNote(note)
                .build();
    }
}
