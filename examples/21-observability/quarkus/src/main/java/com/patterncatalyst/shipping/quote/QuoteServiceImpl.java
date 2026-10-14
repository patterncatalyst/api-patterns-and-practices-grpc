package com.patterncatalyst.shipping.quote;

import org.jboss.logging.Logger;

import io.opentelemetry.api.trace.Span;
import io.quarkus.grpc.GrpcService;
import io.smallrye.mutiny.Uni;
import shipping.quote.v1.Quote;
import shipping.quote.v1.QuoteService;
import shipping.type.v1.Types;

/**
 * Ch21 observability ANCHOR — the DOWNSTREAM service RoutingServiceImpl.getQuote
 * calls over its own loopback {@code @GrpcClient("quote")} channel (see
 * RoutingServiceImpl and application.properties). Unlike Ch10, this version has
 * no artificial delay — the chapter's point is tracing and metrics, not deadline
 * propagation, so the hop stays fast.
 *
 * <p>{@code quarkus-opentelemetry}'s gRPC server instrumentation (on by default,
 * {@code quarkus.otel.instrument.grpc}) extracts the W3C {@code traceparent} the
 * caller's instrumented client channel injected into this call's metadata and
 * starts THIS method's span as a CHILD of that caller — {@link Span#current()}
 * below is already running inside a span whose trace id matches whatever trace
 * the original REST request started. Logging that trace id here, and logging the
 * SAME trace id in RoutingServiceImpl.getQuote, is exactly what verify.sh greps
 * for: proof that the traceparent survived the loopback gRPC hop end to end.
 */
@GrpcService
public class QuoteServiceImpl implements QuoteService {

    private static final Logger LOG = Logger.getLogger(QuoteServiceImpl.class);

    @Override
    public Uni<Quote.GetQuoteResponse> getQuote(Quote.GetQuoteRequest request) {
        Types.Money quote = QuoteCalculator.compute(request.getCargoList());
        String traceId = Span.current().getSpanContext().getTraceId();

        LOG.infof("QuoteServiceImpl.GetQuote traceId=%s %s -> %s quote=%s %s",
                traceId, request.getOrigin().getUnLocode(), request.getDestination().getUnLocode(),
                quote.getCurrency(), quote.getAmount());

        return Uni.createFrom().item(Quote.GetQuoteResponse.newBuilder().setQuote(quote).build());
    }
}
