package com.patterncatalyst.shipping.tracking;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

import com.google.protobuf.Timestamp;

import shipping.tracking.v1.Tracking;
import shipping.type.v1.Types;

/**
 * Ch17 streaming-at-scale example — the waypoint tables {@code WatchShipment}
 * streams for each demo-only mode (see {@code TrackingServiceImpl} for the
 * dispatch), shared in spirit with the Python stack (see
 * ../../../python/app/events.py). Unlike Chapter 8's fixed historical
 * timestamps, every event here is stamped with {@link Instant#now()} at the
 * moment it is PRODUCED — the whole point of this chapter's backpressure
 * demonstration is comparing WHEN the server computed that timestamp, not a
 * canned value.
 */
final class TrackingEvents {

    private TrackingEvents() {
    }

    private static final Types.Location USNYC = Types.Location.newBuilder().setUnLocode("USNYC").setName("New York").build();
    private static final Types.Location NLRTM = Types.Location.newBuilder().setUnLocode("NLRTM").setName("Rotterdam").build();
    private static final Types.Location DEHAM = Types.Location.newBuilder().setUnLocode("DEHAM").setName("Hamburg").build();
    private static final Types.Location SGSIN = Types.Location.newBuilder().setUnLocode("SGSIN").setName("Singapore").build();

    // Package-private (not private): TrackingServiceImpl, in the same
    // package, needs this type to drive the demand-driven emitter without
    // TrackingEvents exposing anything to callers outside this module.
    record Waypoint(Types.Location location, Types.BookingState state) {
    }

    /**
     * {@code bkg_demo}: the 6-event ordered demand feed. Extends Chapter 8's
     * {@code PENDING -> CONFIRMED -> IN_TRANSIT -> DELIVERED} progression with
     * two extra {@code IN_TRANSIT} waypoints (a second port call, then a
     * transshipment leg) so a demand-driven feed has enough events to show a
     * measurable production cadence.
     */
    static final List<Waypoint> DEMO_WAYPOINTS = List.of(
            new Waypoint(USNYC, Types.BookingState.BOOKING_STATE_PENDING),
            new Waypoint(USNYC, Types.BookingState.BOOKING_STATE_CONFIRMED),
            new Waypoint(NLRTM, Types.BookingState.BOOKING_STATE_IN_TRANSIT),
            new Waypoint(DEHAM, Types.BookingState.BOOKING_STATE_IN_TRANSIT),
            new Waypoint(SGSIN, Types.BookingState.BOOKING_STATE_IN_TRANSIT),
            new Waypoint(SGSIN, Types.BookingState.BOOKING_STATE_DELIVERED));

    /**
     * {@code bkg_quiet}: a 2-event feed with a multi-second quiet gap between
     * them, demonstrating that a long idle stretch on an otherwise-open
     * stream still delivers its final event rather than being silently
     * dropped. Collapsing straight from {@code PENDING} to {@code DELIVERED}
     * with no intermediate states is a simplification specific to this
     * demo-only mode (see README.md) — this mode's subject is the quiet gap,
     * not a realistic voyage.
     */
    static final List<Waypoint> QUIET_WAYPOINTS = List.of(
            new Waypoint(USNYC, Types.BookingState.BOOKING_STATE_PENDING),
            new Waypoint(USNYC, Types.BookingState.BOOKING_STATE_DELIVERED));

    /**
     * Builds and stamps the event at index {@code index} of {@code waypoints}
     * RIGHT NOW — {@code at} is this call's wall-clock instant, and
     * {@code note} is a bare {@code "seq=<index>"} marker (not Chapter 8's
     * narrative text) so {@code verify.sh} can read production order and
     * production time straight off the wire without guessing at prose.
     */
    static Tracking.TrackingEvent buildEvent(String bookingId, int index, List<Waypoint> waypoints) {
        Waypoint waypoint = waypoints.get(index);
        Instant now = Instant.now();
        Timestamp at = Timestamp.newBuilder()
                .setSeconds(now.getEpochSecond())
                .setNanos(now.getNano())
                .build();
        return Tracking.TrackingEvent.newBuilder()
                .setBookingId(bookingId)
                .setLocation(waypoint.location())
                .setState(waypoint.state())
                .setAt(at)
                .setNote("seq=" + index)
                .build();
    }

    /**
     * {@code bkg_eager}: every {@link #DEMO_WAYPOINTS} event built and
     * stamped in one tight loop, all effectively at the same instant —
     * before the first one has left the server. This is the pre-materialized
     * contrast {@code TrackingServiceImpl} streams via
     * {@code Multi.createFrom().items(...)}, the same shape Chapter 8 used
     * for its (much smaller, non-paced) 4-event sequence.
     */
    static List<Tracking.TrackingEvent> eagerSequence(String bookingId) {
        List<Tracking.TrackingEvent> events = new ArrayList<>(DEMO_WAYPOINTS.size());
        for (int i = 0; i < DEMO_WAYPOINTS.size(); i++) {
            events.add(buildEvent(bookingId, i, DEMO_WAYPOINTS));
        }
        return events;
    }
}
