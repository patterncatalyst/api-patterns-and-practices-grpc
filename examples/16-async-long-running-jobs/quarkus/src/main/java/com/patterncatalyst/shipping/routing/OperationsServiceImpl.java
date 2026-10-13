package com.patterncatalyst.shipping.routing;

import jakarta.inject.Inject;

import org.jboss.logging.Logger;

import io.grpc.Status;
import io.grpc.StatusRuntimeException;
import io.quarkus.grpc.GrpcService;
import io.smallrye.mutiny.Multi;
import io.smallrye.mutiny.Uni;
import io.smallrye.mutiny.infrastructure.Infrastructure;
import io.smallrye.mutiny.subscription.MultiEmitter;
import shipping.routing.v1.OperationsService;
import shipping.routing.v1.Routing;
import shipping.type.v1.Types;

/**
 * Ch16 async/long-running-jobs example — {@code shipping.routing.v1.
 * OperationsService}, the dedicated lookup surface for the {@link
 * Types.Operation} records {@link RoutingServiceImpl}'s {@code
 * RecomputeRoutes} creates: {@code GetOperation} polls one, {@code
 * WatchOperation} streams its progress, and {@code CancelOperation} stops
 * the server-owned job early.
 *
 * <p>This is a SEPARATE {@code @GrpcService} bean from {@link
 * RoutingServiceImpl} — not three more methods on {@code RoutingService} —
 * because quarkus-grpc generates a fully abstract interface per service.
 * Adding RPCs to {@code RoutingService} would be wire-safe ({@code buf
 * breaking} never flags a new RPC) but SOURCE-breaking for every existing
 * {@code RoutingServiceImpl}, which would suddenly have to override methods
 * it has no routing-specific reason to implement. Putting the three
 * Operation RPCs on their own service instead — the shape AIP-151 and
 * {@code google.longrunning.Operations} both prescribe — means this bean
 * owns exactly the lookup surface, and {@link RoutingServiceImpl} never has
 * to know it exists.
 *
 * <p>The two beans share one {@link OperationRegistry}: both are
 * CDI-injected the identical {@code @ApplicationScoped} singleton, so a
 * {@code RecomputeRoutes} call on {@link RoutingServiceImpl} and a {@code
 * GetOperation}/{@code WatchOperation}/{@code CancelOperation} call here
 * read and write the same {@link OperationState} record.
 */
@GrpcService
public class OperationsServiceImpl implements OperationsService {

    private static final Logger LOG = Logger.getLogger(OperationsServiceImpl.class);

    // WatchOperation's poll interval — how often a snapshot is pushed onto the
    // stream while the operation is still running.
    private static final long WATCH_POLL_MS = 150;

    @Inject
    OperationRegistry registry;

    @Override
    public Uni<Types.Operation> getOperation(Routing.GetOperationRequest request) {
        OperationState state = registry.get(request.getOperationId());
        if (state == null) {
            return Uni.createFrom().failure(notFound(request.getOperationId()));
        }
        return Uni.createFrom().item(state.snapshot());
    }

    @Override
    public Multi<Types.Operation> watchOperation(Routing.WatchOperationRequest request) {
        OperationState state = registry.get(request.getOperationId());
        if (state == null) {
            return Multi.createFrom().failure(notFound(request.getOperationId()));
        }
        // emitOn moves every emission onto the worker pool too, so the loop
        // inside streamSnapshots (including its Thread.sleep) never runs on
        // the event loop thread that opened this stream.
        return Multi.createFrom().<Types.Operation>emitter(emitter -> streamSnapshots(state, emitter))
                .emitOn(Infrastructure.getDefaultExecutor());
    }

    private void streamSnapshots(OperationState state, MultiEmitter<? super Types.Operation> emitter) {
        while (true) {
            Types.Operation snapshot = state.snapshot();
            emitter.emit(snapshot);
            if (snapshot.getDone()) {
                emitter.complete();
                return;
            }
            try {
                Thread.sleep(WATCH_POLL_MS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                emitter.complete();
                return;
            }
        }
    }

    @Override
    public Uni<Types.Operation> cancelOperation(Routing.CancelOperationRequest request) {
        OperationState state = registry.get(request.getOperationId());
        if (state == null) {
            return Uni.createFrom().failure(notFound(request.getOperationId()));
        }
        boolean cancelledNow = state.cancel();
        LOG.infof("CancelOperation: id=%s cancelledNow=%s", state.id, cancelledNow);
        return Uni.createFrom().item(state.snapshot());
    }

    private static StatusRuntimeException notFound(String operationId) {
        return Status.NOT_FOUND
                .withDescription("no such operation: " + operationId)
                .asRuntimeException();
    }
}
