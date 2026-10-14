"""Ch21 observability ANCHOR — a hand-rolled gRPC server metrics interceptor,
the Python stack's counterpart of the `grpc_server_*` metrics
`quarkus-micrometer-registry-prometheus` publishes automatically the moment
`quarkus-grpc` is also on the classpath (see ../quarkus/pom.xml). `grpcio`
ships no Prometheus binder of its own, so this chapter writes the same shape
by hand, following the identical resolve-then-wrap interceptor structure
Chapter 12's `AuthLoggingInterceptor` and Chapter 20's `AuthzInterceptor`
already established: `continuation(handler_call_details)` resolves the real
handler without invoking it, and this interceptor wraps its behavior function
rather than replacing it.

Only `unary_unary` handlers are timed — the only shape either RoutingService's
`GetQuote` or QuoteService's `GetQuote` actually use in this chapter. A
production interceptor protecting streaming RPCs too would wrap all four
shapes the way Chapter 20's `_with_logging` does; this chapter keeps the
metrics path narrow; every registered unary RPC still passes
through untouched (count stays 0, never an error) if a handler were ever
added that reached this branch.

Metric names and label names (`grpc_server_handled_total`,
`grpc_server_handling_seconds`, labels `grpc_service`/`grpc_method`/
`grpc_code`) follow the same naming the community's grpc-ecosystem Prometheus
interceptors use, so a reader who already knows `grpc_server_handled_total`
from Go or Java gRPC services recognizes it here unchanged.
"""
from __future__ import annotations

import time
from collections.abc import Awaitable, Callable

import grpc
from prometheus_client import Counter, Histogram

GRPC_SERVER_HANDLED_TOTAL = Counter(
    "grpc_server_handled_total",
    "Total number of gRPC calls completed on the server, regardless of success or failure.",
    ["grpc_service", "grpc_method", "grpc_code"],
)
GRPC_SERVER_HANDLING_SECONDS = Histogram(
    "grpc_server_handling_seconds",
    "Histogram of response latency (seconds) of gRPC calls handled on the server.",
    ["grpc_service", "grpc_method"],
)


def _split_method(method: str) -> tuple[str, str]:
    """"/shipping.routing.v1.RoutingService/GetQuote" -> ("shipping.routing.v1.RoutingService", "GetQuote")."""
    parts = method.strip("/").split("/", 1)
    if len(parts) != 2:
        return ("unknown", method)
    return (parts[0], parts[1])


class MetricsInterceptor(grpc.aio.ServerInterceptor):
    async def intercept_service(
        self,
        continuation: Callable[[grpc.HandlerCallDetails], Awaitable[grpc.RpcMethodHandler]],
        handler_call_details: grpc.HandlerCallDetails,
    ) -> grpc.RpcMethodHandler:
        handler = await continuation(handler_call_details)
        if handler is None or handler.request_streaming or handler.response_streaming:
            return handler

        service, rpc_method = _split_method(handler_call_details.method)
        inner = handler.unary_unary

        async def wrapped(request, context):
            start = time.monotonic()
            try:
                response = await inner(request, context)
                code = context.code() or grpc.StatusCode.OK
                return response
            except Exception:
                code = context.code() or grpc.StatusCode.UNKNOWN
                raise
            finally:
                GRPC_SERVER_HANDLED_TOTAL.labels(service, rpc_method, code.name).inc()
                GRPC_SERVER_HANDLING_SECONDS.labels(service, rpc_method).observe(time.monotonic() - start)

        return grpc.unary_unary_rpc_method_handler(
            wrapped,
            request_deserializer=handler.request_deserializer,
            response_serializer=handler.response_serializer,
        )
