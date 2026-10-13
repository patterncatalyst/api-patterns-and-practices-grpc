package com.patterncatalyst.shipping.tracking;

import org.jboss.logging.Logger;

import io.grpc.Status;
import io.grpc.StatusRuntimeException;
import io.quarkus.grpc.GrpcService;
import io.smallrye.mutiny.Multi;
import io.smallrye.mutiny.Uni;
import shipping.tracking.v1.Tracking;
import shipping.tracking.v1.TrackingService;

/**
 * Ch8 server-streaming example — {@code WatchShipment}, implemented
 * identically here and in the Python stack (see
 * python/app/tracking_service.py). {@code ReportPositions} (client
 * streaming) and {@code Sync} (bidirectional) are declared in the proto for
 * Chapter 9 and intentionally return {@code UNIMPLEMENTED}.
 */
@GrpcService
public class TrackingServiceImpl implements TrackingService {

    private static final Logger LOG = Logger.getLogger(TrackingServiceImpl.class);

    @Override
    public Multi<Tracking.WatchShipmentResponse> watchShipment(Tracking.WatchShipmentRequest request) {
        String bookingId = request.getBookingId();
        LOG.infof("WatchShipment: opening stream for bookingId=%s", bookingId);

        // Multi.createFrom().items(...) emits the four TrackingEvents, in
        // the exact order supplied, as DATA frames on the one HTTP/2 stream
        // this call opened; the Multi completing is what sends the server's
        // half-close — no explicit "end of stream" call needed.
        return Multi.createFrom().items(TrackingEvents.sequence(bookingId).stream())
                .map(event -> Tracking.WatchShipmentResponse.newBuilder().setEvent(event).build());
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
                .withDescription(method + " lands in Chapter 9 (client-streaming / bidirectional)")
                .asRuntimeException();
    }
}
