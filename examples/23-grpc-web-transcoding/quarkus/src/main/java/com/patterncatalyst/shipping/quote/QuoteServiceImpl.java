package com.patterncatalyst.shipping.quote;

import org.jboss.logging.Logger;

import io.quarkus.grpc.GrpcService;
import io.smallrye.mutiny.Uni;
import shipping.quote.v1.Quote;
import shipping.quote.v1.QuoteService;
import shipping.type.v1.Types;

/**
 * Ch23 grpc-web & JSON/HTTP transcoding — the DOWNSTREAM service
 * RoutingServiceImpl.getQuote calls over its own loopback
 * {@code @GrpcClient("quote")} channel (see RoutingServiceImpl and
 * application.properties). Identical to Ch21/Ch18's QuoteServiceImpl: this
 * chapter adds nothing to the server itself, only a proxy (Envoy) in front
 * of it — see ../../../../../../envoy/.
 */
@GrpcService
public class QuoteServiceImpl implements QuoteService {

    private static final Logger LOG = Logger.getLogger(QuoteServiceImpl.class);

    @Override
    public Uni<Quote.GetQuoteResponse> getQuote(Quote.GetQuoteRequest request) {
        Types.Money quote = QuoteCalculator.compute(request.getCargoList());

        LOG.infof("QuoteServiceImpl.GetQuote %s -> %s quote=%s %s",
                request.getOrigin().getUnLocode(), request.getDestination().getUnLocode(),
                quote.getCurrency(), quote.getAmount());

        return Uni.createFrom().item(Quote.GetQuoteResponse.newBuilder().setQuote(quote).build());
    }
}
