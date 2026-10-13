package com.patterncatalyst.shipping.routing;

import java.util.function.Supplier;

import jakarta.inject.Inject;

import org.jboss.logging.Logger;

import io.grpc.Status;
import io.grpc.StatusRuntimeException;
import io.quarkus.grpc.GrpcService;
import io.smallrye.common.annotation.Blocking;
import io.smallrye.mutiny.Multi;
import io.smallrye.mutiny.Uni;
import io.vertx.core.Context;
import io.vertx.core.Vertx;
import shipping.routing.v1.Routing;
import shipping.routing.v1.RoutingService;
import shipping.type.v1.Types;

/**
 * Ch15 backend-io-concurrency ANCHOR — {@code FindOptimalRoute} performs the
 * same ~400ms of simulated blocking DB+file I/O ({@link PricingCache#lookup})
 * in every mode; what changes is which thread runs it, selected by a
 * demo-only flag carried in {@code request.origin.name} (see the class
 * Javadoc on {@link #MODE_STARVING} and {@link #MODE_VIRTUAL}, and
 * README.md for the full table):
 *
 * <pre>
 *   "" (unset, the default) -&gt; CORRECT model: this method is annotated
 *       {@literal @}Blocking, so quarkus-grpc has ALREADY dispatched this
 *       invocation onto the default Vert.x worker pool before a single line
 *       of its body runs. The lookup runs right where it is called — no
 *       further hop needed. Eight concurrent calls in this mode use eight
 *       of the worker pool's threads (default size 20) and overlap.
 *   "starving" -&gt; the STARVING contrast: {@link #onEventLoop} hops back
 *       OFF the worker thread this method was already dispatched to and
 *       runs the identical lookup on ONE fixed Vert.x event-loop context,
 *       lazily captured on the first starving call and reused by every
 *       later one ({@link #starvingContext()}) — the literal case this
 *       chapter names: blocking I/O performed directly in an
 *       event-loop-dispatched Uni. Pinning every starving call to the SAME
 *       context, rather than reading {@code Vertx.currentContext()} fresh
 *       per call, is deliberate: the app otherwise runs Vert.x's default
 *       event-loop pool (2x the host's CPU count), so eight concurrent
 *       calls would each land on their OWN loop on most machines and never
 *       contend at all. Sharing one context makes the serialization — and
 *       this chapter's timing assertions — reproducible at any core count,
 *       without shrinking the whole application down to one event loop
 *       (which would also delay every OTHER call's response write, not
 *       just the starving ones). Eight concurrent calls in this mode queue
 *       behind each other on that one shared thread instead of overlapping.
 *   "virtual" -&gt; a third, illustrative model: {@link #onVirtualThread}
 *       dispatches onto a fresh platform-independent virtual thread per
 *       call, reproducing by hand what the real
 *       {@literal @}RunOnVirtualThread annotation does automatically when
 *       it is the sole annotation on a gRPC method (see "How the code
 *       works" for why this demo can't just add the annotation to a second
 *       method and call it).
 * </pre>
 *
 * The other seven {@code RoutingService} RPCs return {@code UNIMPLEMENTED},
 * same discipline as every prior chapter's example — only one RPC is this
 * chapter's real anchor.
 */
@GrpcService
public class RoutingServiceImpl implements RoutingService {

    private static final Logger LOG = Logger.getLogger(RoutingServiceImpl.class);

    static final String MODE_STARVING = "starving";
    static final String MODE_VIRTUAL = "virtual";

    @Inject
    Vertx vertx;

    private volatile Context starvingContext;

    /**
     * Returns the ONE event-loop context every "starving" call shares,
     * creating it on the first call and caching it for the lifetime of this
     * singleton {@literal @}GrpcService bean. See the class Javadoc for why
     * a single shared context, rather than each call's own
     * {@code Vertx.currentContext()}, is what makes the starvation
     * reproducible regardless of the host's core count.
     */
    private Context starvingContext() {
        Context context = starvingContext;
        if (context == null) {
            synchronized (this) {
                context = starvingContext;
                if (context == null) {
                    context = vertx.getOrCreateContext();
                    starvingContext = context;
                }
            }
        }
        return context;
    }

    @Blocking
    @Override
    public Uni<Routing.FindOptimalRouteResponse> findOptimalRoute(Routing.FindOptimalRouteRequest request) {
        String mode = request.getOrigin().getName();
        String originCode = request.getOrigin().getUnLocode();
        String destCode = request.getDestination().getUnLocode();

        Supplier<Routing.FindOptimalRouteResponse> work = () -> buildResponse(originCode, destCode);

        LOG.infof("FindOptimalRoute: origin=%s destination=%s mode='%s' thread=%s",
                originCode, destCode, mode.isEmpty() ? "(default)" : mode, Thread.currentThread());

        return switch (mode) {
            case MODE_STARVING -> onEventLoop(work);
            case MODE_VIRTUAL -> onVirtualThread(work);
            default -> Uni.createFrom().item(work);
        };
    }

    /**
     * STARVING contrast path. {@link Context#runOnContext(Runnable)}
     * schedules the given block onto {@link #starvingContext()}'s one fixed
     * event loop; running the blocking lookup INSIDE that block, rather
     * than just a cheap completion signal, is what makes this the starving
     * path — the event loop thread is occupied for the whole ~400ms, not
     * handed back immediately. This is the same primitive the Quarkus
     * "duplicated context" reference guide uses to hop code onto an event
     * loop from a worker thread ({@code context.runOnContext(runnable)});
     * the difference here is deliberately reusing ONE context across every
     * call instead of each call's own current context (see the class
     * Javadoc on {@link #MODE_STARVING}).
     */
    private Uni<Routing.FindOptimalRouteResponse> onEventLoop(Supplier<Routing.FindOptimalRouteResponse> work) {
        Context context = starvingContext();
        return Uni.createFrom().emitter(emitter -> context.runOnContext(ignored -> {
            try {
                emitter.complete(work.get());
            } catch (RuntimeException e) {
                emitter.fail(e);
            }
        }));
    }

    /**
     * Illustrative virtual-thread path: starts one fresh virtual thread per
     * call and runs the lookup there. {@code @RunOnVirtualThread} does the
     * same dispatch automatically when it is the method's execution-model
     * annotation; this demo reproduces it with {@link Thread#ofVirtual()}
     * directly because one shared method needs to switch models at
     * request time, which a method-level annotation cannot do.
     */
    private static Uni<Routing.FindOptimalRouteResponse> onVirtualThread(
            Supplier<Routing.FindOptimalRouteResponse> work) {
        return Uni.createFrom().emitter(emitter -> Thread.ofVirtual().start(() -> {
            try {
                emitter.complete(work.get());
            } catch (RuntimeException e) {
                emitter.fail(e);
            }
        }));
    }

    private static Routing.FindOptimalRouteResponse buildResponse(String originCode, String destCode) {
        PricingCache.Entry entry = PricingCache.lookup(originCode, destCode);

        Types.Money price = Types.Money.newBuilder()
                .setCurrency("USD")
                .setAmount(entry.priceAmount())
                .build();
        Types.Leg leg = Types.Leg.newBuilder()
                .setCarrier(entry.carrier())
                .setOrigin(Types.Location.newBuilder().setUnLocode(entry.originCode()).build())
                .setDestination(Types.Location.newBuilder().setUnLocode(entry.destCode()).build())
                .build();
        Types.Route route = Types.Route.newBuilder()
                .setId(entry.routeId())
                .addLegs(leg)
                .setPrice(price)
                .build();
        return Routing.FindOptimalRouteResponse.newBuilder().setRoute(route).build();
    }

    @Override
    public Uni<Routing.GetQuoteResponse> getQuote(Routing.GetQuoteRequest request) {
        return Uni.createFrom().failure(unimplemented("GetQuote"));
    }

    @Override
    public Uni<Routing.ListRoutesResponse> listRoutes(Routing.ListRoutesRequest request) {
        return Uni.createFrom().failure(unimplemented("ListRoutes"));
    }

    @Override
    public Uni<Routing.RecomputeRoutesResponse> recomputeRoutes(Routing.RecomputeRoutesRequest request) {
        return Uni.createFrom().failure(unimplemented("RecomputeRoutes"));
    }

    @Override
    public Multi<Routing.NegotiateRouteResponse> negotiateRoute(Multi<Routing.NegotiateRouteRequest> request) {
        return Multi.createFrom().failure(unimplemented("NegotiateRoute"));
    }

    private static StatusRuntimeException unimplemented(String method) {
        return Status.UNIMPLEMENTED
                .withDescription(method + " lands in a later chapter")
                .asRuntimeException();
    }
}
