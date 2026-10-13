"""Ch12 interceptors ANCHOR — one class, two cross-cutting concerns, the
Python-stack counterpart of quarkus/.../AuthLoggingInterceptor.java.

`grpc.aio.ServerInterceptor.intercept_service` is handed a `continuation`
(resolves the method the client actually asked for into a registered
`grpc.RpcMethodHandler`, without running it) and the call's
`HandlerCallDetails` — which carries `invocation_metadata`, the Python name
for the header map Quarkus calls `Metadata`. Two things happen on every call,
in this order:

1. **Auth hook.** `authorization` absent from `invocation_metadata` means the
   call is rejected with `UNAUTHENTICATED` by substituting a handler that
   immediately aborts, in place of whatever `continuation` resolved — the
   real handler (`GetQuote`, or one of the four UNIMPLEMENTED stubs) never
   runs. This chapter checks only for presence; validating a token's
   contents is Chapter 20's job. **Exempted:** the server reflection service
   (`grpc.reflection.*`) — a `grpc.aio` interceptor list is already global to
   the whole server, reflection included, and a client (grpcurl, this
   example's own verify.sh) needs to list/describe the service before it has
   any token to send. Production auth interceptors make the identical
   exception for reflection and health checks.
2. **Logging + timing.** The resolved handler's behavior function is always
   wrapped so that whatever status the call ends with — `OK` for `GetQuote`,
   `UNIMPLEMENTED` for the other four, `UNAUTHENTICATED` for a rejected one —
   gets one structured log line with the method name and the elapsed time.

Both helpers below build a replacement `RpcMethodHandler` that matches the
ORIGINAL handler's cardinality (unary/streaming on each side) rather than
assuming unary-unary, because `RoutingService` itself isn't all-unary —
`NegotiateRoute` is bidirectional-streaming — and the auth hook has to work
in front of every shape the service declares, not just the one this
chapter's `verify.sh` happens to call.
"""
from __future__ import annotations

import logging
import time
from collections.abc import Awaitable, Callable

import grpc

logger = logging.getLogger("ch12-routing-python")

_AUTH_KEY = "authorization"


def _is_reflection(method: str) -> bool:
    return "grpc.reflection." in method


class AuthLoggingInterceptor(grpc.aio.ServerInterceptor):
    async def intercept_service(
        self,
        continuation: Callable[[grpc.HandlerCallDetails], Awaitable[grpc.RpcMethodHandler]],
        handler_call_details: grpc.HandlerCallDetails,
    ) -> grpc.RpcMethodHandler:
        method = handler_call_details.method
        start = time.monotonic()
        metadata = dict(handler_call_details.invocation_metadata or ())

        # Resolving the handler only looks up what GetQuote/FindOptimalRoute/
        # etc. WOULD run — it does not call it. The handler's own body still
        # hasn't executed by the time either branch below returns.
        handler = await continuation(handler_call_details)
        if handler is None:
            return handler

        if not _is_reflection(method) and _AUTH_KEY not in metadata:
            duration_ms = (time.monotonic() - start) * 1000
            logger.info(
                "grpc_call method=%s status=UNAUTHENTICATED duration_ms=%.1f",
                method,
                duration_ms,
            )
            return _reject_unauthenticated(handler)

        return _with_logging(handler, method, start)


def _reject_unauthenticated(handler: grpc.RpcMethodHandler) -> grpc.RpcMethodHandler:
    details = "missing 'authorization' metadata"

    async def abort_unary(request, context):
        await context.abort(grpc.StatusCode.UNAUTHENTICATED, details)

    async def abort_stream(request_or_iterator, context):
        await context.abort(grpc.StatusCode.UNAUTHENTICATED, details)
        return
        yield  # pragma: no cover - unreachable; abort() always raises first.

    if handler.response_streaming:
        behavior = abort_stream
        ctor = (
            grpc.stream_stream_rpc_method_handler
            if handler.request_streaming
            else grpc.unary_stream_rpc_method_handler
        )
    else:
        behavior = abort_unary
        ctor = (
            grpc.stream_unary_rpc_method_handler
            if handler.request_streaming
            else grpc.unary_unary_rpc_method_handler
        )

    return ctor(
        behavior,
        request_deserializer=handler.request_deserializer,
        response_serializer=handler.response_serializer,
    )


def _with_logging(handler: grpc.RpcMethodHandler, method: str, start: float) -> grpc.RpcMethodHandler:
    def log_outcome(context: grpc.aio.ServicerContext) -> None:
        # context.code() is set explicitly by context.abort() and by the
        # generated UNIMPLEMENTED stubs before they raise; it's still None
        # for a handler that simply returned, which is exactly the OK case.
        code = context.code() or grpc.StatusCode.OK
        duration_ms = (time.monotonic() - start) * 1000
        logger.info("grpc_call method=%s status=%s duration_ms=%.1f", method, code.name, duration_ms)

    if handler.response_streaming:
        inner = handler.stream_stream if handler.request_streaming else handler.unary_stream

        async def wrapped(request_or_iterator, context):
            try:
                async for response in inner(request_or_iterator, context):
                    yield response
            finally:
                log_outcome(context)

        ctor = (
            grpc.stream_stream_rpc_method_handler
            if handler.request_streaming
            else grpc.unary_stream_rpc_method_handler
        )
    else:
        inner = handler.stream_unary if handler.request_streaming else handler.unary_unary

        async def wrapped(request_or_iterator, context):
            try:
                return await inner(request_or_iterator, context)
            finally:
                log_outcome(context)

        ctor = (
            grpc.stream_unary_rpc_method_handler
            if handler.request_streaming
            else grpc.unary_unary_rpc_method_handler
        )

    return ctor(
        wrapped,
        request_deserializer=handler.request_deserializer,
        response_serializer=handler.response_serializer,
    )
