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
 * Ch27 final project — TrackingService: WatchShipment (server streaming, the
 * Ch8 deterministic 4-event sequence) and ReportPositions (client streaming,
 * the Ch9 fold-to-accepted_count) implemented for real. Sync (bidirectional)
 * is left UNIMPLEMENTED — illustrative/optional per this chapter's scope; the
 * other three RPC shapes (unary, server-stream, client-stream, bidi) are each
 * exercised for real elsewhere in this example (GetQuote, WatchShipment,
 * ReportPositions, NegotiateRoute).
 */
@GrpcService
public class TrackingServiceImpl implements TrackingService {

    private static final Logger LOG = Logger.getLogger(TrackingServiceImpl.class);

    @Override
    public Multi<Tracking.WatchShipmentResponse> watchShipment(Tracking.WatchShipmentRequest request) {
        String bookingId = request.getBookingId();
        LOG.infof("WatchShipment: opening stream for bookingId=%s", bookingId);

        return Multi.createFrom().items(TrackingEvents.sequence(bookingId).stream())
                .map(event -> Tracking.WatchShipmentResponse.newBuilder().setEvent(event).build());
    }

    @Override
    public Uni<Tracking.ReportPositionsResponse> reportPositions(Multi<Tracking.ReportPositionsRequest> request) {
        return request.collect().asList()
                .onItem().transform(reports -> {
                    LOG.infof("ReportPositions: folded %d position report(s) into one ack", reports.size());
                    return Tracking.ReportPositionsResponse.newBuilder()
                            .setAcceptedCount(reports.size())
                            .build();
                });
    }

    @Override
    public Multi<Tracking.SyncResponse> sync(Multi<Tracking.SyncRequest> request) {
        return Multi.createFrom().failure(unimplemented("Sync"));
    }

    private static StatusRuntimeException unimplemented(String method) {
        return Status.UNIMPLEMENTED
                .withDescription(method + " is declared in the contract but out of scope for this example")
                .asRuntimeException();
    }
}
