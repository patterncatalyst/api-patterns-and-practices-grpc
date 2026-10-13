package com.patterncatalyst.shipping.routing;

import jakarta.enterprise.context.ApplicationScoped;
import jakarta.enterprise.event.Observes;

import org.jboss.logging.Logger;

import io.quarkus.runtime.StartupEvent;

@ApplicationScoped
public class StartupLogger {

    private static final Logger LOG = Logger.getLogger(StartupLogger.class);

    void onStart(@Observes StartupEvent event) {
        LOG.info("ch13-schema-quarkus: shipping.routing.v1.RoutingService listening "
                + "(ListRoutes pages + field-mask-projects a 5-route catalog; see README.md)");
    }
}
