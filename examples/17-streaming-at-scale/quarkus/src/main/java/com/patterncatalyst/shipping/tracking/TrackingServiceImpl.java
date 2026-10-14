package com.patterncatalyst.shipping.tracking;

import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

import org.jboss.logging.Logger;

import io.grpc.Status;
import io.grpc.StatusRuntimeException;
import io.quarkus.grpc.GrpcService;
import io.smallrye.mutiny.Multi;
import io.smallrye.mutiny.Uni;
import io.smallrye.mutiny.subscription.MultiEmitter;
import io.vertx.core.Vertx;
import jakarta.inject.Inject;
import shipping.tracking.v1.Tracking;
import shipping.tracking.v1.TrackingService;

/**
 * Ch17 streaming-at-scale ANCHOR — {@code WatchShipment} as a DEMAND-DRIVEN
 * live feed. The booking id carried on the request is a demo-only mode
 * selector (no domain meaning, same trick Ch15 used with
 * {@code origin.name} — see README.md):
 *
 * <pre>
 *   "bkg_demo"  -&gt; the headline case: {@link #demandDrivenMulti} builds a
 *       Multi from {@code Multi.createFrom().emitter(...)}. Production is
 *       gated on demand, never unconditional: it starts only once
 *       {@link MultiEmitter#requested()} shows outstanding demand, checked
 *       both immediately (the generated gRPC bridge's subscriber already
 *       calls {@code Subscription.request(PREFETCH)} during
 *       {@code onSubscribe}, before this consumer lambda runs, so demand
 *       often exists from the first instant) and again on every later
 *       {@link MultiEmitter#onRequest(java.util.function.LongConsumer)}
 *       call (which fires when the stream, wired via
 *       {@code ServerCallStreamObserver#setOnReadyHandler}, becomes ready to
 *       write more). Each event is built and stamped with
 *       {@code Instant.now()} roughly STEP_DELAY_MS apart, scheduled with
 *       {@link Vertx#setTimer} rather than {@code Thread.sleep} so pacing
 *       costs no thread.
 *   "bkg_quiet" -&gt; the same demand-driven emitter, reused for a 2-event
 *       feed with one QUIET_GAP_MS pause between them — proving a stream can
 *       sit idle for seconds and still deliver its final event.
 *   "bkg_eager" (or anything else unrecognized) -&gt; the contrast case:
 *       {@link TrackingEvents#eagerSequence} builds and stamps all 6 events
 *       in one tight loop BEFORE the Multi is even constructed, then
 *       {@code Multi.createFrom().items(...)} streams the already-built
 *       list — the same pre-materialized shape Chapter 8 used, now visible
 *       as the wrong default once a feed is long-lived instead of 4 fixed
 *       events.
 *   anything else -&gt; falls through to the demand-driven 6-event feed, same
 *       as "bkg_demo" (a safe default for an unrecognized or empty booking
 *       id).
 * </pre>
 *
 * {@code ReportPositions} and {@code Sync} return {@code UNIMPLEMENTED}, same
 * discipline as every prior chapter's anchor.
 */
@GrpcService
public class TrackingServiceImpl implements TrackingService {

    private static final Logger LOG = Logger.getLogger(TrackingServiceImpl.class);

    static final String BKG_EAGER = "bkg_eager";
    static final String BKG_QUIET = "bkg_quiet";

    // ~Quarter-second production cadence: comfortably inside what the bundled
    // slow_consumer.py (one read every ~300ms) can keep up with, and well
    // past verify.sh's >=200ms-per-step / >=0.6s-whole-stream floors. See
    // README.md "Why ~260ms, not ~150ms" for the reasoning.
    private static final long STEP_DELAY_MS = 260;
    private static final long QUIET_GAP_MS = 2_000;

    @Inject
    Vertx vertx;

    @Override
    public Multi<Tracking.WatchShipmentResponse> watchShipment(Tracking.WatchShipmentRequest request) {
        String bookingId = request.getBookingId();
        LOG.infof("WatchShipment: opening stream for bookingId=%s", bookingId);

        if (BKG_EAGER.equals(bookingId)) {
            // Built and stamped BEFORE the Multi exists — demand plays no
            // part in when these timestamps were set.
            List<Tracking.TrackingEvent> events = TrackingEvents.eagerSequence(bookingId);
            return Multi.createFrom().items(events.stream())
                    .map(event -> Tracking.WatchShipmentResponse.newBuilder().setEvent(event).build());
        }
        if (BKG_QUIET.equals(bookingId)) {
            return demandDrivenMulti(bookingId, TrackingEvents.QUIET_WAYPOINTS, new long[] { 0, QUIET_GAP_MS });
        }
        return demandDrivenMulti(bookingId, TrackingEvents.DEMO_WAYPOINTS,
                new long[] { 0, STEP_DELAY_MS, STEP_DELAY_MS, STEP_DELAY_MS, STEP_DELAY_MS, STEP_DELAY_MS });
    }

    /**
     * Builds a Multi that produces exactly {@code waypoints.size()} events,
     * one at a time, ON DEMAND: nothing is built until
     * {@link MultiEmitter#onRequest} fires, and production only continues
     * past one item while {@link MultiEmitter#requested()} still shows
     * outstanding demand — otherwise it stops and waits for the next
     * {@code onRequest} call (which fires again once the stream becomes
     * ready to write more). {@code delaysMs[i]} is how long to wait (via
     * {@link Vertx#setTimer}, never a blocking sleep) before producing event
     * {@code i}; {@code delaysMs[0]} is 0 so the first event is immediate.
     */
    private Multi<Tracking.WatchShipmentResponse> demandDrivenMulti(
            String bookingId, List<TrackingEvents.Waypoint> waypoints, long[] delaysMs) {
        return Multi.createFrom().emitter(emitter -> {
            AtomicInteger index = new AtomicInteger(0);
            AtomicBoolean producing = new AtomicBoolean(false);
            Runnable maybeStart = () -> {
                if (emitter.requested() > 0 && producing.compareAndSet(false, true)) {
                    scheduleStep(emitter, bookingId, waypoints, delaysMs, index, producing);
                }
            };
            // onRequest covers demand granted AFTER this consumer runs (the
            // replenish-after-exhaustion case). It does NOT cover the
            // INITIAL demand: the generated gRPC bridge's subscriber calls
            // Subscription.request(PREFETCH) as part of onSubscribe, which
            // happens before this consumer lambda gets a chance to register
            // onRequest — so that first request(PREFETCH) already landed in
            // emitter.requested() with no callback to observe it. The
            // explicit maybeStart.run() below catches exactly that case.
            emitter.onRequest(requested -> maybeStart.run());
            maybeStart.run();
        });
    }

    /**
     * Produces exactly one event (after {@code delaysMs[index]}), then either
     * schedules the next one immediately — if the subscriber still has
     * outstanding demand — or stops and flips {@code producing} back to
     * false so the NEXT {@code onRequest} call restarts this chain. This is
     * the loop that makes production demand-driven rather than
     * fire-and-forget: a subscriber that stops requesting (a cancelled call,
     * a stream that is not ready to write) simply never gets another
     * {@code scheduleStep} invocation.
     */
    private void scheduleStep(MultiEmitter<? super Tracking.WatchShipmentResponse> emitter, String bookingId,
            List<TrackingEvents.Waypoint> waypoints, long[] delaysMs, AtomicInteger index, AtomicBoolean producing) {
        int i = index.get();
        if (i >= waypoints.size()) {
            emitter.complete();
            return;
        }
        Runnable produce = () -> {
            if (emitter.isCancelled()) {
                producing.set(false);
                return;
            }
            Tracking.TrackingEvent event = TrackingEvents.buildEvent(bookingId, i, waypoints);
            emitter.emit(Tracking.WatchShipmentResponse.newBuilder().setEvent(event).build());
            int next = index.incrementAndGet();
            if (next >= waypoints.size()) {
                emitter.complete();
                producing.set(false);
            } else if (emitter.requested() > 0) {
                scheduleStep(emitter, bookingId, waypoints, delaysMs, index, producing);
            } else {
                // No outstanding demand left — stop here. The next
                // onRequest() call (fired when the stream is ready for more)
                // will restart this chain from the current index.
                producing.set(false);
            }
        };
        long delay = delaysMs[i];
        if (delay <= 0) {
            produce.run();
        } else {
            vertx.setTimer(delay, tick -> produce.run());
        }
    }

    @Override
    public Uni<Tracking.ReportPositionsResponse> reportPositions(Multi<Tracking.ReportPositionsRequest> request) {
        return Uni.createFrom().failure(unimplemented("ReportPositions"));
    }

    @Override
    public Multi<Tracking.SyncResponse> sync(Multi<Tracking.SyncRequest> request) {
        return Multi.createFrom().failure(unimplemented("Sync"));
    }

    private static StatusRuntimeException unimplemented(String method) {
        return Status.UNIMPLEMENTED
                .withDescription(method + " is not part of this chapter's streaming-at-scale anchor")
                .asRuntimeException();
    }
}
