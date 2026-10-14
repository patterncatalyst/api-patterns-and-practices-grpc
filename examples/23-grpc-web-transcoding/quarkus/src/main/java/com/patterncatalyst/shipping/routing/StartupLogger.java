package com.patterncatalyst.shipping.routing;

import jakarta.enterprise.context.ApplicationScoped;
import jakarta.enterprise.event.Observes;

import org.jboss.logging.Logger;

import io.quarkus.runtime.StartupEvent;

@ApplicationScoped
public class StartupLogger {

    private static final Logger LOG = Logger.getLogger(StartupLogger.class);

    void onStart(@Observes StartupEvent event) {
        LOG.info("ch23-grpc-web-quarkus: shipping.routing.v1.RoutingService and "
                + "shipping.quote.v1.QuoteService listening on :9000 (native gRPC, reflection on); "
                + "POST /booking/quote listening on :8080 (REST shim); "
                + "see ../envoy/ for the grpc_json_transcoder + grpc_web front door on :10000 (see README.md)");
    }
}
