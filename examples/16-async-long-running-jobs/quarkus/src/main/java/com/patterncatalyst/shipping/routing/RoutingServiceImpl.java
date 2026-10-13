package com.patterncatalyst.shipping.routing;

import jakarta.inject.Inject;

import org.jboss.logging.Logger;

import io.grpc.Status;
import io.grpc.StatusRuntimeException;
import io.quarkus.grpc.GrpcService;
import io.smallrye.mutiny.Multi;
import io.smallrye.mutiny.Uni;
import io.smallrye.mutiny.infrastructure.Infrastructure;
import shipping.routing.v1.Routing;
import shipping.routing.v1.RoutingService;

/**
 * Ch16 async/long-running-jobs example — {@code RecomputeRoutes} starts a
 * server-owned {@code Operation}. The three lookup RPCs that poll, watch, and
 * cancel it — {@code GetOperation}, {@code WatchOperation}, {@code
 * CancelOperation} — live on a SEPARATE {@code @GrpcService} bean, {@link
 * OperationsServiceImpl}, implementing {@code shipping.routing.v1.
 * OperationsService} rather than a trio of extra methods here. quarkus-grpc
 * generates a fully abstract interface per service, so adding those three
 * RPCs to {@code RoutingService} itself would force every other chapter's
 * {@code RoutingServiceImpl} to grow overrides it has no business providing;
 * putting them on their own service (AIP-151's dedicated Operations service)
 * keeps this bean's interface exactly the five RPCs {@code RoutingService}
 * has always declared. The two beans share one {@link OperationRegistry} —
 * both are CDI-injected the identical {@code @ApplicationScoped} singleton —
 * so a {@code RecomputeRoutes} call here and a {@code GetOperation} call on
 * {@link OperationsServiceImpl} read and write the same {@link
 * OperationState} record.
 *
 * <p>{@code RecomputeRoutes} itself returns instantly — it creates the
 * {@link OperationState} record and hands the actual work to {@link
 * Infrastructure#getDefaultExecutor()}, Mutiny's own worker-thread pool,
 * the same pool a method annotated {@code @Blocking} runs on. Nothing about
 * advancing {@code progress_pct} ever touches the Vert.x event loop that
 * also has to answer every other RPC this process serves concurrently.
 *
 * <p>The other four {@code RoutingService} RPCs (everything except {@code
 * RecomputeRoutes}) return {@code UNIMPLEMENTED}, as in every prior
 * chapter's anchor — this bean still overrides all five, since
 * quarkus-grpc's generated interface is fully abstract.
 */
@GrpcService
public class RoutingServiceImpl implements RoutingService {

    private static final Logger LOG = Logger.getLogger(RoutingServiceImpl.class);

    // The normal RecomputeRoutes job: 5 steps x 200ms = 1s to done=true/100%,
    // comfortably inside verify.sh's bounded poll loop and with enough margin
    // that WatchOperation's stream always has progress to report before the
    // job finishes, even on a loaded CI runner.
    private static final int NORMAL_STEPS = 5;
    private static final long NORMAL_STEP_MS = 200;

    // The "slow" variant (reason contains "slow"): 20 steps x 200ms = 4s total,
    // a deterministic window in which verify.sh calls CancelOperation well
    // before the job would finish on its own.
    private static final int SLOW_STEPS = 20;
    private static final long SLOW_STEP_MS = 200;

    @Inject
    OperationRegistry registry;

    @Override
    public Uni<Routing.RecomputeRoutesResponse> recomputeRoutes(Routing.RecomputeRoutesRequest request) {
        String reason = request.getReason();
        boolean slow = reason != null && reason.contains("slow");
        int steps = slow ? SLOW_STEPS : NORMAL_STEPS;
        long stepMs = slow ? SLOW_STEP_MS : NORMAL_STEP_MS;

        OperationState state = registry.create("recompute_routes");
        LOG.infof("RecomputeRoutes: id=%s reason=%s starting (%d steps x %dms, %s variant)",
                state.id, reason, steps, stepMs, slow ? "slow" : "normal");

        // Off the event loop: Infrastructure.getDefaultExecutor() is Mutiny's
        // worker-thread pool, not the Vert.x I/O thread this method itself
        // returns on. RecomputeRoutes answers the caller immediately with the
        // freshly-created, done=false Operation; the job below keeps running
        // after this Uni has already completed.
        Infrastructure.getDefaultExecutor().execute(() -> runJob(state, steps, stepMs));

        return Uni.createFrom().item(Routing.RecomputeRoutesResponse.newBuilder()
                .setOperation(state.snapshot())
                .build());
    }

    private void runJob(OperationState state, int steps, long stepMs) {
        for (int i = 1; i <= steps; i++) {
            if (state.isDone()) {
                LOG.infof("RecomputeRoutes: id=%s job stopping early (cancelled)", state.id);
                return;
            }
            try {
                Thread.sleep(stepMs);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return;
            }
            if (state.isDone()) {
                LOG.infof("RecomputeRoutes: id=%s job stopping early (cancelled)", state.id);
                return;
            }
            int pct = (int) Math.round(100.0 * i / steps);
            if (i == steps) {
                state.complete("recompute complete: routes reconciled");
            } else {
                state.advance(pct, "recomputing routes (" + pct + "%)");
            }
        }
        LOG.infof("RecomputeRoutes: id=%s job finished", state.id);
    }

    @Override
    public Uni<Routing.GetQuoteResponse> getQuote(Routing.GetQuoteRequest request) {
        return Uni.createFrom().failure(unimplemented("GetQuote"));
    }

    @Override
    public Uni<Routing.FindOptimalRouteResponse> findOptimalRoute(Routing.FindOptimalRouteRequest request) {
        return Uni.createFrom().failure(unimplemented("FindOptimalRoute"));
    }

    @Override
    public Uni<Routing.ListRoutesResponse> listRoutes(Routing.ListRoutesRequest request) {
        return Uni.createFrom().failure(unimplemented("ListRoutes"));
    }

    @Override
    public Multi<Routing.NegotiateRouteResponse> negotiateRoute(Multi<Routing.NegotiateRouteRequest> request) {
        return Multi.createFrom().failure(unimplemented("NegotiateRoute"));
    }

    private static StatusRuntimeException unimplemented(String method) {
        return Status.UNIMPLEMENTED
                .withDescription(method + " is not part of this chapter's example")
                .asRuntimeException();
    }
}
