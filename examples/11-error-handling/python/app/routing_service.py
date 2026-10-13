"""Ch11 error-handling ANCHOR — GetQuote returns deterministic rich errors by
input, implemented identically here and in the Quarkus stack (see
../../quarkus/src/main/java/com/patterncatalyst/shipping/routing/RoutingServiceImpl.java).

    empty/missing origin or destination un_locode -> INVALID_ARGUMENT + BadRequest
    origin.un_locode == "ZZZZZ" (unroutable)      -> NOT_FOUND + ErrorInfo
    origin.un_locode == "RETRY"                    -> UNAVAILABLE + RetryInfo
    otherwise                                       -> OK, same formula as Ch5

The canonical status code carries the category (retry or don't); the
google.rpc.Status details carry the machine-readable specifics. BadRequest,
ErrorInfo, and RetryInfo come from grpcio-status's google.rpc.error_details_pb2
— a runtime library, not generated from this chapter's .proto.

The other four RoutingService methods are declared in the proto for later
chapters. They are intentionally left unoverridden: the generated
`routing_pb2_grpc.RoutingServiceServicer` base class already sets gRPC status
UNIMPLEMENTED and raises for any method a subclass doesn't override.
"""
from __future__ import annotations

import logging

import grpc
from google.protobuf import any_pb2, duration_pb2
from google.rpc import code_pb2, error_details_pb2, status_pb2
from grpc_status import rpc_status

from shipping.routing.v1 import routing_pb2, routing_pb2_grpc
from shipping.type.v1 import types_pb2

from app.quote import compute_quote

logger = logging.getLogger("ch11-errors-python")

_CARRIER = "MAERSK"
_ERROR_DOMAIN = "shipping.routing.v1"
_UNROUTABLE_ORIGIN = "ZZZZZ"
_RETRY_ORIGIN = "RETRY"


def _pack(message) -> any_pb2.Any:
    packed = any_pb2.Any()
    packed.Pack(message)
    return packed


class RoutingServiceServicer(routing_pb2_grpc.RoutingServiceServicer):
    async def GetQuote(
        self,
        request: routing_pb2.GetQuoteRequest,
        context: grpc.aio.ServicerContext,
    ) -> routing_pb2.GetQuoteResponse:
        origin = request.origin
        destination = request.destination

        violations = []
        if not origin.un_locode.strip():
            violations.append(
                error_details_pb2.BadRequest.FieldViolation(
                    field="origin.un_locode", description="origin.un_locode is required"
                )
            )
        if not destination.un_locode.strip():
            violations.append(
                error_details_pb2.BadRequest.FieldViolation(
                    field="destination.un_locode", description="destination.un_locode is required"
                )
            )
        if violations:
            fields = ", ".join(v.field for v in violations)
            await self._abort_rich(
                context,
                code_pb2.INVALID_ARGUMENT,
                f"invalid GetQuoteRequest: {fields} required (see BadRequest details)",
                _pack(error_details_pb2.BadRequest(field_violations=violations)),
            )

        if origin.un_locode == _UNROUTABLE_ORIGIN:
            await self._abort_rich(
                context,
                code_pb2.NOT_FOUND,
                f"origin {_UNROUTABLE_ORIGIN} is unroutable (ErrorInfo reason=ORIGIN_UNROUTABLE)",
                _pack(error_details_pb2.ErrorInfo(reason="ORIGIN_UNROUTABLE", domain=_ERROR_DOMAIN)),
            )

        if origin.un_locode == _RETRY_ORIGIN:
            await self._abort_rich(
                context,
                code_pb2.UNAVAILABLE,
                "routing service temporarily unavailable, retry per RetryInfo",
                _pack(error_details_pb2.RetryInfo(retry_delay=duration_pb2.Duration(seconds=2))),
            )

        quote = compute_quote(request.cargo)
        leg = types_pb2.Leg(carrier=_CARRIER, origin=origin, destination=destination)
        route = types_pb2.Route(
            id=f"rte_{origin.un_locode}-{destination.un_locode}",
            legs=[leg],
            price=quote,
        )

        logger.info(
            "GetQuote: %s -> %s, quote=%s %s",
            origin.un_locode,
            destination.un_locode,
            quote.currency,
            quote.amount,
        )

        return routing_pb2.GetQuoteResponse(quote=quote, route=route)

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
