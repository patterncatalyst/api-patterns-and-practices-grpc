package com.patterncatalyst.appendixa.getquote;

import org.jboss.logging.Logger;

import io.quarkus.grpc.GrpcService;
import io.smallrye.mutiny.Uni;
import shipping.quote.v1.Quote;
import shipping.quote.v1.QuoteService;
import shipping.type.v1.Types;

/**
 * Appendix A — the same shipping.quote.v1.QuoteService.GetQuote RPC Ch27's
 * final project serves, run here on OpenShift Local to show the
 * Routes/mesh/canary path rather than Ch27's app-level mTLS + JWT path.
 * Zero contract change.
 */
@GrpcService
public class QuoteServiceImpl implements QuoteService {

    private static final Logger LOG = Logger.getLogger(QuoteServiceImpl.class);

    @Override
    public Uni<Quote.GetQuoteResponse> getQuote(Quote.GetQuoteRequest request) {
        Types.Money quote = QuoteCalculator.compute(request.getCargoList());

        LOG.infof("GetQuote served-by=%s %s -> %s quote=%s %s",
                PodIdentity.NAME, request.getOrigin().getUnLocode(),
                request.getDestination().getUnLocode(), quote.getCurrency(), quote.getAmount());

        return Uni.createFrom().item(Quote.GetQuoteResponse.newBuilder().setQuote(quote).build());
    }
}
