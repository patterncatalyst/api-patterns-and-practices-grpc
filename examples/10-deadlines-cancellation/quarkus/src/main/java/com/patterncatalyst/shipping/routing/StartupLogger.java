package com.patterncatalyst.shipping.routing;

import jakarta.enterprise.context.ApplicationScoped;
import jakarta.enterprise.event.Observes;

import org.jboss.logging.Logger;

import io.quarkus.runtime.StartupEvent;

@ApplicationScoped
public class StartupLogger {

    private static final Logger LOG = Logger.getLogger(StartupLogger.class);

    void onStart(@Observes StartupEvent event) {
        LOG.info("ch10-deadlines-quarkus: shipping.routing.v1.RoutingService and "
                + "shipping.quote.v1.QuoteService both listening on :9000 "
                + "(RoutingService.GetQuote calls QuoteService.GetQuote over a loopback "
                + "@GrpcClient channel; see README.md)");
    }
}
