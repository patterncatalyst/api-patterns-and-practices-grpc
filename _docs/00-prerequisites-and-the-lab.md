---
title: "Prerequisites & the lab"
order: 0
part: "Prerequisites & the Lab"
description: "Toolchain pins, the Docker Compose lab with opt-in LGTM tracing, and the shipping and cargo domain the gRPC services share with the REST booking service."
duration: "25 min"
---

## Learning objectives

By the end of this chapter you can:

- Bring up the lab with `docker compose up --build` and opt into the Grafana LGTM observability profile with `--profile observability`.
- Call a gRPC server that has no local `.proto` file, using `grpcurl -plaintext <host>:<port> list` and server reflection.
- Explain why `contracts/proto/` is the single source of truth and how each example's Containerfile copies and compiles it at build time, never committing generated stubs.
- Name the shipping domain's core nouns (`Booking`, `Cargo`, `Location`, `Route`, `Leg`, `Money`) and why `Location` and `Money` are reused by value instead of by reference.
- Run `verify.sh` and read what its pass or fail means for a Compose stack.

## Why this matters

Every hands-on chapter gives you a running gRPC service in two languages, generated from one Protobuf contract. Here that becomes true on your machine: the pinned toolchain, a Compose stack that boots both stacks side by side, a way to call a server that `curl` can't talk to, and the shipping vocabulary every later proto, service name and diagram uses. Nothing here touches message or service design. It proves the plumbing, so the plumbing is never what you're debugging once protocol design begins.

## Toolchain pins

Every example builds its Quarkus and Python images inside containers on Red Hat UBI 10 base images, so the host needs no JDK or Python interpreter to run `docker compose up`.

| Piece | Pin | Notes |
|---|---|---|
| Quarkus | `quarkus-grpc` on UBI 10 `openjdk-25` | Java 25, the current LTS |
| Python | `grpcio` and `grpcio-tools` on UBI 10 `python-314-minimal` | Python 3.14, managed by [uv](https://docs.astral.sh/uv/) |
| Base images | exact tags, never floating majors | re-checked with `skopeo list-tags`, bumped as a reviewed change |

Pinning current stable rather than an older floor keeps the examples close to what a fresh `sdk install` or `uv python install` gives you.

Contract-first work needs tools beyond a runtime:

- [buf](https://buf.build) lints every `.proto`, compiles the import graph and checks each change against the previous commit for a breaking field, tag or type change.
- [grpcurl](https://github.com/fullstorydev/grpcurl) is the `curl` equivalent: a command-line client that talks HTTP/2 like any other gRPC client.
- [grpcui](https://github.com/fullstorydev/grpcui) offers the same calls through a local web form, useful for exploring an unfamiliar service.
- [ghz](https://ghz.sh) is a gRPC load-testing tool, used for streaming at scale and performance tuning later.
- A container engine with Compose v2 is the one tool every chapter assumes, because every example builds and runs in containers.

The observability stack is `grafana/otel-lgtm`, an all-in-one image bundling Loki (logs), Grafana (dashboards), Tempo (traces) and Mimir (metrics) behind one OpenTelemetry Collector. Both stacks export OTLP, but the collector is opt-in.

## The lab

The `compose.yaml` starts two services by default: `quarkus` on host port 9000 and `python` on host port 9001, both mapped from container port 9000. Both are generated from the same `.proto` files in `contracts/proto/` and both implement `RoutingService.GetQuote`. Neither computes anything yet, but both answer on the wire identically. That property, two independent implementations of one contract with one assertable result, is what every later `verify.sh` depends on.

A third service, `lgtm`, sits behind a Compose `profiles: ["observability"]` entry, so a plain `docker compose up` never starts it:

```bash
docker compose up --build                            # app stack only: quarkus, python
docker compose --profile observability up --build     # + Grafana LGTM on :3000
```

Both applications export OTLP unconditionally, since the endpoint is only an environment variable, and neither needs a collector listening. An OTLP exporter with no live endpoint fails asynchronously in the background and never blocks a call or startup. Booting four extra containers on every first run would slow the loop for no signal, so tracing stays one flag away.

{% include excalidraw.html file="00-lab-topology" alt="The Compose lab topology: a grpcurl or grpcui client calling GetQuote through server reflection against a Quarkus container on host port 9000 and a Python container on host port 9001, both generated from the same proto contract in contracts/proto/, with an optional LGTM observability stack reachable only when the observability profile is active." caption="Figure 0.1: The lab: one proto, two servers, reflection instead of a local stub, OTel off by default." %}

## Calling a server you can't curl

A gRPC call is an HTTP/2 request with a binary Protobuf body and a method name in the `:path` pseudo-header, so `curl` can't build it. `grpcurl` closes the gap without a local copy of the `.proto`, provided the server has **reflection** on. Reflection is a gRPC service, `grpc.reflection.v1alpha.ServerReflection`, exposed alongside the real services. A client asks it which services exist and what a message looks like at runtime.

Quarkus enables it with `quarkus.grpc.server.enable-reflection-service=true` (on in dev mode, explicit elsewhere). Python uses the `grpcio-reflection` package, registered at server startup. Both stacks have it on, so the same two commands work against either:

```bash
grpcurl -plaintext localhost:9000 list
# grpc.reflection.v1alpha.ServerReflection
# shipping.routing.v1.RoutingService

grpcurl -plaintext -d '{}' localhost:9000 shipping.routing.v1.RoutingService/GetQuote
```

`-plaintext` skips TLS, which every example uses until certificates arrive. Every later hands-on instruction follows the same `list`, `describe`, call shape.

## The domain

Every example works against one domain: a shipping company that books cargo between ports, the same domain the sibling REST course uses. The continuity reflects a real seam. gRPC is the **internal** layer the booking service calls to price or track a shipment: a `RoutingService` for quotes and route planning, a `TrackingService` for shipment status and a `QuoteService` for pricing, reachable only from inside the system. A public REST or GraphQL layer sits in front, and a fleet of internal gRPC services handles the latency-sensitive service-to-service traffic.

| Noun | Meaning |
|---|---|
| **Booking** | The aggregate root a customer creates to move cargo from an origin to a destination |
| **Cargo** | One piece of goods under a booking: description, type, weight in kilograms, volume in cubic metres. No identity apart from its booking |
| **Location** | A port or terminal identified by UN/LOCODE (`USNYC`, `NLRTM`, `SGSIN`), not free text |
| **Route** | The planned sequence of legs that carries a booking's cargo |
| **Leg** | One carrier, one origin, one destination, one departure and arrival time |
| **Operation** | A server-owned record of long-running work, returned by an async method and polled or streamed for status |

{% include excalidraw.html file="00-shipping-domain-model" alt="An entity-relationship diagram of the shipping domain. A Booking aggregate holds an id, a BookingState, a repeated list of Cargo items, and a quote of type Money. A Route aggregate holds an id, a repeated list of Legs, and a price of type Money. A Leg holds a carrier string plus origin and destination fields of type Location, and departs_at/arrives_at timestamps. Location and Money are shared value types with no identity of their own: Booking references Location twice, as origin and as destination, and Leg references it the same way; Booking and Route both reference Money, as quote and as price respectively." caption="Figure 0.2: the domain nouns every later chapter's proto, service, and diagram reuses." %}

Later chapters add RPCs and message wrappers around these types rather than new concepts. `Location` and `Money` carry no `id`, so both are reused by value: a `Leg`'s `origin` is a full `Location`, not a key into a locations table, and a `Route`'s `price` is a full `Money`, not a pointer to a ledger entry.

Every monetary value is a decimal string, never a binary float. `shipping.type.v1.Money` is `{ currency: "USD", amount: "1250.00" }`, because a float can't represent every two-decimal value exactly and an invoice off by a cent from rounding error surfaces as a reconciliation failure weeks later. `GetQuoteResponse` computes the quote as a `BigDecimal` or `Decimal` sum, rounds `HALF_UP` and renders a string before it reaches the wire.

## Repo layout

Three things live in three places:

| Path | Holds |
|---|---|
| `contracts/proto/` | The single source of truth for every message and service. Linted and compiled by buf in CI; no example commits a copy |
| `examples/NN-chapter-name/` | A Quarkus implementation, a Python implementation, a `compose.yaml` and a `verify.sh` that proves both stacks work, not just compile |
| `_docs/` | The chapters |

Contract-first means each example's Containerfile copies the exact `.proto` files it needs out of `contracts/proto/` at build time and generates server code in that same build. No generated stub is ever committed. Quarkus hooks proto-to-Java (Mutiny) generation into the build through the `quarkus-grpc` extension once the module declares `<packaging>quarkus</packaging>`; plain `jar` packaging compiles but silently skips code generation. Python runs `grpc_tools.protoc` against the staged files and produces the `_pb2.py` and `_pb2_grpc.py` modules the application imports.

Every both-stack sample uses the same two tabs, Quarkus and Python, so neither stack is learned in isolation:

{% include codetabs.html langs="Quarkus|Python" %}

```dockerfile
FROM registry.access.redhat.com/ubi10/openjdk-25:1.24-15 AS build

WORKDIR /build
COPY examples/00-prerequisites/quarkus/pom.xml .
COPY examples/00-prerequisites/quarkus/src ./src

# Copy only the two proto files RoutingService needs, preserving the package
# path the import statement in routing.proto expects.
COPY contracts/proto/shipping/type/v1/types.proto ./src/main/proto/shipping/type/v1/types.proto
COPY contracts/proto/shipping/routing/v1/routing.proto ./src/main/proto/shipping/routing/v1/routing.proto

RUN mvn -B package -DskipTests -Dmaven.javadoc.skip=true -Dmaven.wagon.http.retryHandler.count=3 -Daether.connector.http.retryHandler.count=3 -Daether.syncContext.named.time=300 -Daether.syncContext.named.time.unit=SECONDS
```
```dockerfile
FROM registry.access.redhat.com/ubi10/python-314-minimal:10.2-1791464217 AS build

# The image runs as UID 1001; the build stage needs root to write /app.
# Build at the same path the runtime uses: a venv is not relocatable, its
# console scripts carry the absolute interpreter path.
USER 0
WORKDIR /app

RUN pip install --no-cache-dir uv==0.12.24

COPY examples/00-prerequisites/python/pyproject.toml ./
COPY examples/00-prerequisites/python/app ./app

# No uv.lock committed yet (small, pure-Python dependency set); --locked is
# adopted once a lockfile lands alongside a persistence layer.
# `--group dev` pulls in grpcio-tools (needed below, not at runtime).
RUN uv sync --group dev

# Stage the two proto files this service needs, preserving the package path
# routing.proto's import statement expects, then generate the stub packages
# into /app/generated, a sibling of app/, added to PYTHONPATH below, so
# `from shipping.routing.v1 import routing_pb2` resolves the same way it
# does after a local (non-container) `protoc` run.
COPY contracts/proto/shipping/type/v1/types.proto ./proto/shipping/type/v1/types.proto
COPY contracts/proto/shipping/routing/v1/routing.proto ./proto/shipping/routing/v1/routing.proto
RUN mkdir -p generated && \
    .venv/bin/python -m grpc_tools.protoc -I proto \
      --python_out=generated --grpc_python_out=generated \
      proto/shipping/type/v1/types.proto proto/shipping/routing/v1/routing.proto

# Rebuild the venv without the dev group (grpcio-tools and its protoc
# binary are not needed to run the server).
RUN rm -rf .venv && uv sync --no-dev
```

The Python build stage runs as `USER 0` to write into `/app` before dropping to UID `1001`. UBI 10's Python image runs non-root by default, and a `uv` virtual environment embeds its interpreter's absolute path in every console script, so moving it after the build breaks every entry point silently.

## Build, run, observe

```bash
cd examples/00-prerequisites
./verify.sh
```

`verify.sh` brings both services up with `docker compose`, waits for each server to answer reflection's `list`, calls `GetQuote` against both, checks that `quote.currency` is the canned `"USD"`, prints `PASS` and tears the stack down whether or not the checks pass. CI runs the same script on every commit, so a stack that can't come up from nothing and shut down cleanly fails the build.

To poke at it by hand, run the `list` and `GetQuote` commands above against `localhost:9000` for Quarkus and `localhost:9001` for Python. The listing and the canned `quote.currency` are identical on both, which is enough to show that codegen, the server, reflection and the container network are wired correctly.

Everything runs through Compose, so the artifact you run is the artifact CI validates. Install local SDKMAN or uv toolchains only to step through a handler in an IDE.

## For deeper coverage

- Hüseyin Babal, *gRPC Microservices in Go* (Packt): service patterns and the toolchain discipline behind a runnable gRPC lab.
- Sam Newman, *Building Microservices*, 2nd ed. (O'Reilly): service boundaries and what an internal service's lab environment needs to prove.
- [grpc.io: Server reflection](https://grpc.io/docs/guides/reflection/) and [buf](https://buf.build) docs: the reflection protocol and the contract-linting tool the lab pins.
- Cloud Native Design Patterns: the *Setting Up* chapter, for the same shared-vocabulary-and-canonical-system approach taken with the shipping domain.
