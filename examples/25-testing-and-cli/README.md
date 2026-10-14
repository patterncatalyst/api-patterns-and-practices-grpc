# Ch25 — Testing and the CLI

A lean `shipping.routing.v1.RoutingService.GetQuote` on both stacks — the
same formula every earlier chapter used — built specifically to carry this
chapter's real subject: an in-process test suite that gates the **image
build itself**, plus the reflection-driven CLI probe that stands in for
grpcui, Insomnia, and Yaak.

- `contracts/proto/shipping/routing/v1/routing.proto` — `RoutingService` and
  its five RPCs (only `GetQuote` is implemented; the rest return
  `UNIMPLEMENTED`, same as every earlier chapter).
- `contracts/proto/shipping/type/v1/types.proto` — the shared `Money`,
  `Location`, `Cargo`, `Route`, `Leg` messages.

Quarkus (`quarkus/`, host port **9250**) and Python (`python/`, host port
**9251**) independently implement the identical RPC.

## The gate: a red test fails the image build

Both Containerfiles run their test suite **inside the build stage**, with no
skip flag:

| Stack | Test runner | Containerfile line |
|---|---|---|
| Quarkus | `mvn verify` (not `-DskipTests`) | runs `src/test/java/.../RoutingServiceTest.java`, a real `@QuarkusTest` + `@GrpcClient` call |
| Python | `pytest tests -q` | runs `tests/test_routing_service.py`, a real in-process `grpc.aio` server fixture |

A failing assertion in either suite makes its `RUN` step exit non-zero,
which fails `docker build`, which fails `docker compose up --build` — the
broken image is never produced. This was proven by hand while authoring
this chapter: each assertion was temporarily changed to expect `9999.99`
instead of `3001.25`, `docker build` was re-run, and it failed with the
assertion diff printed in the build log before being reverted. See the
chapter's "Build, run, observe" section for the exact commands.

## Run it

```bash
cd examples/25-testing-and-cli
./verify.sh
```

This brings both services up with `docker compose` (each image's build
stage already ran its test suite to get this far), then:

1. Calls `GetQuote` via `grpcurl` against both host ports and asserts
   response field semantics.
2. Runs the reflection probe — `grpcurl list` and `grpcurl describe
   shipping.routing.v1.RoutingService` — the deterministic CLI stand-in for
   grpcui/Insomnia/Yaak, which all ride the same reflection service.
3. Re-runs `mvn test` / `pytest` one more time, one-shot, via
   `docker compose run --build`, to put a fresh, readable pass/fail directly
   in `verify.sh`'s own log.
4. Runs `ghz` against `GetQuote` on each stack and asserts loose
   (errors=0, generous p99 ceiling, low rps floor) bounds.

Prints `PASS` only if every assertion holds for **both** stacks.

To poke at it by hand instead:

```bash
docker compose up --build
grpcurl -plaintext localhost:9250 list                      # reflection: list services
grpcurl -plaintext localhost:9250 describe shipping.routing.v1.RoutingService

grpcurl -plaintext -d '{
  "origin": {"unLocode": "USNYC", "name": "New York"},
  "destination": {"unLocode": "NLRTM", "name": "Rotterdam"},
  "cargo": [{"weightKg": 1200.5, "description": "Palletized electronics", "cargoType": "GENERAL"}]
}' localhost:9250 shipping.routing.v1.RoutingService/GetQuote

# Re-run each stack's in-process test suite one-shot, independent of
# `docker build` — the SAME assertions the build stage already gated on:
docker compose run --rm --build quarkus-tests
docker compose run --rm --build python-tests

# A real ghz load-test run (fed the proto directly — ghz has no reflection):
docker compose run --rm ghz --insecure \
  --proto /contracts/shipping/routing/v1/routing.proto --import-paths /contracts \
  --call shipping.routing.v1.RoutingService.GetQuote \
  -d '{"origin":{"unLocode":"USNYC","name":"New York"},"destination":{"unLocode":"NLRTM","name":"Rotterdam"},"cargo":[{"weightKg":1200.5,"description":"Palletized electronics","cargoType":"GENERAL"}]}' \
  -c 10 -n 300 -O json quarkus:9000

docker compose down -v
```

Swap `9250` for `9251` to hit the Python stack instead — same request, same
response shape, same numbers.

The Grafana LGTM observability stack is opt-in and off by default:

```bash
docker compose --profile observability up --build
```

## The quote formula (unchanged from every earlier chapter)

```
quote.currency = "USD"
quote.amount   = round_half_up(sum(cargo[].weight_kg) * 2.50, 2)
route.id       = "rte_" + origin.un_locode + "-" + destination.un_locode
route.legs     = [ { carrier: "MAERSK", origin, destination } ]  # departs_at/arrives_at unset
route.price    = quote
```

## The in-process test suites

**Quarkus** (`quarkus/src/test/java/.../RoutingServiceTest.java`):

```java
@QuarkusTest
class RoutingServiceTest {
    @GrpcClient
    RoutingService client;

    @Test
    void getQuoteComputesTheExpectedAmountAndRoute() {
        Routing.GetQuoteResponse response = client.getQuote(request)
                .await().atMost(Duration.ofSeconds(5));
        assertEquals("3001.25", response.getQuote().getAmount(), "quote.amount");
        // ...
    }
}
```

`@QuarkusTest` boots the whole application for the test JVM — including its
real gRPC server — and `@GrpcClient` self-wires to that test server's own
address with no host/port configuration, confirmed against the Quarkus gRPC
guide's own "Testing your services" section for 3.40.1.

**Python** (`python/tests/test_routing_service.py`):

```python
@pytest_asyncio.fixture
async def routing_channel():
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
async def test_get_quote_computes_the_expected_amount_and_route(routing_channel):
    stub = routing_pb2_grpc.RoutingServiceStub(routing_channel)
    response = await stub.GetQuote(_REQUEST)
    assert response.quote.amount == "3001.25"
```

A REAL `grpc.aio.server()` on an OS-assigned ephemeral port — not
`grpc_testing`, whose fake channel has no asyncio support — wired with the
exact same `RoutingServiceServicer` the container runs.

## A real cross-stack reflection quirk

`grpcurl describe shipping.routing.v1.RoutingService.GetQuote` (describing a
specific **method** symbol) works against the Quarkus server but fails
against the Python one with `Symbol not found`. grpc-java's reflection
implementation resolves a `Service.Method` symbol directly; Python's
`grpcio-reflection` only indexes top-level symbols — services, messages,
enums — not individual RPC methods. `verify.sh` works around this (and gets
identical behavior on both stacks) by describing the **service**
(`shipping.routing.v1.RoutingService`), whose output already lists every
RPC's full signature, request type, and response type.

## The other four RPCs

Same as every earlier chapter — only `GetQuote` has a real implementation.
On the Quarkus side, `RoutingService` is a generated Java **interface**
(not an abstract base class), so all five methods must be overridden or the
class fails to compile; the other four return `UNIMPLEMENTED` explicitly. On
the Python side, the generated `RoutingServiceServicer` base class already
raises `UNIMPLEMENTED` for any method a subclass doesn't override, so there
is nothing to write for them.

| RPC | Status in this chapter |
|---|---|
| `GetQuote` | implemented |
| `FindOptimalRoute` | `UNIMPLEMENTED` |
| `ListRoutes` | `UNIMPLEMENTED` |
| `NegotiateRoute` (bidi stream) | `UNIMPLEMENTED` |
| `RecomputeRoutes` (async) | `UNIMPLEMENTED` |

## Proto code generation: `contracts/` is the only source of truth

Neither module commits generated or copied `.proto`/stub files. Each
`Containerfile` builds with the **repo root** as its Docker build context
(see `compose.yaml`) so it can `COPY` the two proto files this service needs
straight from `contracts/proto/` at build time.

## On the wire

```bash
grpcurl -plaintext localhost:9250 list
# grpc.reflection.v1alpha.ServerReflection
# shipping.routing.v1.RoutingService

grpcurl -plaintext localhost:9250 describe shipping.routing.v1.RoutingService
```

`verify.sh` asserts these exact fields from the request above, against
**both** ports:

| Field | Expected |
|---|---|
| `quote.currency` | `"USD"` |
| `quote.amount` | `"3001.25"` |
| `route.id` | `"rte_USNYC-NLRTM"` |
| `route.legs[0].carrier` | `"MAERSK"` |

A real `ghz` run against `GetQuote` (`-c 10 -n 300`):

```
Quarkus — RPS: ~1868   p99: ~12ms   Errors: 0
Python  — RPS: ~4094   p99: ~4ms    Errors: 0
```

## Verification status

`verify.sh` ran green against both stacks on the authoring machine,
repeatedly, including: `GetQuote` correctness via grpcurl; the reflection
`list`/`describe` probe; a one-shot re-run of `mvn test` and `pytest`, both
green; and `ghz`'s loose bounds. The build-stage gate itself was confirmed
to bite by seeding a failing assertion in each suite (`9999.99` instead of
`3001.25`), re-running `docker build`, observing the build fail with the
assertion diff in the log, then reverting. The highest-risk things a
reader's own run should confirm: that the `@GrpcClient`
no-configuration-needed self-wiring and the `grpc.aio` ephemeral-port
pattern continue to resolve identically on a future point release of
`quarkus-grpc` or `grpcio`, and that `grpcio-reflection`'s method-symbol
limitation documented above hasn't changed upstream.
