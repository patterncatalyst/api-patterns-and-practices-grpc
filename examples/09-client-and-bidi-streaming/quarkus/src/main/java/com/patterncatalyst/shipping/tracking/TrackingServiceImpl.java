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
 * Ch9 client-and-bidi-streaming — {@code ReportPositions} (client streaming)
 * and {@code Sync} (bidirectional streaming), implemented identically here
 * and in the Python stack (see
 * python/app/tracking_service.py). {@code WatchShipment} (server streaming,
 * Ch8's RPC) is declared on the same service and intentionally returns
 * UNIMPLEMENTED here — this chapter's example registers only
 * TrackingService, and only the two RPCs it teaches.
 */
@GrpcService
public class TrackingServiceImpl implements TrackingService {

    private static final Logger LOG = Logger.getLogger(TrackingServiceImpl.class);

    /**
     * Client-streaming: fold every {@code ReportPositionsRequest} the caller
     * sends into a single {@code ReportPositionsResponse}. {@code collect().asList()}
     * subscribes to the inbound {@code Multi}, buffers every item until the
     * client half-closes its side of the stream (no more requests coming),
     * and completes the returned {@code Uni} with the full list at that
     * point — exactly the "count what arrived, ack once" shape the proto
     * comment describes.
     */
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

    /**
     * Bidirectional: for every {@code SyncRequest} received, emit one
     * {@code SyncResponse} acknowledging its event. {@code onItem().transform}
     * is a 1:1 mapping operator — it preserves the arrival order of the
     * inbound stream in the outbound one, so N requests in produces N
     * responses out, in the same order, without buffering the whole stream
     * first (unlike {@code reportPositions} above, a response can go out
     * before the next request arrives).
     */
    @Override
    public Multi<Tracking.SyncResponse> sync(Multi<Tracking.SyncRequest> request) {
        return request.onItem().transform(req ->
                Tracking.SyncResponse.newBuilder()
                        .setEvent(req.getEvent())
                        .build());
    }

    @Override
    public Multi<Tracking.WatchShipmentResponse> watchShipment(Tracking.WatchShipmentRequest request) {
        return Multi.createFrom().failure(unimplemented("WatchShipment"));
    }

    private static StatusRuntimeException unimplemented(String method) {
        return Status.UNIMPLEMENTED
                .withDescription(method + " is Ch8's RPC — not re-implemented in this chapter's example")
                .asRuntimeException();
    }
}
