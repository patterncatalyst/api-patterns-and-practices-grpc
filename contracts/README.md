# Contracts — the Protobuf single source of truth

Every service in this site is generated from the `.proto` files under `proto/`.
They are the contract; the Quarkus and Python implementations both generate their
stubs from them, and CI gates every change with [Buf](https://buf.build).

```
proto/shipping/
  type/v1/types.proto        shared domain messages (Money, Location, Cargo,
                             Booking, Leg, Route, Operation, BookingState) —
                             defined ONCE, imported everywhere
  routing/v1/routing.proto   RoutingService — GetQuote (unary anchor),
                             FindOptimalRoute, ListRoutes, NegotiateRoute (bidi),
                             RecomputeRoutes (async)
  tracking/v1/tracking.proto TrackingService — WatchShipment (server-stream),
                             ReportPositions (client-stream), Sync (bidi)
  quote/v1/quote.proto       QuoteService — GetQuote (downstream of routing)
```

## The gates (run in CI, runnable locally)

```bash
cd contracts
buf lint                                   # STANDARD rule set
buf build -o /dev/null                     # compiles; all imports resolve
buf breaking --against '.git#branch=main,subdir=contracts'   # no breaking change vs main
```

`buf breaking` is the evolution gate — the direct analog of the REST site's
response-schema-drift gate. A reused field number, a changed type, or a removed
field fails the build (Ch14).

## Generating stubs

Authoritative generation happens inside each stack's build (Quarkus via the
`quarkus-maven-plugin`; Python via `grpcio-tools`). For a quick local look at the
Python stubs:

```bash
cd contracts && buf generate      # writes to examples/_generated/python (git-ignored)
```

## Conventions

- **Versioned packages** (`shipping.routing.v1`). A breaking change becomes `v2`.
- **Money is a decimal string**, never a float — matches the REST contract.
- **Enum zero value** is always `*_UNSPECIFIED`; values are prefixed with the enum name.
- **One request/response type per RPC**, named `<Method>Request` / `<Method>Response`.
- Shared messages live in `type/v1` and are imported, never duplicated.
