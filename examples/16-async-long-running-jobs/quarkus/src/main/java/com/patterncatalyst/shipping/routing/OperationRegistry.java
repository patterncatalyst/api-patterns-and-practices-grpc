package com.patterncatalyst.shipping.routing;

import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

import jakarta.enterprise.context.ApplicationScoped;

/**
 * The server-owned table of in-flight and completed {@link OperationState}
 * records, keyed by an {@code op_}-prefixed id. An in-memory map is enough
 * for this example — a production {@code RoutingService} would back this
 * with a durable store so an operation survives a server restart, but the
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
