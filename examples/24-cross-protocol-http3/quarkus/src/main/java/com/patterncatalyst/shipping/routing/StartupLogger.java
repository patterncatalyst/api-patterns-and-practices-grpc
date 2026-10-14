package com.patterncatalyst.shipping.routing;

import jakarta.enterprise.context.ApplicationScoped;
import jakarta.enterprise.event.Observes;

import org.jboss.logging.Logger;

import io.quarkus.runtime.StartupEvent;

@ApplicationScoped
public class StartupLogger {

    private static final Logger LOG = Logger.getLogger(StartupLogger.class);

    void onStart(@Observes StartupEvent event) {
        LOG.info("ch24-routing-quarkus: shipping.routing.v1.RoutingService listening "
                + "(GetQuote only, native gRPC/HTTP2; see README.md — HTTP/3 is a separate, "
                + "unrelated transport probe against the Caddy service, not this server)");
    }
}
