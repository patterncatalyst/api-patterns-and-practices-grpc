---
title: "Domain Glossary — Shipping & Cargo"
layout: plan
render_with_liquid: false
---

# Domain Glossary — Shipping & Cargo

One canonical domain for the whole site, continuous with the sibling REST site.
Every chapter, example, `.proto` and diagram uses these nouns. On the REST site
they are modeled as resources; here they are modeled as **Protobuf messages** and
exercised through **RPC methods**. gRPC is the internal, latency-sensitive
**routing and tracking** service the REST booking service calls — so the two sites
tell one story across the REST→gRPC seam.

## Canonical nouns

| Term | Meaning | Proto message / service |
|---|---|---|
| **Booking** | A customer's request to ship cargo from an origin to a destination. The aggregate root (owned by the REST booking service). | `shipping.type.v1.Booking` |
| **Cargo** | The goods carried under a booking: description, type, weight, volume, hazardous flag. | `shipping.type.v1.Cargo` |
| **Location** | A port or terminal, identified by UN/LOCODE. | `shipping.type.v1.Location` |
| **Route** | The planned sequence of legs that moves a booking's cargo origin → destination. | `shipping.type.v1.Route` · `RoutingService` |
| **Leg** | One hop of a route (one carrier, one departure → arrival). | `shipping.type.v1.Leg` |
| **Quote / Money** | The money amount to carry a booking's cargo. | `shipping.type.v1.Money` · `QuoteService` |
| **TrackingEvent** | A real-time position/state update for a shipment. | `shipping.tracking.v1.TrackingEvent` · `TrackingService` |
| **Operation** | A server-owned record of long-running work (reroute, reconcile), returned by async methods and polled/streamed for status. | `shipping.type.v1.Operation` |

## Booking lifecycle (the finite-state machine)

```
PENDING ──confirm──▶ CONFIRMED ──load──▶ IN_TRANSIT ──deliver──▶ DELIVERED
   │                     │
   └──────cancel─────────┴──────────────▶ CANCELLED
```

Modeled as `shipping.type.v1.BookingState` (`BOOKING_STATE_PENDING`, …). The REST
site exposes the transitions as HATEOAS links; here, `TrackingService.WatchShipment`
streams state changes as `TrackingEvent`s.

## The services

| Service | Role | RPC shapes |
|---|---|---|
| **RoutingService** | The routing hot-path the booking service calls. | `GetQuote` (unary, anchor), `FindOptimalRoute` (unary), `ListRoutes` (unary, paginated), `NegotiateRoute` (bidi), `RecomputeRoutes` (async → `Operation`) |
| **TrackingService** | Real-time shipment tracking. | `WatchShipment` (server-stream), `ReportPositions` (client-stream), `Sync` (bidi) |
| **QuoteService** | Downstream pricing called by routing; the deadline-propagation + rich-error target. | `GetQuote` (unary) |

## Identifiers & formats

- **Booking id** — `bkg_` prefix, ULID-shaped. **Cargo id** — `crg_`. **Route id** — `rte_`. **Operation id** — `op_`.
- **Location** — UN/LOCODE (e.g. `USNYC`, `NLRTM`, `SGSIN`).
- **Money** — `{ currency: "USD", amount: "1250.00" }`; amount is a decimal **string** to avoid float drift (matches the REST contract).
- **Timestamps** — `google.protobuf.Timestamp` (UTC).
- **Weight** — kilograms; **Volume** — cubic metres.

## Contract vocabulary

These names are fixed across `contracts/proto/shipping/`. A type is defined **once**
in `type/v1/types.proto` and imported everywhere else — see `contracts/README.md`.
The REST site's shared JSON Schema components and this site's shared proto messages
describe the same domain.
