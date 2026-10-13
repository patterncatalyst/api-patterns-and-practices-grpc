package com.patterncatalyst.shipping.routing;

import jakarta.enterprise.context.ApplicationScoped;
import jakarta.enterprise.event.Observes;

import org.jboss.logging.Logger;

import io.quarkus.runtime.StartupEvent;

@ApplicationScoped
public class StartupLogger {

    private static final Logger LOG = Logger.getLogger(StartupLogger.class);

    void onStart(@Observes StartupEvent event) {
        LOG.info("ch16-operation-quarkus: shipping.routing.v1.RoutingService (RecomputeRoutes) and "
                + "shipping.routing.v1.OperationsService (GetOperation/WatchOperation/CancelOperation) "
                + "listening; see README.md");
    }
}
