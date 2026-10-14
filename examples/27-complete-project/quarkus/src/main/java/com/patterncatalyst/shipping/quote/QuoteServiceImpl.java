package com.patterncatalyst.shipping.quote;

import org.jboss.logging.Logger;

import io.opentelemetry.api.trace.Span;
import io.quarkus.grpc.GrpcService;
import io.smallrye.mutiny.Uni;
import shipping.quote.v1.Quote;
import shipping.quote.v1.QuoteService;
import shipping.type.v1.Types;

/**
 * Ch27 final project — the DOWNSTREAM service {@code RoutingServiceImpl.getQuote}
 * calls over its own mTLS+JWT loopback channel (see
 * {@code security/SecureGrpcClients.java} and {@code routing/RoutingServiceImpl.java}).
 * Logging the trace id here, and the SAME trace id in
 * {@code RoutingServiceImpl.getQuote}, is what this example's trace-id-
 * continuity assertion greps {@code docker compose logs} for (the Ch21
 * pattern) — proof the W3C traceparent survived the loopback gRPC hop.
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
