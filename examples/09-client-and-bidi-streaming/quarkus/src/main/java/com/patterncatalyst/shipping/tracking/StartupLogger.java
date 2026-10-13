package com.patterncatalyst.shipping.tracking;

import jakarta.enterprise.context.ApplicationScoped;
import jakarta.enterprise.event.Observes;

import org.jboss.logging.Logger;

import io.quarkus.runtime.StartupEvent;

@ApplicationScoped
public class StartupLogger {

    private static final Logger LOG = Logger.getLogger(StartupLogger.class);

    void onStart(@Observes StartupEvent event) {
        LOG.info("ch09-tracking-quarkus: shipping.tracking.v1.TrackingService listening "
                + "(ReportPositions + Sync implemented; see README.md)");
    }
}
