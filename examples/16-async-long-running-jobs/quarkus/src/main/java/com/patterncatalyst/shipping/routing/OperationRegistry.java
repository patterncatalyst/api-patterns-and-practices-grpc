package com.patterncatalyst.shipping.routing;

import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

import jakarta.enterprise.context.ApplicationScoped;

/**
 * The server-owned table of in-flight and completed {@link OperationState}
 * records, keyed by an {@code op_}-prefixed id. {@code @ApplicationScoped}
 * makes this a single CDI-managed instance shared by BOTH {@code
 * @GrpcService} beans — {@link RoutingServiceImpl} (which creates a record
 * on {@code RecomputeRoutes}) and {@link OperationsServiceImpl} (which
 * polls, watches, and cancels it) — so the two services agree on one shared
 * piece of state without either one owning the other. An in-memory map is
 * enough for this example — a production service would back this with a
 * durable store so an operation survives a server restart, but the
 * client-visible contract (create, poll, watch, cancel by id) is identical
 * either way.
 */
@ApplicationScoped
class OperationRegistry {

    private final Map<String, OperationState> operations = new ConcurrentHashMap<>();

    OperationState create(String kind) {
        String id = "op_" + UUID.randomUUID().toString().replace("-", "");
        OperationState state = new OperationState(id, kind);
        operations.put(id, state);
        return state;
    }

    OperationState get(String id) {
        return operations.get(id);
    }
}
