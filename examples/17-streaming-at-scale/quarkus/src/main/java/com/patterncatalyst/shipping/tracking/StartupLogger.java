package com.patterncatalyst.shipping.tracking;

import jakarta.enterprise.context.ApplicationScoped;
import jakarta.enterprise.event.Observes;

import org.jboss.logging.Logger;

import io.quarkus.runtime.StartupEvent;

@ApplicationScoped
public class StartupLogger {

    private static final Logger LOG = Logger.getLogger(StartupLogger.class);

    void onStart(@Observes StartupEvent event) {
        LOG.info("ch17-streaming-quarkus: shipping.tracking.v1.TrackingService listening "
                + "(WatchShipment is a demand-driven Multi; see README.md for the bkg_demo / "
                + "bkg_eager / bkg_quiet modes)");
    }
}
