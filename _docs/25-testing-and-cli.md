---
title: "Testing and the CLI"
order: 25
part: "Testing & Debugging"
description: "grpcurl, grpcui, Insomnia and Yaak, server reflection, QuarkusTest, pytest, and load testing with ghz."
duration: 26 minutes
---

## Learning objectives

By the end of this chapter you can:

- Place in-process (`@QuarkusTest`/pytest), integration (`verify.sh` + `grpcurl`), load (`ghz`), and manual exploration (`grpcui`/Insomnia/Yaak) testing correctly on the gRPC test pyramid.
- Use gRPC server reflection to `list`/`describe` a service with `grpcurl`, and explain why Python's `grpcio-reflection` can resolve a service symbol but not an individual method symbol.
- Build an in-process `grpc.aio` test fixture on an OS-assigned ephemeral port after ruling out `grpc_testing` for lacking asyncio support.
- Wire a build-stage test gate (`mvn verify`; `pytest` with no skip flag) that actually fails `docker build`, and prove it by seeding a wrong assertion and watching it fail.
- Run `ghz` against `GetQuote` and assert loose, relative throughput/latency bounds instead of hardware-specific absolutes.

## Why this matters

Every chapter so far has proven its claims the same way this book proves
its own: `verify.sh` builds a container, calls it over the wire, and checks
the fields that come back. That script is itself a kind of test suite, and
this chapter turns around and asks what it is: unit test,
integration test, load test, or something else, and where each of
grpcurl, grpcui, Insomnia, Yaak, `@QuarkusTest`, pytest, and `ghz` fits.
`RoutingService.GetQuote` is the vehicle again, unchanged from Chapter 7: no
new RPC, no contract change, because testing strategy is not a schema
problem any more than performance tuning was.

The code is in `examples/25-testing-and-cli/`. The run script there
(`verify.sh`) builds and starts both stacks, re-runs each stack's
in-process test suite one-shot, probes reflection the way grpcui would, and
drives a real `ghz` load-test run; its `README.md` covers what it does and
how to drive it by hand.

{% include excalidraw.html file="25-grpc-test-pyramid" alt="A four-layer stack labeled, from bottom to top, Unit and in-process, Integration, Load, and Manual exploration. The bottom Unit and in-process band holds two boxes, Quarkus with AtQuarkusTest plus AtGrpcClient and build-stage mvn verify, and Python with pytest plus an in-process grpc.aio server and build-stage pytest, both marked CI-gated. The Integration band holds one box, verify.sh against the running container with grpcurl semantic asserts, marked CI-gated. The Load band holds one box, ghz pinned one-shot load test with loose bounds, marked CI-gated. The top Manual exploration band holds two boxes side by side, grpcurl list and describe marked CI-gated, and grpcui, Insomnia, and Yaak marked illustrative only. Amber arrows connect each band to the one above it." caption="Figure 25.1: The gRPC test pyramid for this chapter: three CI-gated layers underneath a top layer that splits between a CI-gated CLI probe and illustrative GUIs." %}

## The shape of this chapter's test pyramid

The classic test pyramid (many fast unit tests, fewer integration tests,
fewer still end-to-end tests) maps onto gRPC almost without translation,
because gRPC gives each layer a natural tool. At the base sit
**in-process** tests: no container, no network socket a kernel has to set
up, just a servicer class instantiated directly in the test process and
called like any other object. One layer up are **integration** tests: a
real container, a real TCP connection, a real serialized-and-deserialized
request and response, which is `verify.sh`'s whole job in every earlier chapter.
Above that is **load** testing: the same RPC, called hundreds or thousands
of times concurrently, to characterize latency and throughput rather than
correctness. At the top is **manual exploration**: a human (or a script
standing in for one) poking at a running service with a general-purpose
tool, not a fixed suite of assertions.

What makes this chapter's version of the pyramid worth drawing explicitly
is that the top layer splits in two. `grpcurl`'s `list` and `describe`
commands are deterministic and scriptable. They can run in CI and fail a
build exactly like any other assertion, which is exactly what this
chapter's `verify.sh` does with them. `grpcui`, Insomnia, and Yaak cannot:
they are a browser tab and two desktop applications respectively, built for
a human to click through, and no CI runner this book targets can launch a
GUI, screenshot it, and assert on the result. They are illustrative in this
book for a mechanical reason, not because they are less useful. Plenty of
engineers reach for `grpcui` or Insomnia before they reach for `grpcurl`,
precisely because clicking through a service's shape beats memorizing its
JSON. The three sections below work through what each layer of this
pyramid is, starting from the bottom, where the actual gate for this
chapter's example lives.

## grpcurl, grpcui, Insomnia, and Yaak: one mechanism, four doors

All four of these tools exist to solve the same problem: calling a gRPC
service without hand-writing a typed client first. Without server
reflection, that problem has no general solution: a gRPC wire message is
a sequence of varint-tagged, length-prefixed bytes with no field names and
no self-describing schema, so a generic client has nothing to parse a
response into unless it already knows the `.proto`. **Server reflection**
(`grpc.reflection.v1alpha.ServerReflection`, a second gRPC service every
server in this chapter also exposes) closes that gap: a client can ask the
server, over the same gRPC connection, for the full set of service and
message descriptors it needs, then use those descriptors to encode a
request and decode a response on the fly. Every tool this chapter names
rides that exact mechanism:

- **`grpcurl`** is this book's workhorse from Chapter 0 onward: a
  command-line tool that uses reflection (or a local `.proto`/protoset, if
  reflection is off) to `list` services, `describe` a service or message,
  and make a call with JSON in, JSON out. It is deterministic, scriptable,
  and exits non-zero on failure, which is exactly what a CI gate needs.
- **`grpcui`** is `grpcurl`'s browser-based sibling, from the same
  maintainer and project family: point it at a reflection-enabled server
  and it renders a form for every RPC, pre-populated with the message
  shape reflection reports, so a human can fill in fields and fire a call
  without writing any JSON by hand. It is the fastest way to explore a
  service interactively, and the reason this chapter cannot assert on it
  in CI: there is no headless way to click a web form and read back what
  rendered.
- **Insomnia** and **Yaak** are general-purpose API clients: originally
  REST-focused tools that have grown native gRPC support, including
  reflection-driven service discovery, method selection, and a
  request-builder UI very similar to `grpcui`'s. Where `grpcui` is
  spun up ad hoc against one server, Insomnia and Yaak are desktop
  applications a team keeps installed and uses to maintain a library of
  saved requests across many services, closer to how teams already use
  them for REST APIs, now extended to gRPC's reflection-discoverable
  shape.

The throughline: reflection is the shared substrate, and the four tools are
four different front ends onto the identical descriptor data. `grpcurl`
happens to be the one with a stable, parseable, scriptable interface, so it
is this chapter's deterministic stand-in for what a human would otherwise
do by hand in `grpcui`, Insomnia, or Yaak. Figure 25.2 draws that fan-out
explicitly.

{% include excalidraw.html file="25-reflection-probe-landscape" alt="A box labeled RoutingService with GetQuote and four other stubs sends an arrow labeled descriptors into a box labeled grpc.reflection.v1alpha ServerReflection, with enable-reflection-service=true noted beneath it. From the reflection box, four arrows fan out to four boxes on the right: grpcurl, labeled list / describe, CI-gated, connected by an amber arrow labeled list/describe; and grpcui, Insomnia, and Yaak, each labeled illustrative only, connected by plain gray arrows. A caption below reads: one reflection service, four clients; only the CLI path is asserted in verify.sh." caption="Figure 25.2: One reflection service feeds grpcurl, grpcui, Insomnia, and Yaak identically; only the grpcurl path is deterministic enough to assert in CI." %}

Both stacks in this chapter's example turn reflection on explicitly: it
is not something either one leaves at a framework default, because the
defaults disagree. Quarkus's `quarkus-grpc` extension enables reflection
automatically in dev mode but **not** in a packaged application, so this
chapter's `application.properties` sets
`quarkus.grpc.server.enable-reflection-service=true` to keep it on inside
the container `verify.sh` builds and runs, confirmed directly against the
Quarkus gRPC guide for the pinned 3.40.1 release.
Python's `grpcio-reflection` package has no such on/off switch tied to a
dev/prod distinction; `app/main.py` calls
`reflection.enable_server_reflection(service_names, server)` once, at
startup, and it is simply on from then on. One real, worth-documenting
difference surfaced while building this chapter's example: `grpcurl
describe shipping.routing.v1.RoutingService.GetQuote` (describing a
specific **method** symbol) resolves against the Quarkus server but fails
against the Python one with `Symbol not found`. grpc-java's reflection
implementation walks a symbol like `Service.Method` down to the individual
RPC; Python's `grpcio-reflection` only indexes top-level symbols (service
names, message types, enum types) and has nothing registered for an
individual method. Describing the **service** itself
(`shipping.routing.v1.RoutingService`) works identically on both and
already prints every RPC's full signature, so `verify.sh` describes the
service rather than the method, a small accommodation for a real
cross-stack quirk and not a workaround for a bug in this chapter's code.

## `@QuarkusTest` and pytest: the base of the pyramid, and the actual gate

The most important layer of this chapter's pyramid is also the one with
the least ceremony: an in-process test that instantiates the servicer
class directly and calls a method on it, the same way any other unit test
calls a method on any other object. No container, no Docker network, no
TCP port a kernel has to bind, which is also why it is the fastest layer
by a wide margin and the one every other layer builds on.

**Quarkus's `@QuarkusTest`** does something more ambitious than a plain
JUnit test: it boots the entire application (CDI container, configuration,
and the real gRPC server this chapter's `application.properties` wires up
on its own port) inside the test JVM. `@GrpcClient` then injects a client
typed to the same generated `RoutingService` interface
`RoutingServiceImpl` implements, and that client needs **no explicit
host or port configuration** to find the test server: this is the exact
behavior documented in the Quarkus gRPC guide's "Testing your services"
section ("in the case of using a client to test an exposed service that
does not use TLS, there is no need to provide any configuration"),
re-confirmed against the installed `quarkus-grpc` 3.40.1 package while
writing this chapter rather than assumed from an older guide. The result
reads almost like calling a local method:

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
        assertEquals("rte_USNYC-NLRTM", response.getRoute().getId(), "route.id");
    }
}
```

**Python has no equivalent in-process test harness built into `grpcio`
itself**, and the obvious-looking candidate, `grpc_testing` (the stdlib's
fake-channel testing module), turns out to be the wrong tool for this
specific job: its fake channel has no `asyncio` support, and this book's
Python stack is built on `grpc.aio` end to end, so a `grpc_testing` test
could never exercise the real async servicer this chapter's server runs.
The fix is simpler than it sounds: start a **real** `grpc.aio.server()`,
bound to an OS-assigned ephemeral port (`add_insecure_port("127.0.0.1:0")`,
where the trailing `:0` tells the kernel to pick any free port), wired with
the exact same `RoutingServiceServicer` class the container runs, and drive
it with a real `grpc.aio` channel:

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

The fixture's `finally` block matters as much as its happy path: closing
the channel and stopping the server after every test means a second test
function gets a fresh server on a fresh ephemeral port, rather than two
tests racing to share one. `pytest-asyncio`'s `@pytest.mark.asyncio`
decorator is what lets `pytest` (which has no native concept of an
`async def` test function) await one correctly instead of silently
skipping it; without the plugin and the marker, an `async def test_...`
function would "pass" by never actually running its body, a far worse
failure mode than a loud error.

**The gate is where this stops being a testing exercise and becomes a
build-time contract.** Both Containerfiles run their test suite inside the
image's build stage, unconditionally: Quarkus's runs `mvn verify` (not
`mvn package -DskipTests`, which every earlier chapter's Containerfile
used, since there was no test suite yet to skip), and Python's runs
`.venv/bin/python -m pytest tests -q`. A failing assertion in either one
makes that `RUN` instruction exit non-zero, which fails `docker build`,
which fails `docker compose up --build`, which fails `verify.sh`: the
broken image is never produced, and no later layer of the pyramid ever
gets a chance to run against it. "Build, run, observe" below describes
proving that this actually happens, not just asserting that it should.

## ghz: the load layer, fed the proto directly

`ghz` is the same load-testing tool Chapter 18 introduced for raising and
measuring performance levers; this chapter reuses its exact pinned image
and invocation pattern because the load layer of a test pyramid is the
same tool whether the question is "is this fast enough" (Chapter 18) or
"does this still work under load" (this chapter's narrower use). `ghz` has
no reflection client of its own, unlike every CLI/GUI tool in the section
above: it needs either a compiled `.proto` or a protoset on disk for every
run, so this chapter's `compose.yaml` mounts `contracts/proto/` read-only
into a dedicated, profiled-off `ghz` service exactly the way Chapter 18's
did:

```bash
docker compose run --rm ghz --insecure \
  --proto /contracts/shipping/routing/v1/routing.proto --import-paths /contracts \
  --call shipping.routing.v1.RoutingService.GetQuote \
  -d '{...}' -c 10 -n 300 -O json quarkus:9000
```

`verify.sh` parses the `-O json` output with `python3 -I` and asserts three
things, all loose and relative, the same philosophy Chapter 18 established:
the error count sums to zero, the 99th-percentile latency is under a
generous ceiling, and requests-per-second clears a low floor. Loose bounds
reflect a specific design reason: a tight absolute number baked into `verify.sh`
would be a number about this specific machine on this specific day, and
would make the test flaky on any CI runner slower or more contended than
the authoring box. A real run against this chapter's lean `GetQuote`
landed roughly 1,868 requests per second at a 12-millisecond p99 for
Quarkus, and roughly 4,094 requests per second at a 4-millisecond p99 for
Python, both comfortably inside the loose bounds `verify.sh`
checks, and neither number is hardcoded anywhere a future, slower run could
trip over it.

## How the code works

**The server implementations are the smallest version of this book's
recurring `GetQuote` anchor.** Both `RoutingServiceImpl.java` and
`app/routing_service.py` compute `quote.amount =
round_half_up(sum(cargo[].weight_kg) * 2.50, 2)`, build a single `MAERSK`
leg, and derive `route.id` from the two UN/LOCODEs, byte-for-byte the same
formula Chapter 7 shipped. The reason to keep it this small is that this
chapter's point is entirely about what wraps around the implementation
(the test suite, the build-stage gate, the reflection surface), and a
simpler implementation means every reader's attention goes to what
this chapter teaches rather than to tracing a more elaborate
quote calculation.

**On the Quarkus side, every RPC needs a body because `RoutingService` is
a generated Java *interface*, not an abstract base class.** This is a real
difference from the generated code grpc-java itself would produce for a
non-Quarkus project, where a `*ImplBase` class ships default
`UNIMPLEMENTED` bodies for every method and a subclass only has to override
the ones it cares about. `quarkus-grpc`'s Mutiny code generator instead
produces a plain interface, so `RoutingServiceImpl implements
RoutingService` fails to compile unless every one of the five methods has a
body: `findOptimalRoute`, `listRoutes`, `recomputeRoutes`, and
`negotiateRoute` each return a `Uni`/`Multi` that immediately fails with a
hand-built `Status.UNIMPLEMENTED` exception, carrying a description naming
which later chapter implements it. On the Python side, the
generated `routing_pb2_grpc.RoutingServiceServicer` base class already
handles this: any method a subclass doesn't override raises
`UNIMPLEMENTED` on its own, so `app/routing_service.py` has nothing to
write for the other four RPCs at all. Same contract, same five RPCs, two
different generated-code shapes, and a reader relying on
"whatever the other stack does, this one will too" would be caught out by
exactly this difference.

**The test re-run services in `compose.yaml` need their own Containerfile
stage, not just a different command.** The straightforward design, pointing
a `docker compose run` service at the same final image and overriding its
entrypoint to invoke `mvn test` or `pytest` again, does not work, because
by the time either Containerfile's final stage exists, the test
dependencies have already been stripped out: Python's build stage ends
with `rm -rf .venv && uv sync --no-dev`, specifically to keep
`pytest`/`pytest-asyncio`/`grpcio-tools` out of the runtime image, and the
Quarkus runtime stage never had Maven or the test sources in the first
place: only the packaged jar survives the `COPY --from=build`. The fix is
a dedicated intermediate stage: Python's Containerfile now ends its `build`
stage right after the `pytest` run, and moves the dependency trim into a
**separate** `trimmed` stage the runtime image copies from instead:
`compose.yaml`'s `python-tests` service targets `build` directly
(`target: build`), where pytest is still installed and `tests/` is still
present, so a fresh `docker compose run --build python-tests` re-invokes
the identical suite the image build already gated on. Quarkus needs no
equivalent restructuring, because `mvn test` only needs the source tree and
`pom.xml` that are already present at the `build` stage before packaging
ever happens.

**The reflection probe in `verify.sh` targets the service, not the
method**, for the cross-stack reason the earlier section on
grpcurl/grpcui/Insomnia/Yaak documents in full: Python's `grpcio-reflection`
has no entry for an individual RPC's symbol, only for the service, message,
and enum types it belongs to. Describing
`shipping.routing.v1.RoutingService` prints every RPC's complete signature
on both stacks identically, which is what `verify.sh` actually asserts
against (`rpc GetQuote`, `GetQuoteRequest`, `GetQuoteResponse` all appear in
that one `describe` call's output).

## Build, run, observe

```bash
cd examples/25-testing-and-cli && ./verify.sh
```

`verify.sh` brings both services up with `docker compose` (at which point
each image's build-stage test gate has already run once, inside
`docker build`, as a side effect of the image existing at all), then calls
`GetQuote` via `grpcurl` and asserts field semantics, probes reflection's
`list`/`describe` the way `grpcui` would, re-runs each stack's in-process
suite one more time via `docker compose run --build` so a fresh pass/fail
lands directly in `verify.sh`'s own log, and finally runs `ghz` against
`GetQuote` on both stacks and asserts its loose bounds. Expect `PASS` once
every assertion holds for both stacks.

**Proving the gate bites, by watching it block a bad build:**
while authoring this chapter, `RoutingServiceTest.java`'s amount assertion
was changed from `"3001.25"` to `"9999.99"` and `docker build -f
examples/25-testing-and-cli/quarkus/Containerfile .` was re-run by hand.
The build failed, with Surefire's own diff in the log:
`org.opentest4j.AssertionFailedError: quote.amount ==> expected: <9999.99>
but was: <3001.25>`, followed by `BUILD FAILURE` and a non-zero
`docker build` exit code; no image was produced. The same experiment was
repeated on the Python side: `tests/test_routing_service.py`'s assertion
was changed the same way, `docker build -f
examples/25-testing-and-cli/python/Containerfile .` was re-run, and it
failed with pytest's own diff (`assert '3001.25' == '9999.99'`) followed by
`ERROR: process "/bin/sh -c .venv/bin/python -m pytest tests -q" did not
complete successfully: exit code: 1`. Both edits were reverted immediately
afterward, and a full `verify.sh` run confirmed green again on both stacks
before this chapter was written up. The lesson generalizes past this one
assertion: a build-stage test is only a gate if the thing it tests for
failing actually prevents the artifact from existing, and the only way to
be sure of that is to make it fail once and watch.

## Cross-check

Reflection gives an independent way to confirm the same claim `verify.sh`
already checks mechanically: run `grpcurl -plaintext localhost:9250
describe shipping.routing.v1.RoutingService` by hand and read the printed
`GetQuote` signature against `contracts/proto/shipping/routing/v1/routing.proto`
directly: the request and response message names, and every field inside
them, should match exactly, because reflection is reporting the server's
own compiled descriptors, not a hand-maintained copy of the contract that
could have drifted. Agreement between what a human reads from `grpcurl`'s
output and what the `.proto` file itself says is a stronger confirmation
that reflection is wired correctly than any single automated assertion,
because it rules out the specific failure mode where reflection is
*technically* on but reporting stale or partial descriptors.

<div class="callout callout--safe"><p class="callout__title">Decision</p><p>Put the cheapest, fastest layer of the pyramid in the build gate, not the slowest. An in-process test (<code>@QuarkusTest</code> + <code>@GrpcClient</code>, or a real <code>grpc.aio</code> server on an ephemeral port) runs in milliseconds and needs no network, no container, and no external process, which is exactly why it belongs where a red result has to block an artifact from being produced: a build-stage gate that took minutes per run would get skipped under deadline pressure, and a gate that gets skipped is not a gate. Reserve <code>verify.sh</code>'s own grpcurl assertions for integration-level claims that only a real container and a real socket can prove (reflection being reachable, TLS negotiating, a port being bound) rather than re-deriving correctness claims the in-process suite already covers. Reach for the CLI (<code>grpcurl</code>) whenever a check needs to run unattended and assert a specific outcome, whether in a script, in CI, or in <code>verify.sh</code> itself; reach for a GUI (<code>grpcui</code>, Insomnia, Yaak) when a human is exploring an unfamiliar service interactively and the goal is understanding its shape, not asserting against it.</p></div>

## What you learned

- A gRPC-service test pyramid has a natural shape: in-process servicer
  tests at the base (fast, no network), `verify.sh`-style integration
  tests against a real container above that, `ghz` load tests above that,
  and manual exploration at the top, where the top layer itself splits
  between a deterministic CLI probe (`grpcurl`, CI-gated) and illustrative
  GUIs (`grpcui`, Insomnia, Yaak) that need a human to drive them.
- A build-stage test gate (`mvn verify` instead of `-DskipTests`; `pytest`
  with no skip flag) is only as real as its failure mode: proving it by
  seeding a wrong assertion and watching `docker build` fail is the
  difference between a gate that is asserted to work and one that is shown
  to.
- Server reflection is the one mechanism every CLI and GUI client in this
  chapter rides, but implementations differ in what they expose: Python's
  `grpcio-reflection` resolves services, messages, and enums but not
  individual RPC method symbols, a real cross-stack quirk this chapter's
  `verify.sh` works around by describing the service rather than the
  method.

Chapter 26 turns from proving a service works to diagnosing one that
doesn't: reproducing `UNIMPLEMENTED`, `DEADLINE_EXCEEDED`,
`UNAVAILABLE`, and a TLS handshake failure, and reading what
reflection, `channelz`, and `GRPC_TRACE` each reveal about why.

## On the wire

```bash
grpcurl -plaintext localhost:9250 list
```

```
grpc.reflection.v1alpha.ServerReflection
shipping.routing.v1.RoutingService
```

```bash
grpcurl -plaintext localhost:9250 describe shipping.routing.v1.RoutingService
```

```
shipping.routing.v1.RoutingService is a service:
service RoutingService {
  rpc FindOptimalRoute ( .shipping.routing.v1.FindOptimalRouteRequest ) returns ( .shipping.routing.v1.FindOptimalRouteResponse );
  rpc GetQuote ( .shipping.routing.v1.GetQuoteRequest ) returns ( .shipping.routing.v1.GetQuoteResponse );
  rpc ListRoutes ( .shipping.routing.v1.ListRoutesRequest ) returns ( .shipping.routing.v1.ListRoutesResponse );
  rpc NegotiateRoute ( stream .shipping.routing.v1.NegotiateRouteRequest ) returns ( stream .shipping.routing.v1.NegotiateRouteResponse );
  rpc RecomputeRoutes ( .shipping.routing.v1.RecomputeRoutesRequest ) returns ( .shipping.routing.v1.RecomputeRoutesResponse );
}
```

A real `ghz` run against `GetQuote` (`-c 10 -n 300`):

```
Quarkus — Count: 300   RPS: 1867.8   p99 Latency: 11.9ms   Error count: 0
Python  — Count: 300   RPS: 3256.4   p99 Latency: 4.7ms    Error count: 0
```

And the model `verify.sh` itself follows: start a real container for the
system under test, make the narrowest claim
that still proves the point (a specific field value, not merely a
non-error status), prefer loose relative bounds over tight absolutes for
anything timing- or throughput-related, and treat a script's own exit code
as the pass/fail signal everything else (a chapter's prose, a reader's own
run, a CI pipeline) ultimately defers to.

---

## For deeper coverage

- Cloud Native Design Patterns, the "Appendix O: API Testing with Newman" chapter, for the same CLI-driven, CI-gated API testing philosophy applied to REST collections.
- [`grpcurl`](https://github.com/fullstorydev/grpcurl) and [`grpcui`](https://github.com/fullstorydev/grpcui): the reflection-driven CLI and GUI tools this chapter's test pyramid names.
- [`ghz`](https://ghz.sh/): the gRPC benchmarking/load-testing tool behind this chapter's load layer.
- [Quarkus: gRPC guide](https://quarkus.io/guides/grpc), including its "Testing your services" section on `@QuarkusTest` + `@GrpcClient` self-wiring.
