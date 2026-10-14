"""Ch20 authn-authz — JWT-validating + per-method-authorizing ServerInterceptor,
the Python-stack counterpart of quarkus/.../AuthzInterceptor.java and the
direct descendant of Chapter 12's AuthLoggingInterceptor (which checked only
that `authorization` was PRESENT, never what it contained).

Three outcomes per call, decided in this order, before
RoutingServiceServicer ever runs:

1. **Reflection is exempt.** `grpc.reflection.*` skips every check below —
   `grpcurl list`/`describe` (and this chapter's own verify.sh, which calls
   `wait_for_grpc` before it has minted any token) have to work with no
   token at all, same exemption Chapter 12 made.
2. **Authentication.** No `authorization` metadata, a header that isn't
   `Bearer <token>`, or a token `verify_token` rejects (bad signature,
   malformed, expired) all produce `UNAUTHENTICATED`. The token's CLAIMS are
   never trusted past this point — scope isn't even inspected until the
   signature and expiry both check out.
3. **Authorization.** A successfully authenticated token whose `scope`
   claim doesn't contain the scope `METHOD_SCOPES` names for this method
   gets `PERMISSION_DENIED`. For `ListRoutes` (gated on `routes:admin`,
   which the demo tokens never carry) this fires and returns
   PERMISSION_DENIED before `RoutingServiceServicer.ListRoutes` would ever
   run — the interceptor never resolves that far. This example's
   `RoutingServiceServicer` doesn't override `ListRoutes` either (so it
   would answer UNIMPLEMENTED if ever reached), but that is a separate, later fact;
   PERMISSION_DENIED is the authorization decision, made here, independent
   of what — if anything — is implemented behind it.
"""
from __future__ import annotations

import logging
import time
from collections.abc import Awaitable, Callable

import grpc

from app.auth import TokenError, required_scope, verify_token

logger = logging.getLogger("ch20-routing-python")

_AUTH_KEY = "authorization"
_BEARER_PREFIX = "Bearer "


def _is_reflection(method: str) -> bool:
    return "grpc.reflection." in method


def _bearer_token(metadata: dict[str, str]) -> str | None:
    raw = metadata.get(_AUTH_KEY)
    if not raw or not raw.startswith(_BEARER_PREFIX):
        return None
    return raw[len(_BEARER_PREFIX) :]


class AuthzInterceptor(grpc.aio.ServerInterceptor):
    async def intercept_service(
        self,
        continuation: Callable[[grpc.HandlerCallDetails], Awaitable[grpc.RpcMethodHandler]],
        handler_call_details: grpc.HandlerCallDetails,
    ) -> grpc.RpcMethodHandler:
        method = handler_call_details.method
        start = time.monotonic()
        metadata = dict(handler_call_details.invocation_metadata or ())

        # Resolving the handler only looks up what GetQuote/ListRoutes/etc.
        # WOULD run — it does not call it yet, same as Chapter 12.
        handler = await continuation(handler_call_details)
        if handler is None:
            return handler

        if _is_reflection(method):
            return handler

        token = _bearer_token(metadata)
        if token is None:
            return self._reject(
                handler, method, start, grpc.StatusCode.UNAUTHENTICATED,
                "missing 'authorization: Bearer <jwt>' metadata",
            )

        try:
            claims = verify_token(token)
        except TokenError as exc:
            return self._reject(
                handler, method, start, grpc.StatusCode.UNAUTHENTICATED, f"invalid token: {exc}",
            )

        scope_needed = required_scope(method)
        if scope_needed is not None:
            granted = set(str(claims.get("scope", "")).split())
            if scope_needed not in granted:
                return self._reject(
                    handler, method, start, grpc.StatusCode.PERMISSION_DENIED,
                    f"token lacks required scope '{scope_needed}'",
                )

        return _with_logging(handler, method, start)

    @staticmethod
    def _reject(
        handler: grpc.RpcMethodHandler,
        method: str,
        start: float,
        code: grpc.StatusCode,
        details: str,
    ) -> grpc.RpcMethodHandler:
        duration_ms = (time.monotonic() - start) * 1000
        logger.info("grpc_call method=%s status=%s duration_ms=%.1f", method, code.name, duration_ms)
        return _abort_handler(handler, code, details)


def _abort_handler(handler: grpc.RpcMethodHandler, code: grpc.StatusCode, details: str) -> grpc.RpcMethodHandler:
    async def abort_unary(request, context):
        await context.abort(code, details)

    async def abort_stream(request_or_iterator, context):
        await context.abort(code, details)
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
