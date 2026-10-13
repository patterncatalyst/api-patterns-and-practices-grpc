---
title: "Prerequisites & the lab"
order: 0
part: "Prerequisites & the Lab"
description: "Toolchain pins, the Docker Compose lab with opt-in LGTM tracing, and the shipping/cargo domain this site's gRPC services share with the REST booking service."
duration: "25 min"
---

Every hands-on chapter from here forward hands you a running gRPC service in two languages, generated from one Protobuf contract. This chapter is where that becomes true on your machine. It pins the toolchain each example builds against, brings up the Compose stack that boots both stacks side by side, shows how to call a server that `curl` can't talk to, and fixes the shipping/cargo vocabulary every later proto, service name, and diagram refers back to. Nothing here touches message or service design — that starts in Chapter 3. This chapter proves the plumbing works, so it's never the thing you're debugging once the real protocol design begins.

## Toolchain pins

Every example in this site builds its Quarkus and Python images from inside a container, targeting Red Hat UBI 10 base images, so the host itself never needs a JDK or a Python interpreter to run `docker compose up`. The Quarkus side builds on `quarkus-grpc` against UBI 10's `openjdk-25` image and targets Java 25 — the current LTS release, and the version every later chapter's Containerfile pins without re-justifying it. The Python side pins `grpcio` and `grpcio-tools` against Python 3.14 on UBI 10's `python-314-minimal` image, managed by [uv](https://docs.astral.sh/uv/) rather than `pip`, `venv`, and a separate interpreter manager stitched together by hand. Java 25 and Python 3.14 are both the current stable release of their respective language as of this writing, and UBI 10 is the current Red Hat base image generation; pinning to "current stable" rather than an older LTS floor keeps every example close to what a reader installs today, and keeps the gap between "what this site teaches" and "what a fresh `sdk install` or `uv python install` gives you" as small as it can be.

Contract-first work needs tools beyond a language runtime. [buf](https://buf.build) lints every `.proto` file, compiles the full import graph, and checks each change against the previous commit for a breaking field, tag, or type change — the evolution gate Chapter 5 builds on. [grpcurl](https://github.com/fullstorydev/grpcurl) is this site's `curl` equivalent: a command-line gRPC client that talks to a server over HTTP/2 the same way any other client would. Its companion [grpcui](https://github.com/fullstorydev/grpcui) does the same thing with a local web form instead of a terminal invocation, which is worth reaching for the first few times you explore an unfamiliar service before the request JSON becomes second nature. [ghz](https://ghz.sh) is a gRPC load-testing tool that shows up once Part 7 gets to streaming at scale and performance tuning — it isn't needed for this chapter's lab, but it's worth installing alongside the others now so a later chapter isn't the first time you reach for it. A container engine with Compose v2 — Docker Desktop/Engine or Podman providing an equivalent `docker compose` — is the one tool every chapter assumes without exception, because every example builds and runs inside containers rather than against a host-installed runtime.

The last toolchain piece is the observability stack: `grafana/otel-lgtm`, an all-in-one image bundling Loki (logs), Grafana (dashboards), Tempo (traces), and Mimir (metrics) behind a single OpenTelemetry Collector. Both Quarkus and Python are instrumented for OTLP export from this chapter onward, but that stack is opt-in rather than part of every `docker compose up` — more on why in the next section.

## The lab

The Ch0 example's `compose.yaml` brings up two services by default: `quarkus` on host port 9000 and `python` on host port 9001, both mapped from container port 9000 (gRPC servers conventionally bind to whatever port the deployment assigns them, not a protocol-reserved one the way HTTP has 80 and 443). Both services are generated from the exact same `.proto` files in `contracts/proto/`, and both implement `RoutingService.GetQuote`. Neither computes anything from the request yet — that arrives in Chapter 5 — but both answer on the wire, and both answer identically, which is the property every later chapter's `verify.sh` depends on: two independent implementations, one contract, one assertable result.

A third service, `lgtm`, sits behind a Compose `profiles: ["observability"]` entry, which means a plain `docker compose up` never starts it:

```bash
docker compose up --build                            # app stack only: quarkus, python
docker compose --profile observability up --build     # + Grafana LGTM on :3000
```

Both applications are wired for OTLP export unconditionally — the endpoint is just an environment variable — but neither one requires a collector to be listening. An OTLP exporter with no live endpoint fails asynchronously in the background; it never blocks a `GetQuote` call or the server's startup. That's deliberate, not an oversight: at this stage in the site there's nothing interesting to trace yet beyond "a call happened," so paying the cost of four extra containers on every chapter's first boot would slow down every reader's loop for no signal. The profile exists so you can opt in the moment you want to watch a call's span land in Tempo, and every later chapter that does real work keeps the same shape: a compose stack that boots fast by default, with tracing one flag away.

{% include excalidraw.html file="00-lab-topology" alt="The Compose lab topology: a grpcurl or grpcui client calling GetQuote through server reflection against a Quarkus container on host port 9000 and a Python container on host port 9001, both generated from the same proto contract in contracts/proto/, with an optional LGTM observability stack reachable only when the observability profile is active." caption="Figure 0.1 — The lab: one proto, two servers, reflection instead of a local stub, OTel off by default." %}

## Calling a server you can't curl

A REST API's path and method are visible from the request line alone; a gRPC call carries none of that in a form `curl` understands; it's an HTTP/2 request with a binary Protobuf-encoded body and a method name buried in the `:path` pseudo-header. That's exactly the gap `grpcurl` closes, and it does so without needing a local copy of the `.proto` file, as long as the server has **reflection** turned on. Reflection is itself a gRPC service — `grpc.reflection.v1alpha.ServerReflection` — that a server exposes alongside its real services, letting a client ask "what services do you have" and "what's the shape of this message" at runtime instead of compiling that knowledge in ahead of time. Quarkus turns this on with one property, `quarkus.grpc.server.enable-reflection-service=true` (on automatically in dev mode, explicit everywhere else); Python's `grpcio-reflection` package does the equivalent with a couple of lines at server startup. Both stacks in this chapter's example have it enabled, which is what makes the two commands below work against either one with no setup beyond knowing the port:

```bash
grpcurl -plaintext localhost:9000 list
# grpc.reflection.v1alpha.ServerReflection
# shipping.routing.v1.RoutingService

grpcurl -plaintext -d '{}' localhost:9000 shipping.routing.v1.RoutingService/GetQuote
```

`-plaintext` tells `grpcurl` to skip TLS, which every example in this site uses until Chapter 19 introduces certificates; every other hands-on chapter's "poke at it by hand" instructions follow this same `list` → `describe` → call shape, just against whatever service that chapter adds.

## The domain this site builds against

Every example in this site works against one domain: a shipping company that books cargo for carriage between ports, and the same domain the sibling REST site teaches its patterns against. That continuity is deliberate. gRPC here is not a second, unrelated API — it's the **internal** layer the REST site's booking service would call if it needed to price a shipment or track one in transit: a `RoutingService` for quotes and route planning, a `TrackingService` for shipment status, and a `QuoteService` for pricing, all reachable only from inside the system, never directly from a browser or a public API consumer. That's the seam a lot of production systems actually have: a public-facing REST or GraphQL layer in front, and a fleet of internal gRPC services behind it handling the latency-sensitive, service-to-service traffic HTTP/JSON was never the right fit for. Learning gRPC against this exact domain, rather than an abstract example, is what makes that seam concrete instead of hypothetical.

The vocabulary itself matches the REST site's glossary term for term, now expressed as Protobuf messages instead of JSON Schema components. A **Booking** is the aggregate root a customer creates to move cargo from an origin to a destination. A **Cargo** item is one piece of goods under a booking — a description, a type, a weight in kilograms, a volume in cubic metres — and has no identity apart from the booking it belongs to. A **Location** is a port or terminal, identified by its UN/LOCODE (`USNYC`, `NLRTM`, `SGSIN`) rather than a free-text name, which is what lets a route reference a location without repeating or risking disagreement over its spelling. A **Route** is the planned sequence of **Leg**s — one carrier, one origin, one destination, one departure and arrival time per leg — that carries a booking's cargo from where it starts to where it needs to be. An **Operation** is a server-owned record of long-running work, returned by an async method and polled or streamed for status; Part 6 builds the RPCs that create and track one.

{% include excalidraw.html file="00-shipping-domain-model" alt="An entity-relationship diagram of the shipping domain. A Booking aggregate holds an id, a BookingState, a repeated list of Cargo items, and a quote of type Money. A Route aggregate holds an id, a repeated list of Legs, and a price of type Money. A Leg holds a carrier string plus origin and destination fields of type Location, and departs_at/arrives_at timestamps. Location and Money are shared value types with no identity of their own: Booking references Location twice, as origin and as destination, and Leg references it the same way; Booking and Route both reference Money, as quote and as price respectively." caption="Figure 0.2 — the domain nouns every later chapter's proto, service, and diagram reuses." %}

This is the full noun inventory, and it doesn't grow much from here: every later chapter adds RPCs and message wrappers around these same six types rather than inventing new domain concepts. `Location` and `Money` in particular have no identity of their own — neither carries an `id` field — which is exactly why both get reused by value instead of by reference: a `Leg`'s `origin` is a full `Location`, not a lookup key into some locations table, and a `Route`'s `price` is a full `Money`, not a pointer to a ledger entry.

Money gets the same treatment it gets on the REST side, and for the same reason: every monetary value in this site's contracts is a decimal string, never a binary float. `shipping.type.v1.Money` is `{ currency: "USD", amount: "1250.00" }`, not a floating-point number, because a float can't represent every two-decimal currency value exactly, and a shipping invoice that's off by a cent from accumulated rounding error is the kind of bug that surfaces as a reconciliation failure weeks later, not a test failure today. Chapter 5's `GetQuoteResponse` is where this rule stops being a statement and starts being code you can read: the quote amount is computed as a `BigDecimal`/`Decimal` sum, rounded `HALF_UP`, and rendered as a string before it ever reaches the wire.

## Repo layout

This site keeps three things in three places, and the boundary between them matters more than it looks. `contracts/proto/` is the single source of truth for every message and service definition — it's linted and compiled by buf in CI, and no example or chapter commits a copy of a `.proto` file alongside its own code. `examples/` holds the runnable code: every hands-on chapter gets its own directory under `examples/NN-chapter-name/`, with a Quarkus implementation, a Python implementation, a `compose.yaml`, and a `verify.sh` that proves both stacks actually work, not just that they compile. `_docs/` holds the chapters themselves — the prose you're reading now, plus every chapter after it.

The pairing between `contracts/` and `examples/` is what contract-first actually means in practice here: each example's Containerfile copies the exact `.proto` files it needs out of `contracts/proto/` at build time and generates the server code during that same build, so there is never a committed, possibly-stale copy of generated stubs sitting in the repository. Quarkus does this through the `quarkus-grpc` extension, which hooks proto-to-Java(Mutiny) generation into the build lifecycle automatically once a module declares `quarkus` packaging. Python does it by running `grpc_tools.protoc` directly against the staged proto files, producing the `_pb2.py` and `_pb2_grpc.py` modules the application imports. Both approaches land in the same place: the code you read in either language was generated from the contract you can read in `contracts/proto/`, not hand-written to approximate it.

Every both-stack code sample in this site, starting with this one, uses the same two-tab layout: a Quarkus tab and a Python tab, shown together so the same idea is never learned as "how Quarkus does it" in isolation. A Go and a C++ tab join the rotation in a later edition; the tab bar is built to admit them without changing how any existing sample reads.

{% include codetabs.html langs="Quarkus|Python" %}

```dockerfile
# examples/00-prerequisites/quarkus/Containerfile
FROM registry.access.redhat.com/ubi10/openjdk-25:1.24-15 AS build
WORKDIR /build
COPY pom.xml .
COPY src ./src
COPY contracts/proto/shipping/type/v1/types.proto    ./src/main/proto/shipping/type/v1/types.proto
COPY contracts/proto/shipping/routing/v1/routing.proto ./src/main/proto/shipping/routing/v1/routing.proto
RUN mvn -B package -DskipTests

FROM registry.access.redhat.com/ubi10/openjdk-25-runtime:1.24-15
COPY --from=build --chown=185 /build/target/quarkus-app/lib/ /deployments/lib/
COPY --from=build --chown=185 /build/target/quarkus-app/*.jar /deployments/
ENTRYPOINT [ "/opt/jboss/container/java/run/run-java.sh" ]
```
```dockerfile
# examples/00-prerequisites/python/Containerfile
FROM registry.access.redhat.com/ubi10/python-314-minimal:10.2-1791464217 AS build
USER 0
WORKDIR /app
RUN pip install --no-cache-dir uv==0.12.24
COPY pyproject.toml ./
COPY app ./app
COPY contracts/proto/shipping/type/v1/types.proto    ./proto/shipping/type/v1/types.proto
COPY contracts/proto/shipping/routing/v1/routing.proto ./proto/shipping/routing/v1/routing.proto
RUN uv sync --group dev && \
    .venv/bin/python -m grpc_tools.protoc -I proto --python_out=generated --grpc_python_out=generated \
      proto/shipping/type/v1/types.proto proto/shipping/routing/v1/routing.proto && \
    rm -rf .venv && uv sync --no-dev

FROM registry.access.redhat.com/ubi10/python-314-minimal:10.2-1791464217
COPY --from=build --chown=1001:0 /app/.venv /app/.venv
COPY --from=build --chown=1001:0 /app/app /app/app
COPY --from=build --chown=1001:0 /app/generated /app/generated
ENTRYPOINT ["opentelemetry-instrument", "python", "-m", "app.main"]
```

Both base image pins — `openjdk-25:1.24-15` and `python-314-minimal:10.2-1791464217` — are exact tags, not floating majors, re-checked against `skopeo list-tags` and bumped as a deliberate, reviewed change rather than a side effect of an unrelated rebuild. The Python build stage runs as `USER 0` specifically to write into `/app` before dropping to UID `1001` at runtime, because UBI 10's Python image runs non-root by default and a `uv`-managed virtual environment embeds its interpreter's absolute path into every console script it generates — moving it after the fact breaks every entry point silently.

## Running the Ch0 example

```bash
cd examples/00-prerequisites
./verify.sh
```

`verify.sh` brings both services up with `docker compose`, waits for each gRPC server to answer reflection's `list` call, calls `GetQuote` against both, asserts the response carries the expected canned `quote.currency`, prints `PASS`, and tears the stack down afterward whether the checks pass or fail. That last part isn't incidental: a chapter's verification only means something if it proves the stack comes up from nothing and shuts back down cleanly every single time, which is exactly what CI depends on when it runs this same script, with the same assertions, on every commit.

<div class="callout callout--safe"><p class="callout__title">Decision</p><p>Everything in this site runs through Compose rather than assuming a host-installed JDK or Python interpreter, because the artifact a reader runs this way is the same artifact CI validates. Install the local SDKMAN/uv toolchains only once you want to step through a handler in an IDE between chapters; <code>docker compose up</code> alone is sufficient to work through every example end to end.</p></div>

## On the wire

Every "poke at it by hand" box in this site follows the same two-step shape once a server exposes reflection: list what it offers, then call it. `verify.sh` runs exactly these two commands against each stack:

```bash
grpcurl -plaintext localhost:9000 list
# grpc.reflection.v1alpha.ServerReflection
# shipping.routing.v1.RoutingService

grpcurl -plaintext -d '{}' localhost:9000 shipping.routing.v1.RoutingService/GetQuote
```

| Field | Expected |
|---|---|
| `quote.currency` | `"USD"` |

Swap `9000` for `9001` to run the identical two commands against the Python stack — same reflection listing, same method, same canned field. That one field is the entire assertion this chapter makes: it is enough to prove codegen, the gRPC server, reflection, and the container network are all wired correctly, without pretending there's a real quote behind it yet.

## Where this goes next

Chapter 1 steps back from the lab to the decision this site spends its first part justifying: when a service boundary should speak gRPC instead of REST, and what that trade actually costs. Chapter 3 is where Protobuf itself gets a real treatment — fields, tags, encoding, why defaults can't distinguish "zero" from "unset." Chapter 5 returns to this exact example and replaces its canned `GetQuote` with the real, independently-computed formula both stacks must agree on, which is also the first chapter whose `verify.sh` asserts response semantics instead of a single hardcoded field. Everything this chapter set up — the toolchain, the Compose shape, the domain vocabulary, reflection as the default way to call a server — stays constant from here forward; only what's behind each RPC gets more real.
