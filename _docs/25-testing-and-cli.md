---
title: "Testing and the CLI"
order: 25
part: "Testing & Debugging"
description: "Where in-process tests, grpcurl, ghz and the GUI clients sit on the gRPC test pyramid, how server reflection feeds them, and how to make a build-stage test a real gate."
duration: 26 minutes
---

## Learning objectives

By the end of this chapter you can:

- Place in-process (`@QuarkusTest`, pytest), integration (`grpcurl` against a container), load (`ghz`) and manual exploration (`grpcui`, Insomnia, Yaak) testing on the gRPC test pyramid.
- Use server reflection to `list` and `describe` a service with `grpcurl`, and explain why Python's `grpcio-reflection` resolves a service symbol but not a method symbol.
- Build an in-process `grpc.aio` test fixture on an OS-assigned port, and know why `grpc_testing` can't serve it.
- Wire a build-stage test gate (`mvn verify`; `pytest` with no skip flag) that fails `docker build`, and prove it by seeding a wrong assertion.
- Run `ghz` against `GetQuote` and assert loose, relative bounds.

## Why this matters

A script that builds a container, calls it over the wire and checks the fields that come back is a test, but of which kind? Unit, integration, load or exploratory, and where do `grpcurl`, `grpcui`, Insomnia, Yaak, `@QuarkusTest`, pytest and `ghz` each fit?

`RoutingService.GetQuote` is the vehicle again, unchanged. Testing strategy isn't a schema problem.

{% include excalidraw.html file="25-grpc-test-pyramid" alt="A four-layer stack labeled, from bottom to top, Unit and in-process, Integration, Load, and Manual exploration. The bottom Unit and in-process band holds two boxes, Quarkus with AtQuarkusTest plus AtGrpcClient and build-stage mvn verify, and Python with pytest plus an in-process grpc.aio server and build-stage pytest, both marked CI-gated. The Integration band holds one box, verify.sh against the running container with grpcurl semantic asserts, marked CI-gated. The Load band holds one box, ghz pinned one-shot load test with loose bounds, marked CI-gated. The top Manual exploration band holds two boxes side by side, grpcurl list and describe marked CI-gated, and grpcui, Insomnia, and Yaak marked illustrative only. Amber arrows connect each band to the one above it." caption="Figure 25.1: The gRPC test pyramid: three CI-gated layers underneath a top layer that splits between a CI-gated CLI probe and illustrative GUIs." %}

## Layers of the pyramid

The classic pyramid maps onto gRPC with little translation:

| Layer | What it does | Tool here | In CI |
|---|---|---|---|
| In-process | Servicer called directly in one process; no container, no external socket | `@QuarkusTest`, pytest | Gated, and runs inside `docker build` |
| Integration | Real container, real TCP, real serialization | `verify.sh` with `grpcurl` | Gated |
| Load | The same RPC called hundreds of times concurrently, to characterize latency and throughput | `ghz` | Gated, loose bounds |
| Manual exploration | A person poking a running service | `grpcurl list` and `describe`; `grpcui`, Insomnia, Yaak | `grpcurl` gated; GUIs illustrative |

The top layer splits. `grpcurl` is deterministic and scriptable, so it fails a build like any assertion. `grpcui`, Insomnia and Yaak are a browser tab and two desktop apps built for a person to click through, and no CI runner can launch a GUI and assert on it. They are no less useful: many engineers reach for them before `grpcurl`, because clicking through a service's shape beats remembering its JSON.

## One mechanism, four clients

Calling a gRPC service without a hand-written typed client needs a schema, and the wire format has none: it is varint-tagged, length-prefixed bytes with no field names. **Server reflection** (`grpc.reflection.v1alpha.ServerReflection`, a second gRPC service on the same server) closes that gap. A client asks the server for the descriptors it needs, then encodes requests and decodes responses on the fly.

- **`grpcurl`** is a command-line client. It uses reflection (or a local `.proto` or protoset) to `list`, `describe` and call with JSON in and JSON out, and it exits non-zero on failure.
- **`grpcui`** is its browser-based sibling. It renders a form per RPC from the reflected message shape, the fastest way to explore a service interactively.
- **Insomnia** and **Yaak** are general API clients with native gRPC support, including reflection-driven discovery. Teams keep them installed to maintain libraries of saved requests across services.

{% include excalidraw.html file="25-reflection-probe-landscape" alt="A box labeled RoutingService with GetQuote and four other stubs sends an arrow labeled descriptors into a box labeled grpc.reflection.v1alpha ServerReflection, with enable-reflection-service=true noted beneath it. From the reflection box, four arrows fan out to four boxes on the right: grpcurl, labeled list / describe, CI-gated, connected by an amber arrow labeled list/describe; and grpcui, Insomnia, and Yaak, each labeled illustrative only, connected by plain gray arrows. A caption below reads: one reflection service, four clients; only the CLI path is asserted in verify.sh." caption="Figure 25.2: One reflection service feeds grpcurl, grpcui, Insomnia and Yaak identically; only the grpcurl path is deterministic enough to assert in CI." %}

Both stacks turn reflection on explicitly, because the defaults disagree:

| Stack | How reflection is enabled |
|---|---|
| Quarkus | `quarkus.grpc.server.enable-reflection-service=true`. `quarkus-grpc` enables it in dev mode but not in a packaged application. |
| Python | `reflection.enable_server_reflection(service_names, server)` in `app/main.py`, once at startup. No dev/prod distinction. |

The implementations also differ in depth. `grpcurl describe shipping.routing.v1.RoutingService.GetQuote` (a method symbol) resolves against Quarkus and fails against Python with `Symbol not found`. grpc-java's reflection walks `Service.Method` down to the individual RPC. Python's `grpcio-reflection` indexes only top-level symbols: services, messages and enums. Describing the service itself works identically on both and prints every RPC signature, so the probe describes the service.

## In-process tests and the build gate

The base of the pyramid has the least ceremony: no container, no network setup, and the fastest feedback by a wide margin.

**Quarkus.** `@QuarkusTest` boots the whole application inside the JVM under test, including the real gRPC server. `@GrpcClient` injects a client typed to the generated `RoutingService` interface, and for a service without TLS it needs no host or port configuration, as the Quarkus gRPC guide's "Testing your services" section documents:

```java
@QuarkusTest
class RoutingServiceTest {

    @GrpcClient
    RoutingService client;

    @Test
    void getQuoteComputesTheExpectedAmountAndRoute() {
        Routing.GetQuoteRequest request = Routing.GetQuoteRequest.newBuilder()
                .setOrigin(Types.Location.newBuilder()
                        .setUnLocode("USNYC")
                        .setName("New York")
                        .build())
                .setDestination(Types.Location.newBuilder()
                        .setUnLocode("NLRTM")
                        .setName("Rotterdam")
                        .build())
                .addCargo(Types.Cargo.newBuilder()
                        .setWeightKg(1200.5)
                        .setDescription("Palletized electronics")
                        .setCargoType("GENERAL")
                        .build())
                .build();

        // GetQuote is unary-in/unary-out: the Uni resolves once the server
        // replies. .await().atMost(...) blocks this test thread for that one
        // reply: a tight, explicit timeout so a hung server fails the test
        // instead of hanging the build forever.
        Routing.GetQuoteResponse response = client.getQuote(request)
                .await().atMost(Duration.ofSeconds(5));

        assertEquals("USD", response.getQuote().getCurrency(), "quote.currency");
        assertEquals("3001.25", response.getQuote().getAmount(), "quote.amount");
        assertEquals("rte_USNYC-NLRTM", response.getRoute().getId(), "route.id");
        assertEquals("MAERSK", response.getRoute().getLegs(0).getCarrier(), "route.legs[0].carrier");
    }
}
```

**Python.** `grpcio` has no in-process harness, and the obvious candidate is the wrong tool: the fake channel in `grpc_testing` has no `asyncio` support, and the Python stack is `grpc.aio` end to end. Start a real `grpc.aio.server()` on an ephemeral port (`:0` asks the kernel for any free one) with the same servicer the container runs, and drive it with a real channel:

```python
@pytest_asyncio.fixture
async def routing_channel() -> AsyncIterator[grpc.aio.Channel]:
    """Starts a REAL grpc.aio server bound to an OS-assigned ephemeral port,
    wired with the same RoutingServiceServicer the container runs, yields a
    channel connected to it, and tears both down afterward."""
    server = grpc.aio.server()
    routing_pb2_grpc.add_RoutingServiceServicer_to_server(RoutingServiceServicer(), server)
    port = server.add_insecure_port("127.0.0.1:0")
    await server.start()

    channel = grpc.aio.insecure_channel(f"127.0.0.1:{port}")
    try:
        yield channel
    finally:
        await channel.close()
        await server.stop(grace=None)


@pytest.mark.asyncio
async def test_get_quote_computes_the_expected_amount_and_route(
    routing_channel: grpc.aio.Channel,
) -> None:
    stub = routing_pb2_grpc.RoutingServiceStub(routing_channel)

    response = await stub.GetQuote(_REQUEST)

    assert response.quote.currency == "USD"
    assert response.quote.amount == "3001.25"
    assert response.route.id == "rte_USNYC-NLRTM"
    assert response.route.legs[0].carrier == "MAERSK"
```

Tearing down after every test gives each test a fresh server on a fresh port instead of two tests racing for one. `pytest` has no native concept of an `async def` test, so `pytest-asyncio` and the `@pytest.mark.asyncio` marker are required. Without them the function never runs its body and "passes".

**The build gate.** Both Containerfiles run their suite in the image's build stage, unconditionally. Quarkus runs `mvn verify`, not `mvn package -DskipTests`. Python runs `.venv/bin/python -m pytest tests -q`. A failing assertion makes that `RUN` exit non-zero, so `docker build` fails, `docker compose up --build` fails and `verify.sh` fails. No broken image is produced, and no later layer runs against it.

Re-running a suite by hand needs its own stage. A Compose service that overrides the final image's entrypoint to call `pytest` finds nothing to run, because the runtime image has no test dependencies: Python's build ends with `uv sync --no-dev`, and the Quarkus runtime stage keeps only the jar. So the Python Containerfile ends its `build` stage right after the `pytest` run and moves the dependency trim into a separate `trimmed` stage that the runtime image copies from. The `python-tests` service targets `build` directly, where pytest and `tests/` are still present. Quarkus needs no restructuring, because `mvn test` only needs the source tree and `pom.xml` present at its build stage.

## ghz: the load layer

`ghz` has no reflection client, unlike the tools above. It needs a compiled `.proto` or a protoset on disk, so Compose mounts `contracts/proto/` read-only into a profiled-off `ghz` service, and `verify.sh` runs it with `docker compose run --rm ghz`, naming `shipping.routing.v1.RoutingService.GetQuote` (concurrency 10, 300 requests, JSON output) against `quarkus:9000` and `python:9000`.

The assertions are three and all loose: the error count is zero, p99 latency is under a generous ceiling, and requests per second clears a low floor. A tight absolute number would describe one machine on one day, and would flake on a slower or more contended CI runner. One recorded run:

| Stack | Requests per second | p99 |
|---|---|---|
| Quarkus | about 1,868 | about 12 ms |
| Python | about 4,094 | about 4 ms |

## Implementation notes

Both servers implement the smallest `GetQuote`: `quote.amount = round_half_up(sum(cargo[].weight_kg) * 2.50, 2)`, a single `MAERSK` leg, and a route id built from the two UN/LOCODEs. Everything of interest wraps the implementation: the tests, the build-stage check and the reflection surface.

Quarkus needs a body for every RPC. `RoutingService` is a generated Java interface, not an abstract base class. grpc-java's `*ImplBase` supplies default `UNIMPLEMENTED` bodies, but `quarkus-grpc`'s Mutiny generator does not, so `RoutingServiceImpl` fails to compile unless all five methods exist. The other four return a `Uni` or `Multi` that fails immediately with `Status.UNIMPLEMENTED`. On Python the generated `RoutingServiceServicer` base class raises `UNIMPLEMENTED` for any method a subclass doesn't override, so there is nothing to write. Same contract, two generated shapes: don't assume the other stack supplies what one supplies by default.

## When to use which layer

| Put it here | When |
|---|---|
| Build gate (in-process) | The check must block an artifact. It runs in milliseconds and needs no network or container. A gate that takes minutes gets skipped under deadline pressure, and a skipped gate is not a gate. |
| `verify.sh` with `grpcurl` | Only a real container and socket can prove it: reflection reachable, a port bound, TLS negotiating. Don't re-derive what the in-process suite covers. |
| CLI (`grpcurl`) | The check runs unattended and asserts an outcome, in a script or CI. |
| GUI (`grpcui`, Insomnia, Yaak) | A person is exploring an unfamiliar service to understand its shape, not to assert against it. |

> **🤖 Explore with your agent**
>
> "In examples/25-testing-and-cli, add a second in-process test for RoutingService.GetQuote with an empty cargo list, once in quarkus/src/test/java/com/patterncatalyst/shipping/routing/RoutingServiceTest.java and once in python/tests/test_routing_service.py. Keep both in-process, put them behind the build-stage gate, and state which pyramid layer each check belongs to."
>
> Check: `docker build -f examples/25-testing-and-cli/quarkus/Containerfile .` and the Python equivalent run the new tests, and `./verify.sh` still prints PASS.

## Build, run, observe

```bash
cd examples/25-testing-and-cli && ./verify.sh
```

The script brings both services up. Each image's build-stage gate has already run once inside `docker build`. It then calls `GetQuote` with `grpcurl` and asserts field values, probes reflection's `list` and `describe` the way `grpcui` would, re-runs each in-process suite with `docker compose run --build`, and runs `ghz` on both stacks. Expect `PASS`. The gRPC ports are 9250 (Quarkus) and 9251 (Python).

By hand:

- Run `grpcurl -plaintext localhost:9250 list`. It prints `grpc.reflection.v1alpha.ServerReflection` and `shipping.routing.v1.RoutingService`.
- Run `grpcurl -plaintext localhost:9250 describe shipping.routing.v1.RoutingService`. It prints all five RPC signatures, `NegotiateRoute` as a bidirectional stream. Compare `GetQuote` with `contracts/proto/shipping/routing/v1/routing.proto`: reflection reports the server's own compiled descriptors, so the names and fields should match exactly.

Experiments:

- **Seed a wrong assertion on Quarkus.** Change the amount assertion in `RoutingServiceTest.java` from `"3001.25"` to `"9999.99"` and rebuild with `docker build -f examples/25-testing-and-cli/quarkus/Containerfile .`. The build fails with Surefire's `expected: <9999.99> but was: <3001.25>` and `BUILD FAILURE`, and no image is produced.
- **Seed the same failure on Python.** Make the same change in `python/tests/test_routing_service.py` and rebuild the Python image. pytest's `assert '3001.25' == '9999.99'` fails, and the `RUN` step exits with code 1. A build-stage test is a gate only if its failure stops the artifact from existing, and the way to be sure is to make it fail once.
- **Describe a method symbol.** Run `grpcurl -plaintext localhost:9251 describe shipping.routing.v1.RoutingService.GetQuote` against the Python stack: it fails with `Symbol not found`, while the same call on 9250 resolves.

---

## For deeper coverage

- Cloud Native Design Patterns, "Appendix O: API Testing with Newman", for the same CLI-driven, CI-gated testing applied to REST collections.
- [`grpcurl`](https://github.com/fullstorydev/grpcurl) and [`grpcui`](https://github.com/fullstorydev/grpcui): the reflection-driven CLI and GUI tools.
- [`ghz`](https://ghz.sh/): the gRPC load-testing tool behind the load layer.
- [Quarkus: gRPC guide](https://quarkus.io/guides/grpc), including its "Testing your services" section on `@QuarkusTest` with `@GrpcClient`.
