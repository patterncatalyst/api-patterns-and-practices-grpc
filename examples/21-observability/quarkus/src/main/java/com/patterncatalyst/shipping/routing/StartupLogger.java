package com.patterncatalyst.shipping.routing;

import jakarta.enterprise.context.ApplicationScoped;
import jakarta.enterprise.event.Observes;

import org.jboss.logging.Logger;

import io.quarkus.runtime.StartupEvent;

@ApplicationScoped
public class StartupLogger {

    private static final Logger LOG = Logger.getLogger(StartupLogger.class);

    void onStart(@Observes StartupEvent event) {
        LOG.info("ch21-observability-quarkus: shipping.routing.v1.RoutingService, "
                + "shipping.quote.v1.QuoteService, and grpc.health.v1.Health all listening on :9000; "
                + "POST /booking/quote and GET /q/metrics listening on :8080 (see README.md)");
    }
}
