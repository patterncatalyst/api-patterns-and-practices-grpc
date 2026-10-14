package com.patterncatalyst.shipping.routing;

import jakarta.enterprise.context.ApplicationScoped;
import jakarta.enterprise.event.Observes;

import org.jboss.logging.Logger;

import io.quarkus.runtime.StartupEvent;

@ApplicationScoped
public class StartupLogger {

    private static final Logger LOG = Logger.getLogger(StartupLogger.class);

    void onStart(@Observes StartupEvent event) {
        LOG.info("ch18-routing-quarkus: shipping.routing.v1.RoutingService listening "
                + "(GetQuote + ListRoutes implemented; max-inbound-message-size, netty "
                + "keepalive, and gzip compression tuned — see README.md)");
    }
}
