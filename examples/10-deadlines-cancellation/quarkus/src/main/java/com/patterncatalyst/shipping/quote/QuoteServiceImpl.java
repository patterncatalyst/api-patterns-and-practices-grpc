package com.patterncatalyst.shipping.quote;

import java.time.Duration;

import org.jboss.logging.Logger;

import io.quarkus.grpc.GrpcService;
import io.smallrye.mutiny.Uni;
import shipping.quote.v1.Quote;
import shipping.quote.v1.QuoteService;
import shipping.type.v1.Types;

/**
 * Ch10 deadline-propagation ANCHOR — the DOWNSTREAM service RoutingService.GetQuote
 * calls over its own loopback @GrpcClient channel (see RoutingServiceImpl). Artificially
 * slow by design: every call takes ~2s before it answers, which is the whole point of
 * this chapter's example — a caller whose budget can't cover that wait has to find out
 * in well under 2s, not after paying for it.
 *
 * <p>The delay is a Mutiny timer ({@code onItem().delayIt()}), not {@code Thread.sleep}.
 * That choice matters for cancellation: a blocked thread ignores a cancelled subscriber
 * until it wakes up on its own, while a Mutiny timer's subscription is torn down the
 * moment nothing is listening for its result anymore — which is exactly what happens
 * here when RoutingServiceImpl's downstream deadline expires and grpc-java cancels this
 * call out from under it. A well-behaved server doesn't just stop CARING about doomed
 * work; it stops DOING it.
 */
@GrpcService
public class QuoteServiceImpl implements QuoteService {

    private static final Logger LOG = Logger.getLogger(QuoteServiceImpl.class);
    private static final Duration ARTIFICIAL_DELAY = Duration.ofSeconds(2);

    @Override
    public Uni<Quote.GetQuoteResponse> getQuote(Quote.GetQuoteRequest request) {
        Types.Money quote = QuoteCalculator.compute(request.getCargoList());
        LOG.infof("QuoteService.GetQuote: %s -> %s, quote=%s %s (after a %ds artificial delay)",
                request.getOrigin().getUnLocode(), request.getDestination().getUnLocode(),
                quote.getCurrency(), quote.getAmount(), ARTIFICIAL_DELAY.getSeconds());

        return Uni.createFrom().item(Quote.GetQuoteResponse.newBuilder().setQuote(quote).build())
                .onItem().delayIt().by(ARTIFICIAL_DELAY)
                .onCancellation().invoke(() -> LOG.infof(
                        "QuoteService.GetQuote: downstream deadline expired upstream — abandoning the %ds delay early",
                        ARTIFICIAL_DELAY.getSeconds()));
    }
}
