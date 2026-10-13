package com.patterncatalyst.shipping.routing;

import jakarta.enterprise.context.ApplicationScoped;
import jakarta.enterprise.event.Observes;

import org.jboss.logging.Logger;

import io.quarkus.runtime.StartupEvent;

@ApplicationScoped
public class StartupLogger {

    private static final Logger LOG = Logger.getLogger(StartupLogger.class);

    void onStart(@Observes StartupEvent event) {
        LOG.info("ch15-concurrency-quarkus: shipping.routing.v1.RoutingService listening "
                + "(FindOptimalRoute offloads ~400ms of blocking I/O to the worker pool by "
                + "default; see README.md for the starving/virtual-thread request flag)");
    }
}
