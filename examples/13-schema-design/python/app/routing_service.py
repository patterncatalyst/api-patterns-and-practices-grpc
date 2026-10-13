"""Ch13 schema-design ANCHOR — ListRoutes pages through app.catalog.ALL and
projects each returned Route through the request's FieldMask, implemented
identically here and in the Quarkus stack (see
../../quarkus/src/main/java/com/patterncatalyst/shipping/routing/RoutingServiceImpl.java).

    page_size <= 0                -> DEFAULT_PAGE_SIZE (3)
    page_size > MAX_PAGE_SIZE (5) -> clamped to MAX_PAGE_SIZE
    page_token == ""              -> start at index 0
    page_token == "<n>"           -> start at index n (opaque to the client,
                                      but just the next offset in this demo)
    field_mask.paths empty        -> full Route, unmasked
    field_mask.paths non-empty    -> only the named top-level fields set

The other four RoutingService methods are declared in the proto for later
chapters. They are left unoverridden here: the generated
`routing_pb2_grpc.RoutingServiceServicer` base class already sets gRPC status
UNIMPLEMENTED and raises for any method a subclass doesn't override.
"""
from __future__ import annotations

import logging

import grpc
from google.protobuf import any_pb2, field_mask_pb2
from google.rpc import code_pb2, error_details_pb2, status_pb2
from grpc_status import rpc_status

from shipping.routing.v1 import routing_pb2, routing_pb2_grpc
from shipping.type.v1 import types_pb2

from app.catalog import ALL as CATALOG

logger = logging.getLogger("ch13-schema-python")

DEFAULT_PAGE_SIZE = 3
MAX_PAGE_SIZE = 5


def _pack(message) -> any_pb2.Any:
    packed = any_pb2.Any()
    packed.Pack(message)
    return packed


def _apply_field_mask(route: types_pb2.Route, mask: field_mask_pb2.FieldMask) -> types_pb2.Route:
    """Returns `route` unchanged when the caller sent no mask (an unset
    FieldMask means "I want everything" — the only reading that keeps
    ListRoutes backward compatible with a client built before this field
    existed). Otherwise builds a FRESH, empty Route and merges only the named
    top-level paths into it, so any field not named in the mask stays at its
    zero value and is therefore absent from the wire (proto3 omits
    unset/default scalar and message fields). Raises ValueError for a path
    Route does not have, rather than silently ignoring it."""
    if not mask.paths:
        return route
    if not mask.IsValidForDescriptor(types_pb2.Route.DESCRIPTOR):
        raise ValueError(f"field_mask names a path Route does not have: {list(mask.paths)}")
    projected = types_pb2.Route()
    mask.MergeMessage(route, projected)
    return projected


class RoutingServiceServicer(routing_pb2_grpc.RoutingServiceServicer):
    async def ListRoutes(
        self,
        request: routing_pb2.ListRoutesRequest,
        context: grpc.aio.ServicerContext,
    ) -> routing_pb2.ListRoutesResponse:
        page_size = request.page_size
        if page_size <= 0:
            page_size = DEFAULT_PAGE_SIZE
        elif page_size > MAX_PAGE_SIZE:
            page_size = MAX_PAGE_SIZE

        token = request.page_token
        if not token:
            start = 0
        else:
            try:
                start = int(token)
            except ValueError:
                await self._abort_invalid_page_token(context, token)
            if start < 0 or start > len(CATALOG):
                await self._abort_invalid_page_token(context, token)

        end = min(start + page_size, len(CATALOG))
        page = CATALOG[start:end]

        try:
            projected = [_apply_field_mask(route, request.field_mask) for route in page]
        except ValueError as exc:
            await self._abort_invalid_field_mask(context, str(exc))

        next_page_token = str(end) if end < len(CATALOG) else ""

        logger.info(
            "ListRoutes: page_size=%d page_token='%s' -> %d route(s), next_page_token='%s', mask=%s",
            page_size,
            token,
            len(projected),
            next_page_token,
            list(request.field_mask.paths),
        )

        return routing_pb2.ListRoutesResponse(routes=projected, next_page_token=next_page_token)

    @staticmethod
    async def _abort_invalid_page_token(context: grpc.aio.ServicerContext, token: str) -> None:
        await RoutingServiceServicer._abort_rich(
            context,
            code_pb2.INVALID_ARGUMENT,
            f"invalid ListRoutesRequest: page_token '{token}' is not a valid continuation token",
            _pack(
                error_details_pb2.BadRequest(
                    field_violations=[
                        error_details_pb2.BadRequest.FieldViolation(
                            field="page_token",
                            description='must be "" or a token returned by a previous ListRoutes call',
                        )
                    ]
                )
            ),
        )

    @staticmethod
    async def _abort_invalid_field_mask(context: grpc.aio.ServicerContext, description: str) -> None:
        await RoutingServiceServicer._abort_rich(
            context,
            code_pb2.INVALID_ARGUMENT,
            f"invalid ListRoutesRequest: {description}",
            _pack(
                error_details_pb2.BadRequest(
                    field_violations=[
                        error_details_pb2.BadRequest.FieldViolation(
                            field="field_mask", description=description
                        )
                    ]
                )
            ),
        )

    @staticmethod
    async def _abort_rich(
        context: grpc.aio.ServicerContext,
        code: int,
        message: str,
        detail: any_pb2.Any,
    ) -> None:
        """Builds a google.rpc.Status (canonical code + one rich detail) and hands it to
        context.abort_with_status so it lands in the gRPC trailers — the same place
        grpcurl, or any client library, looks for it. Raises grpc.aio.AbortError;
        callers do not need to return afterwards."""
        rich_status = status_pb2.Status(code=code, message=message, details=[detail])
        await context.abort_with_status(rpc_status.to_status(rich_status))
