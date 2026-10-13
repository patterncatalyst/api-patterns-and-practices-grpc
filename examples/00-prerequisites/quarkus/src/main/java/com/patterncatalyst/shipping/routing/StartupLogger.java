package com.patterncatalyst.shipping.routing;

import jakarta.enterprise.context.ApplicationScoped;
import jakarta.enterprise.event.Observes;

import org.jboss.logging.Logger;

import io.quarkus.runtime.StartupEvent;

@ApplicationScoped
public class StartupLogger {

    private static final Logger LOG = Logger.getLogger(StartupLogger.class);

    void onStart(@Observes StartupEvent event) {
        LOG.info("ch00-prereq-quarkus: shipping.routing.v1.RoutingService listening "
                + "(GetQuote returns a canned response; see Chapter 5 for the real formula)");
    }
}
