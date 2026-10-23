// deck.js — "API Patterns & Practices: gRPC — Python / grpcio Implementation".
// How the gRPC patterns are built in Python: grpc.aio, generated *_pb2 stubs,
// async generators for streaming, interceptors, PyJWT, OpenTelemetry, and the
// uv-managed toolchain. Real code from examples/*/python/** — shipping/cargo
// domain, one Protobuf contract shared with the Quarkus sibling stack.
//
// Build:  export NODE_PATH="$(cd ../_shared/node_modules && pwd)" && node deck.js

"use strict";

const path = require("path");
const SHARED = path.resolve(__dirname, "../_shared");
process.env.DECK_ASSETS = `${SHARED}/assets`;
process.env.DECK_PNG = `${SHARED}/png`;

const H = require(`${SHARED}/deck-helpers.js`);
const {
  COLOR, FONT, W, ASSETS,
  newDeck, addFooter, addContentTitle, addBullets, addTwoColBullets,
  addCaption, addPerfCallout, addCodeSlide, addDiagramSlide, addLangChip,
  addSectionDivider, addNotes,
} = H;

const OUT = path.resolve(__dirname, "api-patterns-grpc-python-r1.1.pptx");
const REV = "r1.1";
const LANG = "python · grpc.aio";

const pres = newDeck();
pres.title = "API Patterns & Practices: gRPC, Python / grpcio Implementation";
let pageNum = 0;

function S() { const s = pres.addSlide(); pageNum += 1; addFooter(s, pageNum); return s; }
function divider(code, title, subtitle, notes) {
  const s = pres.addSlide(); pageNum += 1; addSectionDivider(s, code, title, subtitle); addNotes(s, notes);
}

/* ======================= 1 · COVER ======================= */
{
  const s = pres.addSlide();
  pageNum += 1;
  s.background = { color: COLOR.white };
  try { s.addImage({ path: `${ASSETS}/cover-panel.png`, x: 0, y: 0, w: W, h: 7.5 }); } catch (e) {}
  s.addText("API PATTERNS & PRACTICES · GRPC", { x: 6.00, y: 1.82, w: 6.90, h: 0.34,
    fontFace: FONT.title, fontSize: 14, bold: true, color: COLOR.red, charSpacing: 6, align: "left", valign: "middle" });
  s.addText([{ text: "The Python /", options: { breakLine: true } }, { text: "grpcio build." }], {
    x: 5.95, y: 2.28, w: 6.95, h: 2.00, fontFace: FONT.title, fontSize: 48, bold: true, color: COLOR.ink, align: "left", valign: "top" });
  s.addText("Every gRPC pattern from the concepts deck, built in Python: grpc.aio servicers, generated Protobuf stubs, async-generator streaming, interceptor chains, PyJWT, and OpenTelemetry. All in the shipping & cargo domain, against one Protobuf contract shared with the Quarkus stack.", {
    x: 6.00, y: 4.22, w: 6.80, h: 1.45, fontFace: FONT.body, fontSize: 16, italic: true, color: COLOR.caption, align: "left", valign: "top" });
  s.addText([
    { text: "Robert Sedor", options: { bold: true, color: COLOR.ink, breakLine: true } },
    { text: "Principal Chief Architect, Application Development", options: { color: COLOR.caption } },
  ], { x: 6.00, y: 5.75, w: 6.70, h: 0.80, fontFace: FONT.body, fontSize: 15, align: "left", valign: "top" });
  s.addText(REV, { x: 11.85, y: 6.40, w: 0.95, h: 0.30, fontFace: FONT.mono, fontSize: 11, color: COLOR.caption, align: "right", valign: "middle" });
  try { s.addImage({ path: `${ASSETS}/logo-candidate-2.png`, x: 11.10, y: 6.80, w: 1.55, h: 0.37 }); } catch (e) {}
  addNotes(s, "Welcome to the Python and grpcio implementation deck in the API Patterns & Practices: gRPC series. The concepts deck established the patterns and the reasoning, stack-agnostic; the Quarkus sibling deck shows one implementation; this deck shows the other, in Python, against the same single Protobuf contract and the same shipping and cargo domain. Everything on these slides is real code from the runnable examples under examples star slash python. Python's defining shape for gRPC is grpc.aio: one asyncio event loop, generated servicer base classes, and async generators standing in for every streaming direction: no callback registration, no reactive operator chains, just async def and yield. That shape underlies deadlines, cancellation, backpressure, and the GIL caveat that this deck spends real time on, so we build up to it chapter by chapter. I'm Robert Sedor. By the end you'll have seen grpc.aio servicers and stubs, generated Protobuf and well-known-type usage, all three streaming shapes, interceptor-based auth and metrics, PyJWT scope checks, mTLS server credentials, the demand-driven async generator that makes backpressure free, and the pytest-asyncio in-process test fixture that gates every build.");
}

/* ======================= 2 · AGENDA ======================= */
{
  const s = S();
  addContentTitle(s, "ROADMAP", "Agenda");
  addTwoColBullets(s,
    [
      "Setup & codegen: uv, grpcio-tools, buf generate",
      "Generated Protobuf & well-known types in Python",
      "The unary RPC: grpc.aio servicer and stub",
      "Server, client & bidirectional streaming",
      "Deadlines, cancellation, rich errors & interceptors",
      "Schema design, FieldMask, pagination & evolution",
    ],
    [
      "Concurrency: grpc.aio, to_thread, and the GIL",
      "Async operations: poll, watch, cancel",
      "Streaming at scale, keepalive & performance",
      "TLS/mTLS, PyJWT authn/authz, observability",
      "Load balancing, grpc-web transcoding",
      "Testing, debugging, the Final Project, wrap-up",
    ],
    { fontSize: 15 });
  addNotes(s, "The arc follows the same pattern order as the concepts deck and the Quarkus deck, so all three map one to one; every stop here is Python code. We open with the toolchain: uv for dependency management, grpcio-tools for stub generation, and how that fits the contract-first buf workflow. Then generated Protobuf and well-known-type usage, the unary RPC shape, and all three streaming directions as async generators. The middle covers deadlines and cancellation propagation, the rich google.rpc.Status error model, interceptors, schema evolution with FieldMask and pagination, and the chapter this deck spends the most time on: concurrency, where Python's single event loop and the GIL change the rules from the JVM. Then async long-running operations, streaming at scale and performance tuning, security (TLS, mTLS, PyJWT), and observability. We close with load balancing on a real cluster, grpc-web transcoding, testing, debugging, and the Final Project that assembles every pattern into one mTLS-secured service. An extensive appendix carries full file listings and extra code variants. Speaker notes on every slide, appendix included.");
}

/* ======================= 3 · SERIES MAP ======================= */
{
  const s = S();
  addContentTitle(s, "SERIES MAP", "Where this deck sits");
  addBullets(s, [
    "The concepts deck is the patterns and the why, stack-agnostic: start there for the reasoning.",
    "This deck is the Python how: the same shipping/cargo contract realized in grpc.aio, with real code.",
    "The Quarkus sibling deck does the identical arc on the JVM; both are validated against the one Protobuf contract in CI.",
    "Code shown here is lifted from examples/*/python/**; Python 3.14, grpcio, protobuf, uv-managed, UBI 10 base images.",
  ], { fontSize: 17 });
  addCaption(s, "Same patterns, same domain, same contract: this deck is the Python realization of them.");
  addNotes(s, "The same orientation as the Quarkus deck. The concepts deck carries the patterns and the reasoning, stack-agnostic: that's where the why lives. This deck is the Python how: each pattern realized in grpc.aio code against the same shipping and cargo contract and domain. The Quarkus sibling deck walks the identical arc on the JVM, and the reason both exist is that the two are validated against the one Protobuf contract in CI, so a client can't tell which stack answered a given call. Every code sample here runs, from examples slash star slash python, on pinned versions: Python 3.14, grpcio, protobuf, uv for dependency management, UBI 10 base images. A useful way to watch this deck: notice how often the Python code reaches the identical wire contract as the Quarkus code by a completely different route: async generators instead of Mutiny Multi, interceptor continuation-and-wrap instead of a CDI interceptor bean. That byte-for-byte parity is exactly what the shared .proto and the shared verify.sh scripts enforce.");
}

/* ======================= DIVIDER 01 · SETUP & CODEGEN ======================= */
divider("01", "Setup & codegen",
  "uv for dependencies, grpcio-tools for stubs, buf for the contract-first gate.",
  "Before any servicer code runs, the Python side needs generated stubs on its import path. uv manages the dependency set declaratively; grpcio-tools compiles the shared .proto files into the shipping.* packages the app imports; buf lint and buf breaking gate the contract itself in CI, independent of either stack's build. This section walks the toolchain end to end, then every later section assumes it.");

{
  const s = S();
  addCodeSlide(s, "SETUP", "uv-managed dependencies", LANG,
    [
      "[project]",
      "name = \"shipping-python-ch05-routing\"",
      "requires-python = \">=3.14\"",
      "dependencies = [",
      "    \"grpcio>=1.75,<2\",",
      "    \"grpcio-reflection>=1.75,<2\",",
      "    \"protobuf>=5,<7\",",
      "    \"opentelemetry-distro>=0.50b0\",",
      "    \"opentelemetry-exporter-otlp-proto-grpc>=1.29\",",
      "    \"opentelemetry-instrumentation-grpc>=0.50b0\",",
      "]",
      "",
      "# grpcio-tools is build-time only (generates stubs from contracts/proto/ —",
      "# see Containerfile); the runtime image never needs it.",
      "[dependency-groups]",
      "dev = [",
      "    \"grpcio-tools>=1.75,<2\",",
      "]",
    ],
    "examples/05-contract-first/python/pyproject.toml: grpcio-tools lives in a dev group, never shipped at runtime.",
    { fontSize: 12 });
  addNotes(s, "Every Python example in this book is a uv project: one pyproject.toml, pinned dependency ranges, no requirements.txt. The runtime set is small: grpcio, grpcio-reflection, protobuf, and the OpenTelemetry zero-code auto-instrumentation packages. grpcio-tools, the package that actually compiles .proto files into Python, lives in a separate dev dependency group: it's needed to generate the stubs during the container build, but the runtime image never needs a protoc binary once those generated files exist. That split keeps the production image smaller and keeps a build-time tool out of the attack surface of a running service. uv sync pulls the right set depending on whether --group dev is passed, which is exactly how the Containerfile's two build stages differ.");
}

{
  const s = S();
  addCodeSlide(s, "SETUP", "Generating stubs at build time", LANG,
    [
      "COPY contracts/proto/shipping/type/v1/types.proto ./proto/shipping/type/v1/types.proto",
      "COPY contracts/proto/shipping/routing/v1/routing.proto ./proto/shipping/routing/v1/routing.proto",
      "RUN mkdir -p generated && \\",
      "    .venv/bin/python -m grpc_tools.protoc -I proto \\",
      "      --python_out=generated --grpc_python_out=generated \\",
      "      proto/shipping/type/v1/types.proto proto/shipping/routing/v1/routing.proto",
    ],
    "examples/05-contract-first/python/Containerfile: contracts/proto/ is the single source of truth; each image generates its own stubs.",
    { fontSize: 13 });
  addPerfCallout(s, "buf lint + buf breaking gate the contract itself in CI (contracts/buf.yaml), independent of either stack's build; the one upstream `buf generate` convenience config (contracts/buf.gen.yaml) documents a local-inspection path CI does not depend on.");
  addNotes(s, "The authoritative stub generation happens inside each stack's own build: there is no shared generated-code artifact checked in anywhere, and the root .gitignore enforces that (star star slash generated slash, star_pb2.py, star_pb2_grpc.py are all ignored). This Containerfile excerpt shows the Python side: copy only the two .proto files this particular service needs, preserving the package path routing.proto's import statement expects, then run python -m grpc_tools.protoc with both the --python_out and --grpc_python_out flags, which together emit routing_pb2.py and routing_pb2_grpc.py. The generated files land in a generated/ directory that's added to PYTHONPATH at runtime, sitting alongside app/ the same way a local, non-container protoc run would produce. Separately, contracts/buf.yaml configures buf lint with the STANDARD rule set and buf breaking against the whole file, which is what Chapter 14's evolution gate runs in CI; that gate fires before either stack's build ever starts, so a breaking contract change never gets as far as a Python or Java compile error.");
}

/* ======================= DIVIDER 02 · PROTOBUF & WKT ======================= */
divider("02", "Generated Protobuf & well-known types",
  "Messages become plain Python objects; Timestamp and FieldMask come from protobuf itself.",
  "Every message in the shared contract compiles to an ordinary Python class with typed attributes, nested message support, and a SerializeToString/ParseFromString pair. The well-known types (Timestamp, Duration, FieldMask, Any) ship inside the protobuf package itself, so using them costs no extra dependency beyond the grpcio/protobuf pair every example already needs.");

{
  const s = S();
  addDiagramSlide(s, "WELL-KNOWN TYPES", "From .proto to Python objects",
    "04-wellknown-json-mapping",
    "google.protobuf.Timestamp and Money round-trip through Python the same way they round-trip through JSON: one canonical shape, two languages.");
  addNotes(s, "The well-known types solve a problem every schema eventually hits: dates, durations, arbitrary-typed fields, and sparse field selections all need a canonical representation that isn't bespoke per service. google.protobuf.Timestamp is the one used most in this book: it's a message with two int64 fields, seconds and nanos, but the generated Python class adds FromDatetime and ToJsonString helper methods that hide that representation entirely. The diagram shows the same mapping this deck's code slide proves: a Python datetime goes in, an RFC 3339 string comes out on the wire as JSON, and the reverse holds for a client. Money, by contrast, is this contract's own message, not a well-known type, modeled with a decimal-string amount field rather than a binary float, so currency arithmetic never silently loses precision the way IEEE 754 would.");
}

{
  const s = S();
  addCodeSlide(s, "WELL-KNOWN TYPES", "Timestamp.FromDatetime, Money as decimal string", LANG,
    [
      "from google.protobuf import timestamp_pb2",
      "from shipping.type.v1 import types_pb2",
      "",
      "def _to_timestamp(when: datetime) -> timestamp_pb2.Timestamp:",
      "    # google.protobuf.timestamp_pb2 ships inside the `protobuf` package",
      "    # itself (the compiled well-known-type module) — no extra dependency.",
      "    ts = timestamp_pb2.Timestamp()",
      "    ts.FromDatetime(when)",
      "    return ts",
      "",
      "def build_route(origin, destination) -> types_pb2.Route:",
      "    leg = types_pb2.Leg(",
      "        carrier=_CARRIER, origin=origin, destination=destination,",
      "        departs_at=_to_timestamp(_DEPARTS_AT),",
      "        arrives_at=_to_timestamp(_ARRIVES_AT),",
      "    )",
      "    # Money.amount is a decimal STRING, never a binary float.",
      "    price = types_pb2.Money(currency=\"USD\", amount=\"4200.00\")",
      "    return types_pb2.Route(id=f\"rte_{origin.un_locode}-{destination.un_locode}\", legs=[leg], price=price)",
    ],
    "examples/04-well-known-types/python/app/route.py: Timestamp via FromDatetime, Money as a decimal string by convention.",
    { fontSize: 11 });
  addNotes(s, "This is FindOptimalRoute's route-building helper. The Timestamp conversion is the whole point of this chapter's example: ts.FromDatetime takes an ordinary, timezone-aware Python datetime and does the seconds-and-nanos encoding for you: no manual epoch math, and ToJsonString on the way out (used in the servicer's log line, not shown here) produces the exact RFC 3339 string the chapter's 'On the wire' box asserts against. Money is the contrasting case: it's an ordinary message this contract defines, not a well-known type, and the amount field is typed as string specifically so '4200.00' is never coerced through a binary float, the same convention the sibling REST site's JSON Schema enforces, so a currency amount round-trips byte-for-byte across both protocol families. Both departs_at and arrives_at are fixed, deterministic instants here rather than 'now'; that's what lets verify.sh assert an exact expected timestamp instead of just checking that a call succeeded.");
}

/* ======================= DIVIDER 03 · UNARY RPC ======================= */
divider("03", "The unary RPC: servicer and stub",
  "One request, one response: a grpc.aio servicer method and a generated stub call.",
  "Every other RPC shape in this contract builds on the unary request/response pair GetQuote implements. A grpc.aio server registers one servicer instance per service; a client builds one stub from one reused channel and awaits each call. Everything from here forward is this same shape, generalized.");

{
  const s = S();
  addDiagramSlide(s, "UNARY RPC", "Stub to stub, over one channel",
    "07-unary-stub-to-stub",
    "A grpc.aio.Channel is built once and reused; the stub's GetQuote(request) is an ordinary awaitable.");
  addNotes(s, "The diagram shows the shape every unary call in this book follows: a client builds exactly one channel, wraps it in a generated stub class, and each call is just await stub.GetQuote(request), with no connection management visible at the call site, because the channel underneath already holds one long-lived HTTP/2 connection. On the server side, grpc.aio.server() is handed one or more servicer instances via the generated add_*Servicer_to_server registration function, and the event loop dispatches each inbound call to the matching coroutine method. Nothing here is Python-specific in shape (the Quarkus deck shows the identical diagram with a Mutiny Uni in place of the coroutine), but the mechanics on the next slide are.");
}

{
  const s = S();
  addCodeSlide(s, "UNARY RPC", "GetQuote: servicer and server startup", LANG,
    [
      "class RoutingServiceServicer(routing_pb2_grpc.RoutingServiceServicer):",
      "    async def GetQuote(",
      "        self, request: routing_pb2.GetQuoteRequest, context: grpc.aio.ServicerContext,",
      "    ) -> routing_pb2.GetQuoteResponse:",
      "        origin, destination = request.origin, request.destination",
      "        quote = compute_quote(request.cargo)",
      "        leg = types_pb2.Leg(carrier=_CARRIER, origin=origin, destination=destination)",
      "        route = types_pb2.Route(",
      "            id=f\"rte_{origin.un_locode}-{destination.un_locode}\", legs=[leg], price=quote,",
      "        )",
      "        return routing_pb2.GetQuoteResponse(quote=quote, route=route)",
      "",
      "async def serve() -> None:",
      "    server = grpc.aio.server()",
      "    routing_pb2_grpc.add_RoutingServiceServicer_to_server(RoutingServiceServicer(), server)",
      "    reflection.enable_server_reflection(service_names, server)",
      "    server.add_insecure_port(f\"{HOST}:{PORT}\")",
      "    await server.start()",
      "    await server.wait_for_termination()",
    ],
    "examples/05-contract-first/python/app/routing_service.py + app/main.py: the other four RoutingService methods answer UNIMPLEMENTED by default.",
    { fontSize: 11 });
  addNotes(s, "This is the anchor example the whole Python stack builds on. RoutingServiceServicer subclasses the generated routing_pb2_grpc.RoutingServiceServicer base class, which already implements every method in the service with a body that sets status UNIMPLEMENTED and raises, so overriding only GetQuote here is enough; grpcurl or any client sees UNIMPLEMENTED for the other four methods (FindOptimalRoute, ListRoutes, NegotiateRoute, RecomputeRoutes) with zero extra code, because the base class already handles that. Server startup is the same five lines in every chapter: build a grpc.aio.server(), register the servicer with the generated add_*_to_server function, enable reflection so grpcurl can list and describe the service without a local .proto copy, bind an insecure port, and await termination. Every later chapter's main.py is this same skeleton with one or two lines changed: TLS credentials, interceptors, or a second servicer.");
}

/* ======================= DIVIDER 04 · STREAMING ======================= */
divider("04", "Server, client & bidirectional streaming",
  "Async generators are the streaming contract: yield for out, async for for in.",
  "grpc.aio turns every streaming direction into ordinary async Python syntax: a server-streaming method is an async generator, a client-streaming method consumes an async iterator to exhaustion, and bidirectional streaming does both at once, independently. No separate reactive library is needed: the language's own async-generator protocol is the whole mechanism.");

{
  const s = S();
  addDiagramSlide(s, "STREAMING", "Three shapes, one HTTP/2 stream",
    "09-client-bidi-streaming",
    "Client streaming folds many requests into one response; bidirectional streaming interleaves both directions on the same stream.");
  addNotes(s, "One HTTP/2 stream carries every direction of streaming this contract defines: server streaming (Chapter 8's WatchShipment), client streaming, and bidirectional streaming (both in Chapter 9's TrackingService). The diagram shows the client-and-bidi case: ReportPositions reads the client's stream to exhaustion before answering once, while Sync reads and writes independently, responding to each inbound request as it arrives. Nothing about HTTP/2 itself requires the two directions of a bidirectional stream to be in lockstep; that's a choice each handler makes, not a protocol guarantee, and the code on the next two slides makes that choice explicit.");
}

{
  const s = S();
  addCodeSlide(s, "STREAMING", "Server streaming: WatchShipment", LANG,
    [
      "class TrackingServiceServicer(tracking_pb2_grpc.TrackingServiceServicer):",
      "    async def WatchShipment(",
      "        self,",
      "        request: tracking_pb2.WatchShipmentRequest,",
      "        context: grpc.aio.ServicerContext,",
      "    ) -> AsyncIterator[tracking_pb2.WatchShipmentResponse]:",
      "        logger.info(\"WatchShipment: opening stream for bookingId=%s\", request.booking_id)",
      "",
      "        # Each `yield` sends one WatchShipmentResponse as a DATA frame on the",
      "        # one HTTP/2 stream this call opened, in the order yielded; the",
      "        # async generator returning is what sends grpc.aio's half-close —",
      "        # no explicit \"end of stream\" call needed.",
      "        for event in sequence(request.booking_id):",
      "            yield tracking_pb2.WatchShipmentResponse(event=event)",
    ],
    "examples/08-server-streaming/python/app/tracking_service.py: an async generator is the entire server-streaming contract.",
    { fontSize: 13 });
  addNotes(s, "This is as small as server streaming gets, and that's the point: the method signature returns AsyncIterator instead of a single response, the body is an ordinary for loop, and yield is the only new vocabulary. Each yield sends exactly one DATA frame on the stream grpc.aio opened for this call, in the order yielded. When the generator returns (falling off the end of the loop), grpc.aio sends the half-close on the server's side automatically; there's no separate 'end of stream' call to remember, unlike some reactive APIs where you call onComplete explicitly. Chapter 17 revisits this exact method and turns the loop into a demand-driven async generator with an await between each yield, in the streaming-at-scale section later in this deck.");
}

{
  const s = S();
  addCodeSlide(s, "STREAMING", "Client streaming & bidirectional: ReportPositions, Sync", LANG,
    [
      "async def ReportPositions(self, request_iterator, context) -> tracking_pb2.ReportPositionsResponse:",
      "    # Client streaming: `async for` only ends when the client half-closes —",
      "    # folding every ReportPositionsRequest into a single count, then",
      "    # returns ONE response. Nothing is sent back until the stream ends.",
      "    accepted_count = 0",
      "    async for _ in request_iterator:",
      "        accepted_count += 1",
      "    return tracking_pb2.ReportPositionsResponse(accepted_count=accepted_count)",
      "",
      "async def Sync(self, request_iterator, context):",
      "    # Bidirectional: read and write are independent directions on the",
      "    # same stream — this handler answers each request as it arrives,",
      "    # but the protocol itself does not require that lockstep.",
      "    async for request in request_iterator:",
      "        yield tracking_pb2.SyncResponse(event=request.event)",
    ],
    "examples/09-client-and-bidi-streaming/python/app/tracking_service.py: async for consumes, yield produces, independently.",
    { fontSize: 12 });
  addNotes(s, "Two more shapes from the same TrackingServiceServicer class. ReportPositions is client streaming: the signature takes request_iterator instead of a single request, async for drains it to exhaustion, which only completes once the client sends its own half-close, and exactly one ReportPositionsResponse goes back, after everything has been read, never before. Sync combines both directions in one method: it's both an async generator (because it yields) and a consumer of request_iterator (because it iterates it with async for), and this particular handler's choice is to answer immediately inside the loop, one SyncResponse per SyncRequest, in arrival order, a policy decision this handler makes, not something HTTP/2 or grpc.aio enforces. A handler could just as easily buffer several requests before yielding, or yield unprompted heartbeats between requests; the protocol places no constraint on when a bidirectional handler writes relative to when it reads.");
}

/* ======================= DIVIDER 05 · DEADLINES, ERRORS, INTERCEPTORS ======================= */
divider("05", "Deadlines, rich errors & interceptors",
  "asyncio.CancelledError propagates a deadline; google.rpc.Status carries machine-readable detail.",
  "A caller's deadline becomes an asyncio cancellation inside the callee: the server doesn't just stop caring about doomed work, asyncio.sleep raises immediately rather than running to completion. Errors that need more than a status code pack google.rpc detail messages into the trailers. Both cross-cutting concerns compose through the same interceptor mechanism: resolve the handler, then wrap it.");

{
  const s = S();
  addDiagramSlide(s, "DEADLINES & ERRORS", "A canonical code plus a rich detail",
    "11-rich-error-model",
    "The gRPC status code carries the category (retry or don't); google.rpc.Status details carry the machine-readable specifics.");
  addNotes(s, "Two cooperating mechanisms, shown together. A caller's deadline is carried as absolute wire metadata, and when it expires upstream, grpc.aio cancels the asyncio Task running the downstream coroutine: asyncio.sleep, awaited rather than blocking, raises asyncio.CancelledError immediately instead of running out its full duration, so a well-behaved handler stops doing the work the instant it's told to stop, not just stops caring about the result. Separately, the rich error model layers machine-readable detail on top of the fourteen-ish canonical status codes: BadRequest for field-level validation failures, ErrorInfo for a stable machine-readable reason string, RetryInfo for exactly how long a client should wait. Both of those pieces are shown as code next.");
}

{
  const s = S();
  addCodeSlide(s, "DEADLINES", "A deadline becomes a real cancellation", LANG,
    [
      "class QuoteServiceServicer(quote_pb2_grpc.QuoteServiceServicer):",
      "    async def GetQuote(self, request, context) -> quote_pb2.GetQuoteResponse:",
      "        quote = compute_quote(request.cargo)",
      "        try:",
      "            await asyncio.sleep(_ARTIFICIAL_DELAY_S)",
      "        except asyncio.CancelledError:",
      "            logger.info(",
      "                \"downstream deadline expired upstream — \"",
      "                \"abandoning the %.0fs delay early\", _ARTIFICIAL_DELAY_S,",
      "            )",
      "            raise",
      "        return quote_pb2.GetQuoteResponse(quote=quote)",
    ],
    "examples/10-deadlines-cancellation/python/app/quote_service.py: asyncio.sleep is awaitable, not blocking, so cancellation is immediate.",
    { fontSize: 13 });
  addNotes(s, "This downstream service is artificially slow by design: a 2-second asyncio.sleep stands in for a backend hop. The point isn't the delay, it's what happens when the upstream caller's deadline expires before that delay finishes: grpc.aio cancels the asyncio Task running this coroutine, and because asyncio.sleep is a real awaitable rather than a blocking call, Python's cancellation machinery raises asyncio.CancelledError at that exact await point rather than letting the sleep run out. The try/except here stays thin: it logs that the work was abandoned early, then re-raises, because a cancelled coroutine must propagate that cancellation rather than swallow it. Contrast this with time.sleep, which cannot be interrupted this way at all; that distinction becomes the whole subject of the concurrency section later in this deck.");
}

{
  const s = S();
  addCodeSlide(s, "ERRORS", "A canonical code, packed with a rich detail", LANG,
    [
      "if origin.un_locode == _RETRY_ORIGIN:",
      "    await self._abort_rich(",
      "        context, code_pb2.UNAVAILABLE,",
      "        \"routing service temporarily unavailable, retry per RetryInfo\",",
      "        _pack(error_details_pb2.RetryInfo(retry_delay=duration_pb2.Duration(seconds=2))),",
      "    )",
      "",
      "@staticmethod",
      "async def _abort_rich(context, code: int, message: str, detail) -> None:",
      "    \"\"\"Builds a google.rpc.Status (canonical code + one rich detail) and",
      "    hands it to context.abort_with_status so it lands in the gRPC",
      "    trailers — the same place grpcurl, or any client library, looks.\"\"\"",
      "    rich_status = status_pb2.Status(code=code, message=message, details=[detail])",
      "    await context.abort_with_status(rpc_status.to_status(rich_status))",
    ],
    "examples/11-error-handling/python/app/routing_service.py: grpcio-status's google.rpc.error_details_pb2, a runtime library, not generated code.",
    { fontSize: 12 });
  addNotes(s, "The canonical gRPC status code is the first thing any client branches on: UNAVAILABLE here signals 'retry me'. But a client that wants to retry correctly needs to know how long to wait, and that's what RetryInfo, a google.rpc detail message, carries. _abort_rich is the one helper every branch in this servicer funnels through: it builds a google.rpc.Status protobuf (the canonical code, a human-readable message, and a list of packed Any details) and hands it to context.abort_with_status, which is grpcio-status's bridge between that rich status and the gRPC trailers a client actually receives. BadRequest for missing required fields and ErrorInfo for the unroutable-origin case follow the identical shape with a different detail message packed in. None of error_details_pb2's types are generated from this chapter's own .proto; they ship as a runtime library, grpcio-status, that every gRPC implementation can produce and consume without needing them in its own contract.");
}

/* ======================= DIVIDER 06 · SCHEMA DESIGN & EVOLUTION ======================= */
divider("06", "Schema design, pagination & evolution",
  "FieldMask projects a response; buf breaking gates what a contract is allowed to change.",
  "ListRoutes pages through a catalog and projects each returned message through the caller's FieldMask: an empty mask means 'everything', a non-empty one means exactly these top-level fields and nothing else. None of this is enforced by convention alone: buf breaking runs in CI against the same .proto files and fails the build before either stack compiles a line against a contract that broke a deployed client.");

{
  const s = S();
  addDiagramSlide(s, "SCHEMA DESIGN", "FieldMask projects, pagination pages",
    "13-fieldmask-projection",
    "An unset FieldMask returns the full message; a populated one keeps only the named top-level paths.");
  addNotes(s, "FieldMask is one of the well-known types from the earlier section, put to work here for response shaping. The diagram shows the two readings ListRoutes supports: no mask at all means 'I want everything', which is the only reading that keeps the RPC backward compatible with a client built before the mask field existed, and a populated mask means 'merge only these top-level paths into a fresh, empty message'; any field not named stays at its zero value and is therefore absent from the wire, because proto3 omits unset scalar and message fields by default. Pagination rides alongside it on the same RPC: a page_size default and cap, and an opaque page_token that's just the next offset in this demo catalog but could be any opaque cursor a real backend wants.");
}

{
  const s = S();
  addCodeSlide(s, "SCHEMA DESIGN", "ListRoutes: pagination + FieldMask projection", LANG,
    [
      "def _apply_field_mask(route: types_pb2.Route, mask: field_mask_pb2.FieldMask) -> types_pb2.Route:",
      "    if not mask.paths:",
      "        return route",
      "    if not mask.IsValidForDescriptor(types_pb2.Route.DESCRIPTOR):",
      "        raise ValueError(f\"field_mask names a path Route does not have: {list(mask.paths)}\")",
      "    projected = types_pb2.Route()",
      "    mask.MergeMessage(route, projected)",
      "    return projected",
      "",
      "async def ListRoutes(self, request, context) -> routing_pb2.ListRoutesResponse:",
      "    page_size = request.page_size or DEFAULT_PAGE_SIZE",
      "    page_size = min(page_size, MAX_PAGE_SIZE)",
      "    start = int(request.page_token) if request.page_token else 0",
      "    end = min(start + page_size, len(CATALOG))",
      "    page = CATALOG[start:end]",
      "    projected = [_apply_field_mask(route, request.field_mask) for route in page]",
      "    next_page_token = str(end) if end < len(CATALOG) else \"\"",
      "    return routing_pb2.ListRoutesResponse(routes=projected, next_page_token=next_page_token)",
    ],
    "examples/13-schema-design/python/app/routing_service.py: mask.MergeMessage does the projection; mask.IsValidForDescriptor validates it.",
    { fontSize: 11 });
  addNotes(s, "This slide compresses the chapter's two mechanics side by side. _apply_field_mask is the projection: an unset mask returns the route unchanged, the only reading that keeps older clients working, and a non-empty mask builds a fresh, empty Route and calls mask.MergeMessage to copy over just the named top-level paths; everything else stays at proto3's zero value and so is simply absent from the serialized response. IsValidForDescriptor catches a client naming a path Route doesn't have, which the real servicer turns into an INVALID_ARGUMENT with a BadRequest detail rather than silently ignoring the typo. ListRoutes itself clamps page_size into a sane range and treats page_token as an opaque offset, opaque to the client, even though this demo catalog happens to implement it as a literal index; a real backend could swap in a cursor over a database query without changing the wire contract at all.");
}

{
  const s = S();
  addDiagramSlide(s, "EVOLUTION", "buf breaking is the gate, not a convention",
    "14-buf-breaking-gate",
    "contracts/buf.yaml runs buf lint + buf breaking in CI, independent of either stack's build: a breaking change never reaches a compiler.");
  addNotes(s, "Schema evolution in this book is enforced by a CI gate, not by code review alone. contracts/buf.yaml configures buf breaking with the FILE rule category, which catches field renumbering, type changes, and required-field additions against the committed baseline before anyone's Python or Java build even starts. examples/14-evolution/ carries baseline, candidate-safe, and candidate-breaking proto trees specifically so this gate has deterministic fixtures to run against: a safe change like adding a new optional field or a new RPC passes, and a breaking change like reusing a field number fails the same gate, every time, regardless of which language stack would have consumed it. That's the enforcement mechanism behind every 'this field is safe to add' claim in the earlier Protobuf section.");
}

/* ======================= DIVIDER 07 · CONCURRENCY & THE GIL ======================= */
divider("07", "Concurrency: grpc.aio, to_thread, and the GIL",
  "One event loop, one thread: where blocking work runs decides whether other calls starve.",
  "grpc.aio runs every servicer coroutine on ONE event-loop thread. A coroutine that awaits cooperates; a coroutine that blocks in place (time.sleep, a blocking file read) freezes every other call on that loop for as long as it runs. asyncio.to_thread is the fix: it hands the identical blocking work to a thread-pool worker and awaits the result, so the loop stays free. The same CPython GIL that makes this concurrency model sound today is scheduled to become optional in the free-threaded 3.14 build, a change this model's assumptions will need to account for.");

{
  const s = S();
  addDiagramSlide(s, "THE GIL", "Why I/O-bound work still overlaps under one lock",
    "15-python-gil-concurrency",
    "The GIL serializes Python bytecode execution, but releases around blocking I/O calls, which is exactly what makes asyncio.to_thread work.");
  addNotes(s, "This is the figure this whole section hinges on. CPython's Global Interpreter Lock means only one thread executes Python bytecode at any instant, which sounds like it should rule out any real concurrency, but the GIL has always released around blocking I/O calls: time.sleep, a blocking socket read, a blocking file read all drop the GIL for their duration, which is precisely why asyncio.to_thread's strategy works at all. Handing a blocking call to a thread-pool worker doesn't make it run in true parallel with Python-level computation, but it does let that thread sit in the 'GIL released, waiting on I/O' state while the event-loop thread picks the GIL back up and runs other coroutines. The diagram also flags the forward-looking caveat: PEP 703's free-threaded CPython build, now shipping as an officially supported build for 3.14, makes the GIL optional: a real change to this model's assumptions that gRPC servers on Python will need to account for as that build matures past opt-in status.");
}

{
  const s = S();
  addDiagramSlide(s, "THREAD EXHAUSTION", "The starving contrast, side by side",
    "15-thread-exhaustion-overlap",
    "Run the same blocking call inline on the event loop and every concurrent call queues behind it; offload it and eight calls overlap.");
  addNotes(s, "This second figure is the direct, measured contrast the code on the next slide produces. Call the exact same ~400 millisecond blocking lookup inline, on the event loop's own thread, and every other call waiting on that loop, including other FindOptimalRoute calls, queues behind it, because nothing can run until that one coroutine either awaits something or returns. Call the identical function through asyncio.to_thread instead, and the loop is free the instant that line suspends, so eight concurrent calls overlap rather than running one at a time. Both modes produce the correct answer every time; the only difference this section demonstrates is throughput under concurrent load, which is exactly the kind of bug that is invisible in a single-request test and only shows up once a dozen clients call the same endpoint at once.");
}

{
  const s = S();
  addCodeSlide(s, "THE GIL", "Correct vs. starving: asyncio.to_thread vs. inline", LANG,
    [
      "class RoutingServiceServicer(routing_pb2_grpc.RoutingServiceServicer):",
      "    async def FindOptimalRoute(self, request, context) -> routing_pb2.FindOptimalRouteResponse:",
      "        mode = request.origin.name",
      "        origin_code, dest_code = request.origin.un_locode, request.destination.un_locode",
      "",
      "        if mode == MODE_STARVING:",
      "            # STARVING: called in-line, on THIS coroutine, on grpc.aio's",
      "            # one event-loop thread. Nothing else on this loop runs",
      "            # until the ~400ms of work is already done.",
      "            route = blocking_lookup(origin_code, dest_code)",
      "        else:",
      "            # CORRECT: hand the same blocking call to the default",
      "            # thread-pool executor and await its future. The event",
      "            # loop is free the instant this line suspends.",
      "            route = await asyncio.to_thread(blocking_lookup, origin_code, dest_code)",
      "",
      "        return routing_pb2.FindOptimalRouteResponse(route=route)",
    ],
    "examples/15-backend-io-concurrency/python/app/routing_service.py: blocking_lookup is identical ~400ms simulated DB+file I/O in both branches.",
    { fontSize: 11 });
  addNotes(s, "Both branches call the literal same function, blocking_lookup: a time.sleep standing in for a database round trip, a blocking file read of a bundled cache, and a second time.sleep standing in for a slow network-attached store, roughly 400 milliseconds total. The only thing a demo-only flag carried in request.origin.name changes is where that call runs. In the starving branch it's called directly, with no await and no executor hop, so it executes right there on grpc.aio's single event-loop thread, blocking every other coroutine scheduled on that loop for its full duration, including unrelated RoutingService calls in any mode, not just this one. In the correct branch, asyncio.to_thread hands the identical call to the loop's default ThreadPoolExecutor and awaits the result; the loop is free to run other coroutines the instant that await suspends. This is the Python-stack mirror of the JVM's virtual-thread-pinning hazard the concepts and Quarkus decks cover: same failure shape, different mechanism, because Python's unit of concurrency is a single-threaded event loop, not a pool of OS threads each running real Java bytecode in parallel.");
}

/* ======================= DIVIDER 08 · ASYNC OPERATIONS ======================= */
divider("08", "Async operations: poll, watch, cancel",
  "A server-owned Operation record, mutated by a background coroutine, read by three RPCs.",
  "A long-running job returns an operation id immediately; GetOperation polls it, WatchOperation streams snapshots until it's done, and CancelOperation ends it early. One in-memory registry, shared by the servicer that starts jobs and the servicer that reports on them, needs no lock: asyncio's single-threaded event loop means no two coroutines are ever mid-mutation at the same instant.");

{
  const s = S();
  addDiagramSlide(s, "ASYNC OPERATIONS", "Create once, poll or watch, cancel any time",
    "16-operation-lifecycle",
    "RecomputeRoutes creates an Operation; GetOperation/WatchOperation/CancelOperation read and mutate the identical record.");
  addNotes(s, "This is the AIP-151 long-running-operation shape, and the diagram shows the lifecycle the code enforces: a kicking-off RPC creates one Operation record and returns its id immediately, without waiting for the work to finish, and three more RPCs on a dedicated OperationsService, not three more methods bolted onto RoutingService, read and mutate that same record by id. The split into a separate service is deliberate on both language stacks in this book, mirroring the AIP-151 contract shape rather than one stack's implementation convenience quietly drifting from what the .proto declares. WatchOperation is the streaming variant, polling the same state on an interval and yielding snapshots until one comes back done.");
}

{
  const s = S();
  addCodeSlide(s, "ASYNC OPERATIONS", "GetOperation, WatchOperation, CancelOperation", LANG,
    [
      "class OperationsServiceServicer(routing_pb2_grpc.OperationsServiceServicer):",
      "    def __init__(self, registry: OperationRegistry) -> None:",
      "        self._registry = registry",
      "",
      "    async def GetOperation(self, request, context):",
      "        state = self._registry.get(request.operation_id)",
      "        if state is None:",
      "            await context.abort(grpc.StatusCode.NOT_FOUND, f\"no such operation: {request.operation_id}\")",
      "        return state.snapshot()",
      "",
      "    async def WatchOperation(self, request, context):",
      "        state = self._registry.get(request.operation_id)",
      "        while True:",
      "            snapshot = state.snapshot()",
      "            yield snapshot",
      "            if snapshot.done:",
      "                return",
      "            await asyncio.sleep(_WATCH_POLL_S)",
      "",
      "    async def CancelOperation(self, request, context):",
      "        state = self._registry.get(request.operation_id)",
      "        cancelled_now = state.cancel()",
      "        return state.snapshot()",
    ],
    "examples/16-async-long-running-jobs/python/app/operations_service.py: the same OperationRegistry instance backs RecomputeRoutes and all three of these.",
    { fontSize: 10 });
  addNotes(s, "GetOperation is a plain unary poll: look up the record, return its current snapshot, NOT_FOUND if the id doesn't exist. WatchOperation turns the identical state into a server stream: it yields one snapshot, checks whether that snapshot was terminal, and either returns, ending the stream with the same half-close mechanic Chapter 8's WatchShipment uses, or awaits a short poll interval and loops. CancelOperation marks the record done early and returns whether this call was the one that moved it to terminal, which matters because a cancel arriving after the job already finished, or a duplicate cancel, should be distinguishable from the first one that actually took effect. The OperationRegistry backing all of this needs no lock: asyncio runs exactly one coroutine at a time, there's never a context switch mid-statement, so every await is the only point where another coroutine can interleave, and none of these state transitions span an await: a structural difference from the Quarkus side, where the background job and the RPC handlers can run on different OS threads and do need a lock.");
}

/* ======================= DIVIDER 09 · STREAMING AT SCALE & PERFORMANCE ======================= */
divider("09", "Streaming at scale & performance",
  "An async generator is already pull-based; the client's channel, keepalive, and compression choices do the rest.",
  "Nothing extra is needed to make a Python streaming handler demand-driven: the async-generator protocol itself only resumes past a yield when the consumer is ready for the next item. From there, performance is almost entirely about the channel: build one and reuse it, size messages and compression for the workload, and keep keepalive pings tuned to survive real idle gaps without needless chatter.");

{
  const s = S();
  addDiagramSlide(s, "STREAMING AT SCALE", "Pull-based by construction",
    "17-slow-consumer-backpressure",
    "A slow consumer naturally paces a demand-driven async generator: no separate backpressure API is needed.");
  addNotes(s, "This figure is the payoff of treating async generators as the whole streaming contract rather than bolting a reactive operator chain on top. Because nothing after the current yield runs until the consumer (grpc.aio's own machinery, driven by the HTTP/2 stream's write-readiness) resumes the generator, a slow consumer naturally paces how fast a demand-driven server generates its next item. There is no separate demand-signalling API to call, the way a Mutiny MultiEmitter needs onRequest on the Quarkus side; async def combined with yield already is the pull contract. The contrasting failure mode, shown on the next slide's code, is an eager generator that builds everything before the first yield; in that case demand plays no part at all in when the work actually happens.");
}

{
  const s = S();
  addCodeSlide(s, "STREAMING AT SCALE", "A demand-driven async generator", LANG,
    [
      "async def _demand_driven_sequence(booking_id, waypoints, delays_s):",
      "    \"\"\"Builds and stamps one event per pass, awaiting `delays_s[i]`",
      "    (never a blocking time.sleep) before each one. Nothing beyond the",
      "    current await/yield pair runs ahead of what the consumer asked for —",
      "    the async generator protocol itself is the demand signal.\"\"\"",
      "    for i in range(len(waypoints)):",
      "        if delays_s[i] > 0:",
      "            await asyncio.sleep(delays_s[i])",
      "        event = build_event(booking_id, i, waypoints)",
      "        yield tracking_pb2.WatchShipmentResponse(event=event)",
      "",
      "KEEPALIVE_OPTIONS = [",
      "    (\"grpc.keepalive_time_ms\", 30_000),",
      "    (\"grpc.keepalive_timeout_ms\", 10_000),",
      "    (\"grpc.keepalive_permit_without_calls\", 1),",
      "    (\"grpc.http2.min_ping_interval_without_data_ms\", 10_000),",
      "]",
      "server = grpc.aio.server(options=KEEPALIVE_OPTIONS)",
    ],
    "examples/17-streaming-at-scale/python/app/tracking_service.py + app/main.py: options tuples are the same channel-argument API as the sync grpc.server.",
    { fontSize: 11 });
  addPerfCallout(s, "Build one channel and reuse its stub for every call: a fresh channel per call pays a TLS + TCP handshake every time (examples/18-performance-tuning/python/app/pooled_client.py vs. footgun_client.py).");
  addNotes(s, "_demand_driven_sequence is the generalized version of the earlier WatchShipment generator: it builds and stamps one event per pass, awaiting a real delay rather than blocking, so a slow or fast consumer gets events at the pace it can actually keep up with. The eager contrast this chapter also ships (not shown here) builds and stamps every event in a tight loop before the first yield, which proves the opposite point: demand plays no role at all once everything's already built. Server keepalive is the other performance lever on this slide: grpc.aio.server accepts the same options tuple the synchronous grpc.server API does, so grpc.keepalive_time_ms controls how often an otherwise-silent connection gets pinged, and min_ping_interval_without_data_ms caps how aggressively a client is allowed to ping back before the server treats it as abusive. The perf callout's channel-reuse rule is the single highest-leverage fix in the whole performance chapter: pooled_client.py times fifty calls over one reused channel against footgun_client.py's fifty calls each over a brand-new one, and the gap is the whole argument.");
}

/* ======================= DIVIDER 10 · TLS/MTLS ======================= */
divider("10", "TLS and mTLS",
  "add_secure_port replaces add_insecure_port; everything else about the servicer is unchanged.",
  "Transport security is a one-line swap at the server, backed by server credentials built once at startup from PEM files. Requiring a client certificate, mutual TLS, is a single boolean on that same credentials object. Reflection, the servicer code, and every RPC shape from earlier sections work identically over the secured channel.");

{
  const s = S();
  addDiagramSlide(s, "TLS / MTLS", "Where credentials attach",
    "19-mtls-mutual-verification",
    "require_client_auth=True makes the server demand and verify a client certificate chained to the same CA, not just present one of its own.");
  addNotes(s, "Mutual TLS is a straightforward extension of ordinary server-side TLS: the server still presents its own certificate chain so the client can verify it's talking to the right service, but with require_client_auth set, the server also demands a certificate from the client and verifies it chains to a CA the server trusts: the same root_certificates value used either way. The diagram shows both directions of that verification happening before a single byte of the actual RoutingService contract is exchanged; GetQuote's handler never sees or cares that the transport underneath it is secured, because the credential check happens entirely below the servicer layer, at channel establishment.");
}

{
  const s = S();
  addCodeSlide(s, "TLS / MTLS", "ssl_server_credentials + add_secure_port", LANG,
    [
      "def _build_server_credentials() -> grpc.ServerCredentials:",
      "    server_key = (CERTS_DIR / \"server.key\").read_bytes()",
      "    server_cert = (CERTS_DIR / \"server.crt\").read_bytes()",
      "    ca_cert = (CERTS_DIR / \"ca.crt\").read_bytes()",
      "    return grpc.ssl_server_credentials(",
      "        [(server_key, server_cert)],",
      "        root_certificates=ca_cert,",
      "        require_client_auth=(CLIENT_AUTH == \"REQUIRED\"),",
      "    )",
      "",
      "async def serve() -> None:",
      "    server = grpc.aio.server()",
      "    routing_pb2_grpc.add_RoutingServiceServicer_to_server(RoutingServiceServicer(), server)",
      "    reflection.enable_server_reflection(service_names, server)",
      "    server.add_secure_port(f\"{HOST}:{PORT}\", _build_server_credentials())",
      "    await server.start()",
    ],
    "examples/19-tls-mtls/python/app/main.py: the Python API's require_client_auth is a bool; Quarkus's client-auth is a three-value NONE/REQUEST/REQUIRED enum.",
    { fontSize: 12 });
  addNotes(s, "Compare this to the unary RPC section's main.py and the only change is this: add_insecure_port becomes add_secure_port, taking a grpc.ServerCredentials object this function builds once at startup. grpc.ssl_server_credentials takes a list of (key, cert) pairs, because a server can present more than one certificate for different SNI names, though this example uses exactly one, plus root_certificates, the CA other certificates must chain to, loaded unconditionally whether or not client auth is required, so flipping the CLIENT_AUTH environment variable never needs a second code path. require_client_auth is the one place the Python API is simpler than the Quarkus side's three-value client-auth setting: it's a plain boolean, on or off, where Vert.x exposes NONE, REQUEST, and REQUIRED as distinct states. Reflection still works unchanged over this secured port: it's an ordinary unary RPC, so grpcurl's list and describe commands behave identically over TLS or mTLS as they do over the plaintext port every earlier chapter used.");
}

/* ======================= DIVIDER 11 · AUTHN/AUTHZ ======================= */
divider("11", "AuthN/AuthZ with PyJWT",
  "One interceptor: verify the signature and expiry, then check the scope the method requires.",
  "A bearer token in call metadata is verified with PyJWT before any servicer method runs; a per-method scope map decides authorization once authentication passes. Reflection stays exempt from both checks, the same exemption Chapter 12's logging interceptor made, because a client has to be able to discover the service before it has any token to send.");

{
  const s = S();
  addDiagramSlide(s, "AUTHN / AUTHZ", "Metadata carries the bearer token",
    "20-jwt-in-metadata-flow",
    "authorization: Bearer <jwt> rides in gRPC metadata, the Python name for what Quarkus calls Metadata headers.");
  addNotes(s, "gRPC metadata is the one mechanism every cross-cutting concern in this deck rides on: logging, tracing, and now authentication all read and write the same key-value map, just under different keys. The diagram traces a JWT from the client's authorization header through the wire as metadata, into the interceptor that reads it before the real servicer method ever runs, through PyJWT's signature-and-expiry check, and finally into the per-method scope decision the next slide's code implements. Every authentication failure in this chapter (missing header, malformed Bearer prefix, bad signature, expired token) collapses into the same UNAUTHENTICATED outcome, so a client can't distinguish 'your token expired' from 'you forged a signature' by status code alone.");
}

{
  const s = S();
  addCodeSlide(s, "AUTHN / AUTHZ", "AuthzInterceptor: verify, then authorize per method", LANG,
    [
      "METHOD_SCOPES: dict[str, str] = {",
      "    \"shipping.routing.v1.RoutingService/GetQuote\": \"quote:read\",",
      "    \"shipping.routing.v1.RoutingService/ListRoutes\": \"routes:admin\",",
      "}",
      "",
      "class AuthzInterceptor(grpc.aio.ServerInterceptor):",
      "    async def intercept_service(self, continuation, handler_call_details):",
      "        method = handler_call_details.method",
      "        handler = await continuation(handler_call_details)",
      "        if _is_reflection(method):",
      "            return handler",
      "",
      "        token = _bearer_token(dict(handler_call_details.invocation_metadata or ()))",
      "        if token is None:",
      "            return self._reject(handler, method, start, grpc.StatusCode.UNAUTHENTICATED, \"...\")",
      "        try:",
      "            claims = verify_token(token)",
      "        except TokenError as exc:",
      "            return self._reject(handler, method, start, grpc.StatusCode.UNAUTHENTICATED, f\"invalid token: {exc}\")",
      "",
      "        scope_needed = required_scope(method)",
      "        if scope_needed and scope_needed not in set(str(claims.get(\"scope\", \"\")).split()):",
      "            return self._reject(handler, method, start, grpc.StatusCode.PERMISSION_DENIED, \"...\")",
      "        return _with_logging(handler, method, start)",
    ],
    "examples/20-authn-authz/python/app/interceptors.py + app/auth.py: jwt.decode rejects a bad signature and an expired exp on its own.",
    { fontSize: 10 });
  addNotes(s, "METHOD_SCOPES is the authorization policy in one small dict: GetQuote needs quote:read, ListRoutes needs routes:admin, and any method with no entry needs only a valid token, not a specific scope. The interceptor resolves the real handler first: continuation only looks up what would run, it doesn't call it, then makes three decisions in order, before that handler ever executes. Reflection is exempt unconditionally, same as Chapter 12's logging interceptor, because grpcurl's list and describe have to work before a token exists. Authentication comes next: no bearer token, or one verify_token rejects. PyJWT's jwt.decode raises its own exceptions for a bad signature, an expired exp, or a malformed token, and verify_token collapses every one of those into a single TokenError; both map to UNAUTHENTICATED. Only once authentication passes does authorization run: a token whose scope claim doesn't contain the method's required scope gets PERMISSION_DENIED, and the real GetQuote or ListRoutes handler is never reached. This mirrors Chapter 12's resolve-then-wrap structure exactly, extended from presence-only checking to real verification.");
}

/* ======================= DIVIDER 12 · OBSERVABILITY ======================= */
divider("12", "Observability & health",
  "A hand-rolled Prometheus interceptor, a health servicer, and zero-code OTLP tracing.",
  "grpcio ships no Prometheus binder of its own, so this chapter writes grpc_server_* metrics by hand, following the same resolve-then-wrap interceptor shape every cross-cutting concern in this deck uses. grpc.health.v1.Health is wired by hand too: the asyncio-native servicer, not the classic synchronous one. OpenTelemetry's zero-code wrapper instruments the grpc.aio server, the client channel, and a co-located FastAPI app in one trace per request.");

{
  const s = S();
  addDiagramSlide(s, "OBSERVABILITY", "One interceptor, metrics for every unary call",
    "21-observability-surfaces",
    "grpc_server_handled_total and grpc_server_handling_seconds follow the same label names the Go and Java gRPC ecosystems use.");
  addNotes(s, "This figure lays out the three observability surfaces this chapter wires up in one process: Prometheus metrics scraped from GET /metrics on a co-located FastAPI app, a grpc.health.v1.Health service any orchestrator can poll, and OTLP traces exported by the zero-code opentelemetry-instrument wrapper. None of these are automatic the way they are on the Quarkus side: grpcio ships no Prometheus binder and no automatic health registration, so both are hand-wired here, in code shown next, following the exact same interceptor pattern Chapter 12 and Chapter 20 already established. The metric and label names (grpc_server_handled_total, grpc_server_handling_seconds, labeled by grpc_service, grpc_method, grpc_code) match the names the community's grpc-ecosystem Prometheus interceptors use in Go and Java, so a dashboard built against one gRPC service recognizes the shape of metrics from any other.");
}

{
  const s = S();
  addCodeSlide(s, "OBSERVABILITY", "MetricsInterceptor + hand-wired Health", LANG,
    [
      "GRPC_SERVER_HANDLED_TOTAL = Counter(",
      "    \"grpc_server_handled_total\", \"...\", [\"grpc_service\", \"grpc_method\", \"grpc_code\"],",
      ")",
      "GRPC_SERVER_HANDLING_SECONDS = Histogram(",
      "    \"grpc_server_handling_seconds\", \"...\", [\"grpc_service\", \"grpc_method\"],",
      ")",
      "",
      "class MetricsInterceptor(grpc.aio.ServerInterceptor):",
      "    async def intercept_service(self, continuation, handler_call_details):",
      "        handler = await continuation(handler_call_details)",
      "        service, rpc_method = _split_method(handler_call_details.method)",
      "        inner = handler.unary_unary",
      "        async def wrapped(request, context):",
      "            start = time.monotonic()",
      "            try:",
      "                return await inner(request, context)",
      "            finally:",
      "                code = context.code() or grpc.StatusCode.OK",
      "                GRPC_SERVER_HANDLED_TOTAL.labels(service, rpc_method, code.name).inc()",
      "                GRPC_SERVER_HANDLING_SECONDS.labels(service, rpc_method).observe(time.monotonic() - start)",
      "        return grpc.unary_unary_rpc_method_handler(wrapped, ...)",
      "",
      "health_servicer = health_aio.HealthServicer()  # asyncio-native — NOT the classic sync HealthServicer",
      "await health_servicer.set(service_name, health_pb2.HealthCheckResponse.SERVING)",
    ],
    "examples/21-observability/python/app/metrics.py + app/main.py: health.aio.HealthServicer's Check is a coroutine; the classic one is not.",
    { fontSize: 9 });
  addNotes(s, "MetricsInterceptor follows the exact resolve-then-wrap structure Chapter 12's AuthLoggingInterceptor and Chapter 20's AuthzInterceptor already use: continuation resolves the real handler, this interceptor wraps only its unary_unary behavior function (this chapter's example only times GetQuote calls, so streaming handlers pass through untouched), and the finally block records both the counter and the histogram regardless of whether the call succeeded or raised. context.code() reports the status explicitly set by context.abort or by the generated UNIMPLEMENTED stub; it's still None for a handler that simply returned, which is exactly the OK case, so 'or grpc.StatusCode.OK' covers that. The health servicer line at the bottom is a real pitfall this chapter calls out by name: grpc_health.v1.health.aio.HealthServicer is the asyncio-native implementation whose Check method is a coroutine, matching this grpc.aio server; registering the classic, synchronous health.HealthServicer here instead raises 'object can't be awaited' the moment anything calls Check. SERVING is set per service name and for the empty string, which is what grpcurl's overall-server health check looks up.");
}

/* ======================= DIVIDER 13 · MESH / LOAD BALANCING & TRANSCODING ======================= */
divider("13", "Load balancing & grpc-web transcoding",
  "A reused channel is one connection, pinned to one pod: until the client or the mesh fixes that.",
  "A plain Kubernetes Service resolves to one virtual IP, and a gRPC channel's one long-lived HTTP/2 connection gets routed to exactly one backing pod for the life of that connection: the pinned-pod baseline every multi-replica gRPC service hits on a generic Kubernetes cluster. A headless Service plus client-side round_robin fixes it from the client; a service mesh sidecar fixes it without any client code change at all. Separately, grpc-web framing is what lets a browser reach the same contract without native HTTP/2 trailer support.");

{
  const s = S();
  addDiagramSlide(s, "LOAD BALANCING", "The pinned-pod baseline on a plain Service",
    "22-grpc-lb-problem",
    "kube-proxy picks a backend pod once per TCP connection, not once per request; every call on a reused channel goes to the same pod.");
  addNotes(s, "This is the minikube-tier demonstration, run by hand on a real generic Kubernetes cluster rather than in CI, because it needs multiple pods and a cluster DNS to show. A plain ClusterIP Service is a virtual IP with no process behind it; kube-proxy rewrites a connection's destination to one backing pod exactly once, at connection time, not per request. For a gRPC client doing exactly what Chapter 7 recommends (build one channel, reuse it for the process lifetime), that one connection-time decision sticks for every call the channel ever carries. Thirty calls against a three-replica Deployment land on one pod, every time, while the other two sit idle and ready. Nothing here is misconfigured; it's the correct, recommended client behavior colliding with the one Kubernetes primitive most engineers reach for first.");
}

{
  const s = S();
  addCodeSlide(s, "LOAD BALANCING", "loadclient.py: the single reused channel this demo turns on its head", LANG,
    [
      "TARGET = os.environ[\"TARGET\"]",
      "LB_POLICY = os.environ.get(\"LB_POLICY\", \"\")",
      "CALLS = int(os.environ.get(\"CALLS\", \"30\"))",
      "",
      "async def main() -> None:",
      "    options = [(\"grpc.lb_policy_name\", LB_POLICY)] if LB_POLICY else []",
      "    # One channel, built once, reused for every call below.",
      "    async with grpc.aio.insecure_channel(TARGET, options=options) as channel:",
      "        stub = routing_pb2_grpc.RoutingServiceStub(channel)",
      "        served_by: list[str] = []",
      "        for i in range(CALLS):",
      "            call = stub.GetQuote(_REQUEST)",
      "            await call",
      "            trailers = dict(await call.trailing_metadata())",
      "            served_by.append(trailers.get(\"x-served-by\", \"<no trailer>\"))",
      "    tally = Counter(served_by)",
      "    print(f\"distinct pods answering: {len(tally)}\")",
    ],
    "examples/22-mesh-loadbalancing/python/app/loadclient.py: TARGET=dns:///...-headless + LB_POLICY=round_robin is the client-side fix.",
    { fontSize: 11 });
  addNotes(s, "This is the one client this chapter's whole minikube demo runs, in three configurations: against a plain ClusterIP Service with no LB_POLICY set (the pinned-pod baseline: one connection, one pod, every call), against a headless Service with LB_POLICY=round_robin (the headless + round-robin fix: DNS now returns one address per ready pod, and grpc-core's round_robin policy opens a persistent subchannel to each, cycling through all three), and a third run against the plain Service again with an Istio sidecar injected and no client change at all, where the mesh balances at Layer 7, per request, instead of Layer 4, per connection. The code itself never changes between the first two runs, only the TARGET DNS name and one channel option, which is exactly the point: fixing this from the client means every caller, in every language, has to independently remember to ask for the headless name and set round_robin. The x-served-by trailer is what makes which pod answered observable at all; it rides as gRPC metadata, outside the message, the same mechanism every interceptor in this deck reads and writes.");
}

{
  const s = S();
  addDiagramSlide(s, "TRANSCODING", "grpc-web framing: one more length-prefixed frame",
    "23-grpc-web-framing",
    "A browser's fetch can't read HTTP/2 trailers, so grpc-web moves the final status into a TRAILER frame inside the HTTP body.");
  addNotes(s, "Native gRPC needs HTTP/2 trailers to carry the final grpc-status after the response body: exactly the piece a browser's fetch or XMLHttpRequest can't read, and can't send an HTTP/2 request directly either. grpc-web's answer is a framing convention, not a different protocol: every message and the final status get a 5-byte frame header, one flag byte plus a 4-byte big-endian length, and the status moves into one more frame inside an ordinary HTTP/1.1-compatible response body instead of a real trailer. Envoy's grpc_web filter is what translates between this framing and a native gRPC call to the upstream service; the application servicer code never knows the difference; what changed is entirely in the wire framing and the content-type header, never in any special server-side client library.");
}

{
  const s = S();
  addCodeSlide(s, "TRANSCODING", "Framing and unframing a grpc-web call by hand", LANG,
    [
      "_FRAME_HEADER_LEN = 5",
      "_FLAG_TRAILER = 0x80",
      "",
      "def frame(message: bytes) -> bytes:",
      "    \"\"\"flag 0x00 (uncompressed DATA frame) + the message's length as a",
      "    4-byte unsigned big-endian integer.\"\"\"",
      "    return struct.pack(\">BI\", 0x00, len(message)) + message",
      "",
      "def call_get_quote(envoy_target, origin, destination, weight_kg) -> routing_pb2.GetQuoteResponse:",
      "    request = routing_pb2.GetQuoteRequest(",
      "        origin=types_pb2.Location(un_locode=origin),",
      "        destination=types_pb2.Location(un_locode=destination),",
      "        cargo=[types_pb2.Cargo(weight_kg=weight_kg)],",
      "    )",
      "    body = frame(request.SerializeToString())",
      "    url = f\"http://{envoy_target}/shipping.routing.v1.RoutingService/GetQuote\"",
      "    http_request = urllib.request.Request(url, data=body, method=\"POST\", headers={",
      "        \"content-type\": \"application/grpc-web+proto\", \"x-grpc-web\": \"1\",",
      "    })",
    ],
    "examples/23-grpc-web-transcoding/python/app/grpcweb_client.py: standard library only; this book's deterministic stand-in for a browser's grpc-web client.",
    { fontSize: 10 });
  addNotes(s, "This client is the deterministic, CI-runnable stand-in for a real browser's grpc-web JavaScript library: it uses only the standard library's urllib and struct, plus protobuf for the message itself, no JavaScript runtime and no grpc-web npm package. frame is the whole encoding: a 1-byte flag, a 4-byte big-endian length, then the raw serialized GetQuoteRequest bytes: the exact same length-prefixed-message idea native gRPC uses over HTTP/2, reused as an HTTP/1.1-body-safe envelope. The request path is the ordinary gRPC '/package.Service/Method' convention, completely unchanged from a native call; what signals grpc-web rather than plain gRPC is purely the content-type header and the framing, which is also why Envoy's grpc_web filter can sit transparently between a browser and an unmodified RoutingService implementation. The unframe side, not shown here, splits the response body back into its DATA frame and its TRAILER frame: the trailer carrying grpc-status as HTTP/1.1-style text instead of a real HTTP/2 trailer, which is the one piece of information the browser transport could never deliver any other way.");
}

/* ======================= DIVIDER 14 · TESTING & DEBUGGING ======================= */
divider("14", "Testing & debugging",
  "A real grpc.aio server on an ephemeral port is the test fixture; reflection and failure probes are the debug tools.",
  "pytest-asyncio drives an in-process grpc.aio server and channel pair as a fixture, gating every container build before a single grpcurl call runs against it. When something fails in the field, GRPC_TRACE and GRPC_VERBOSITY surface the C-core's own transport log, and small deterministic probes pin down exactly which failure mode (a cold channel, a bad certificate) produced a given status code.");

{
  const s = S();
  addDiagramSlide(s, "TESTING", "A real server, not a fake channel",
    "25-grpc-test-pyramid",
    "grpc_testing's fake channel has no asyncio support: the only way to exercise an async servicer in-process is to actually start one.");
  addNotes(s, "The test pyramid for this book's gRPC examples looks the way any service's pyramid should, more unit-level assertions than end-to-end ones, but the in-process layer has a Python-specific wrinkle this figure calls out: grpc_testing, the library's own fake-channel testing helper, has no asyncio support at all, so it simply cannot drive an async servicer. The only way to exercise a grpc.aio servicer in-process is to start an actual grpc.aio server bound to an OS-assigned ephemeral port and connect to it with a real grpc.aio channel: exactly what the fixture on the next slide does, and exactly why it's a few more lines than a typical mocked-dependency unit test.");
}

{
  const s = S();
  addCodeSlide(s, "TESTING", "pytest-asyncio + a real in-process grpc.aio server", LANG,
    [
      "@pytest_asyncio.fixture",
      "async def routing_channel() -> AsyncIterator[grpc.aio.Channel]:",
      "    \"\"\"Starts a REAL grpc.aio server on an OS-assigned ephemeral port,",
      "    wired with the same RoutingServiceServicer the container runs.\"\"\"",
      "    server = grpc.aio.server()",
      "    routing_pb2_grpc.add_RoutingServiceServicer_to_server(RoutingServiceServicer(), server)",
      "    port = server.add_insecure_port(\"127.0.0.1:0\")",
      "    await server.start()",
      "    channel = grpc.aio.insecure_channel(f\"127.0.0.1:{port}\")",
      "    try:",
      "        yield channel",
      "    finally:",
      "        await channel.close()",
      "        await server.stop(grace=None)",
      "",
      "@pytest.mark.asyncio",
      "async def test_get_quote_computes_the_expected_amount_and_route(routing_channel):",
      "    stub = routing_pb2_grpc.RoutingServiceStub(routing_channel)",
      "    response = await stub.GetQuote(_REQUEST)",
      "    assert response.quote.amount == \"3001.25\"",
      "    assert response.route.legs[0].carrier == \"MAERSK\"",
    ],
    "examples/25-testing-and-cli/python/tests/test_routing_service.py: the Containerfile runs pytest unconditionally; a red test fails the image build.",
    { fontSize: 10 });
  addNotes(s, "\"127.0.0.1:0\" is the detail that makes this fixture safe to run in parallel and in CI: port 0 asks the OS to assign a free ephemeral port, add_insecure_port returns the actual port it picked, and the channel dials that exact address, with no fixed port to collide with another test run or another developer's machine. The fixture tears both the channel and the server down after every test, with grace=None on stop so it doesn't wait for in-flight calls that shouldn't exist by teardown time. This is the hard gate the whole Python side rests on: the Containerfile's build stage runs pytest unconditionally, so a red assertion here fails the Docker build, which fails docker compose up --build, which fails verify.sh, before a single grpcurl call ever runs against a broken image. It's the Python-stack mirror of the Quarkus side's mvn verify gate, enforced at the identical point in the pipeline.");
}

{
  const s = S();
  addCodeSlide(s, "DEBUGGING", "Deterministic failure probes", LANG,
    [
      "# trace_probe.py — GRPC_TRACE / GRPC_VERBOSITY make the C-core log",
      "# low-level transport activity to stderr (grpc-python wraps the SAME",
      "# C-core grpc-java and grpc-c++ embed; grpcurl, built on grpc-go, reads",
      "# different variables entirely — GRPC_GO_LOG_VERBOSITY_LEVEL instead).",
      "channel = grpc.aio.insecure_channel(target)",
      "response = await stub.GetQuote(_REQUEST, timeout=10)",
      "",
      "# unavailable_probe.py — a real client's channel dials LAZILY; the",
      "# first RPC against a dead target surfaces as a gRPC status, UNAVAILABLE,",
      "# never as grpcurl's pre-flight \"Failed to dial\" error.",
      "channel = grpc.aio.insecure_channel(target)",
      "stub = routing_pb2_grpc.RoutingServiceStub(channel)",
      "try:",
      "    await stub.GetQuote(_REQUEST, timeout=5)",
      "except grpc.aio.AioRpcError as exc:",
      "    assert exc.code() == grpc.StatusCode.UNAVAILABLE",
    ],
    "examples/26-debugging/python/app/trace_probe.py + app/unavailable_probe.py: each script proves exactly one failure mode.",
    { fontSize: 11 });
  addNotes(s, "Two small, deterministic probes, each proving exactly one thing this chapter's prose claims. trace_probe.py exists so GRPC_TRACE and GRPC_VERBOSITY, set in the container environment around this one GetQuote call, have a call to actually log: grpc-python wraps the same C-core implementation grpc-java and grpc-c++ embed, so these two environment variables surface its internal transport and call activity, while grpcurl, built on grpc-go from scratch, doesn't read either variable at all and needs GRPC_GO_LOG_VERBOSITY_LEVEL instead. unavailable_probe.py proves a subtler point: grpc.aio.insecure_channel returns immediately without dialing anything, since a real application channel is lazy, so a call against a target nothing is listening on surfaces as a gRPC status, UNAVAILABLE, on the RPC itself, which is a status grpcurl can never produce for this exact condition, because grpcurl dials blocking, before any RPC, and reports a raw connection-refused error with no status code at all.");
}

/* ======================= DIVIDER 15 · THE FINAL PROJECT ======================= */
divider("15", "The Final Project",
  "Every pattern in this deck, assembled into one mTLS-secured, scope-checked, traced service.",
  "The Final Project is every pattern from this deck wired into one process: mTLS server credentials, an authorization interceptor, a loopback channel carrying its own internal bearer token, three services sharing one grpc.health.v1.Health, and a co-located FastAPI booking endpoint, all under one OpenTelemetry trace per request.");

{
  const s = S();
  addDiagramSlide(s, "THE FINAL PROJECT", "Three tiers, every pattern, one trace",
    "27-final-project-architecture",
    "RoutingService, QuoteService, and TrackingService share one mTLS-secured grpc.aio server and one loopback channel.");
  addNotes(s, "This architecture figure is the deck's destination: every pattern from every earlier section lands in this one process. mTLS from the TLS section secures the external port; the AuthzInterceptor from the authn/authz section gates every call except reflection and health; a loopback channel, the same one-channel-many-stubs discipline from the unary RPC section, lets RoutingService call QuoteService as an internal gRPC hop, now carrying its own internal service bearer token rather than running in the clear; TrackingService contributes WatchShipment and ReportPositions from the streaming section; and grpc.health.v1.Health, wired by hand exactly as the observability section showed, reports SERVING for all three services plus the overall server. A co-located FastAPI app exposes POST /booking/quote as the one HTTP entry point into this otherwise all-gRPC system, and opentelemetry-instrument ties the gRPC server, the internal gRPC client, and the FastAPI app into one trace per request.");
}

{
  const s = S();
  addCodeSlide(s, "THE FINAL PROJECT", "Wiring every pattern into one process", LANG,
    [
      "async def serve() -> None:",
      "    server = grpc.aio.server(interceptors=[AuthzInterceptor()])",
      "",
      "    # The loopback mTLS channel both RoutingServiceServicer (downstream to",
      "    # QuoteService) and the FastAPI booking handler dial, each call",
      "    # carrying the internal service bearer token.",
      "    loopback = loopback_channel(GRPC_PORT)",
      "    quote_stub = quote_pb2_grpc.QuoteServiceStub(loopback)",
      "    routing_stub = routing_pb2_grpc.RoutingServiceStub(loopback)",
      "",
      "    routing_pb2_grpc.add_RoutingServiceServicer_to_server(",
      "        RoutingServiceServicer(quote_stub, INTERNAL_METADATA), server)",
      "    quote_pb2_grpc.add_QuoteServiceServicer_to_server(QuoteServiceServicer(), server)",
      "    tracking_pb2_grpc.add_TrackingServiceServicer_to_server(TrackingServiceServicer(), server)",
      "",
      "    for service_name in (\"\", routing_full_name, quote_full_name, tracking_full_name):",
      "        await health_servicer.set(service_name, health_pb2.HealthCheckResponse.SERVING)",
      "",
      "    server.add_secure_port(grpc_bind_addr, _build_server_credentials())",
      "    await asyncio.gather(server.wait_for_termination(), http_server.serve())",
    ],
    "examples/27-complete-project/python/app/main.py: mTLS + AuthzInterceptor + three servicers + Health + FastAPI, one event loop.",
    { fontSize: 10 });
  addNotes(s, "Read this against the plain unary-RPC main.py from early in the deck and every added line is a pattern this deck already covered in isolation: interceptors=[AuthzInterceptor()] is the authn/authz section; loopback_channel building an mTLS channel that attaches INTERNAL_METADATA to every call is the TLS section plus the authn/authz section combined, now protecting an internal hop, not just the external one; three separate add_*Servicer_to_server registrations on one server is the unary and streaming sections generalized to multiple services sharing one process; the health_servicer loop is the observability section's hand-wired Health, now covering three service names plus the empty string for the overall server; and add_secure_port with _build_server_credentials is the TLS section's exact helper, reused unchanged. Nothing here is a new mechanism: it confirms that every pattern this deck taught in isolation composes into one secured, observable service without any of them interfering with each other.");
}

/* ======================= DIVIDER 16 · ECOSYSTEM & WRAP-UP ======================= */
divider("16", "Ecosystem & wrap-up",
  "grpc.aio, PyJWT, OpenTelemetry, pytest-asyncio, uv: a small dependency set.",
  "The whole Python build rests on a handful of maintained, upstream-pinned libraries: grpcio and its reflection/health/status/channelz siblings, PyJWT for token verification, prometheus_client and the OpenTelemetry zero-code distro for observability, and pytest-asyncio for the one testing wrinkle async servicers introduce. Nothing here is a managed cloud service, and every example runs the same way on Docker Engine, minikube, or OpenShift Local.");

{
  const s = S();
  addContentTitle(s, "ECOSYSTEM", "What this deck leaned on");
  addTwoColBullets(s,
    [
      "grpc.aio: the asyncio-native server and channel API",
      "grpcio-tools: build-time .proto -> *_pb2 compilation",
      "grpcio-reflection, grpcio-health-checking",
      "grpcio-status + google.rpc.error_details_pb2",
      "PyJWT: HS256 verification, no IdP in these demos",
    ],
    [
      "prometheus_client + opentelemetry-distro (zero-code)",
      "pytest + pytest-asyncio: the in-process fixture",
      "uv: dependency management, pinned, no requirements.txt",
      "UBI 10 python-314-minimal: the one runtime base image",
      "buf: lint + breaking, gating the contract in CI",
    ],
    { fontSize: 15 });
  addNotes(s, "This is the full dependency surface the Python side of this book leans on, and it stays small. grpc.aio and its generated stub classes are the core; grpcio-tools is build-time only, never shipped at runtime; grpcio-reflection and grpcio-health-checking add the two discovery and liveness surfaces every chapter after the first relies on; grpcio-status bridges the google.rpc rich error model into real gRPC trailers. PyJWT does signature and expiry verification with a hardcoded demo secret, explicitly called out as demo-only, since a production service verifies against an IdP's published JWKS instead. prometheus_client and opentelemetry-distro cover the two observability surfaces; pytest-asyncio is the one testing library the async servicer shape specifically requires, since grpc_testing's fake channel has no asyncio support at all. uv manages every project's dependencies, pinned and declarative, and every image builds on the same UBI 10 Python minimal base. None of this is a managed cloud service: everything here runs unchanged on Docker Engine, on minikube, or on OpenShift Local, which is the same constraint every other deck in this series holds.");
}

{
  const s = S();
  addContentTitle(s, "WRAP-UP", "What to take away");
  addBullets(s, [
    "grpc.aio turns every RPC shape into ordinary async Python: async def for unary, async generators for every streaming direction.",
    "The GIL is real, and asyncio.to_thread is the correct, deliberate fix for blocking I/O inside a servicer, not a workaround.",
    "Interceptors compose the same way for every cross-cutting concern: resolve the handler, then wrap its behavior function.",
    "Every pattern in this deck is real, runnable code, validated against the identical Protobuf contract the Quarkus deck implements.",
    "The Final Project brings all of it together in one process: mTLS, authz, streaming, health, tracing.",
  ], { fontSize: 16 });
  addNotes(s, "If one slide survives from this whole deck, make it this one. grpc.aio's entire contribution is turning every RPC shape (unary, server streaming, client streaming, bidirectional) into syntax Python already has: async def and await for the simple case, async generators and async for for every streaming direction, with no separate reactive library required. The GIL section is the one piece of this deck that's different from the JVM story: Python's concurrency model is one event loop on one thread, and asyncio.to_thread is the deliberate, correct answer for blocking work, not a hack: a distinction worth internalizing before the free-threaded build changes some of these assumptions. Interceptors are the one mechanism every cross-cutting concern in this deck reused: logging, auth, metrics, all built the same resolve-then-wrap way. And none of it is hypothetical: every code slide in this deck is lifted directly from a runnable example, gated by the same pytest suite and the same buf breaking check that gate the Quarkus sibling, which is exactly what lets a client treat both implementations as interchangeable. Questions welcome, and the appendix stays open for anything that needs a longer look.");
}

/* ======================= APPENDIX ======================= */
divider("A", "Appendix: extra Python code",
  "Full file listings, extended servicers, and reference material: keep this open in another window.",
  "Everything past this divider is reference depth that didn't fit the main arc: complete pyproject.toml and Containerfile listings, the full multi-RPC-shape interceptor wrapping code, the complete authn/authz token minter, the performance-tuning client trio, the complete ListRoutes pagination servicer, and the OpenShift Local figures showing these same Python images running unchanged on a different Kubernetes distribution.");

{
  const s = S();
  addCodeSlide(s, "APPENDIX · SETUP", "The full contract-first pyproject.toml", LANG,
    [
      "[project]",
      "name = \"shipping-python-ch05-routing\"",
      "version = \"1.0.0\"",
      "description = \"Ch5 contract-first anchor — gRPC RoutingService.GetQuote (Python side).\"",
      "requires-python = \">=3.14\"",
      "dependencies = [",
      "    \"grpcio>=1.75,<2\",",
      "    \"grpcio-reflection>=1.75,<2\",",
      "    \"protobuf>=5,<7\",",
      "    \"opentelemetry-distro>=0.50b0\",",
      "    \"opentelemetry-exporter-otlp-proto-grpc>=1.29\",",
      "    \"opentelemetry-instrumentation-grpc>=0.50b0\",",
      "]",
      "",
      "[dependency-groups]",
      "dev = [\"grpcio-tools>=1.75,<2\"]",
      "",
      "[build-system]",
      "requires = [\"hatchling\"]",
      "build-backend = \"hatchling.build\"",
      "",
      "[tool.hatch.build.targets.wheel]",
      "packages = [\"app\"]",
    ],
    "examples/05-contract-first/python/pyproject.toml, verbatim.",
    { fontSize: 10 });
  addNotes(s, "The complete pyproject.toml behind the setup section's excerpt, for reference. hatchling is the build backend every example in this book uses: a small, standards-based choice with no extra plugin ecosystem to evaluate. packages = [\"app\"] under [tool.hatch.build.targets.wheel] is what tells hatchling the installable package is the app/ directory, not the repository root. No uv.lock is committed at this chapter's point in the book, since the dependency set is small and pure-Python, but later chapters that add a persistence layer adopt --locked once a lockfile lands alongside it.");
}

{
  const s = S();
  addCodeSlide(s, "APPENDIX · SETUP", "The full multi-stage Containerfile", LANG,
    [
      "FROM registry.access.redhat.com/ubi10/python-314-minimal:10.2-1791464217 AS build",
      "USER 0",
      "WORKDIR /app",
      "RUN pip install --no-cache-dir uv==0.12.24",
      "COPY examples/05-contract-first/python/pyproject.toml ./",
      "COPY examples/05-contract-first/python/app ./app",
      "RUN uv sync --group dev",
      "COPY contracts/proto/shipping/type/v1/types.proto ./proto/shipping/type/v1/types.proto",
      "COPY contracts/proto/shipping/routing/v1/routing.proto ./proto/shipping/routing/v1/routing.proto",
      "RUN mkdir -p generated && \\",
      "    .venv/bin/python -m grpc_tools.protoc -I proto \\",
      "      --python_out=generated --grpc_python_out=generated \\",
      "      proto/shipping/type/v1/types.proto proto/shipping/routing/v1/routing.proto",
      "RUN rm -rf .venv && uv sync --no-dev",
      "",
      "FROM registry.access.redhat.com/ubi10/python-314-minimal:10.2-1791464217",
      "WORKDIR /app",
      "COPY --from=build --chown=1001:0 /app/.venv /app/.venv",
      "COPY --from=build --chown=1001:0 /app/app /app/app",
      "COPY --from=build --chown=1001:0 /app/generated /app/generated",
      "ENV PATH=\"/app/.venv/bin:$PATH\" PYTHONPATH=\"/app/generated:/app\"",
      "EXPOSE 9000",
      "USER 1001",
      "ENTRYPOINT [\"opentelemetry-instrument\", \"python\", \"-m\", \"app.main\"]",
    ],
    "examples/05-contract-first/python/Containerfile, trimmed to the structural lines: UBI 10 python-314-minimal is the only published UBI 10 Python image.",
    { fontSize: 9 });
  addNotes(s, "The full two-stage build behind the setup section's excerpt. Stage one runs as root only because it needs to write into /app at the exact path the runtime uses: a Python venv is not relocatable, since its console scripts embed the absolute interpreter path. uv sync --group dev pulls in grpcio-tools for the protoc step, then uv sync --no-dev, after deleting the venv, rebuilds it without that build-time-only dependency before the runtime stage copies it over. UBI 10 publishes only a -minimal Python image, never a full python-312 or python-314 variant the way UBI 9 sometimes did, which is why this book pins python-314-minimal specifically and re-verifies that tag with skopeo rather than assuming a non-minimal alternative exists. The final ENTRYPOINT wraps the server in opentelemetry-instrument unconditionally; with no reachable OTLP collector, the exporter just logs failed exports in the background, so this wrapper never blocks startup or delays a GetQuote call even when the observability compose profile is off.");
}

{
  const s = S();
  addCodeSlide(s, "APPENDIX · INTERCEPTORS", "Wrapping all four RPC shapes, not just unary", LANG,
    [
      "def _with_logging(handler: grpc.RpcMethodHandler, method: str, start: float) -> grpc.RpcMethodHandler:",
      "    def log_outcome(context: grpc.aio.ServicerContext) -> None:",
      "        code = context.code() or grpc.StatusCode.OK",
      "        logger.info(\"grpc_call method=%s status=%s duration_ms=%.1f\", method, code.name, ...)",
      "",
      "    if handler.response_streaming:",
      "        inner = handler.stream_stream if handler.request_streaming else handler.unary_stream",
      "        async def wrapped(request_or_iterator, context):",
      "            try:",
      "                async for response in inner(request_or_iterator, context):",
      "                    yield response",
      "            finally:",
      "                log_outcome(context)",
      "        ctor = (grpc.stream_stream_rpc_method_handler if handler.request_streaming",
      "                else grpc.unary_stream_rpc_method_handler)",
      "    else:",
      "        inner = handler.stream_unary if handler.request_streaming else handler.unary_unary",
      "        async def wrapped(request_or_iterator, context):",
      "            try:",
      "                return await inner(request_or_iterator, context)",
      "            finally:",
      "                log_outcome(context)",
      "        ctor = (grpc.stream_unary_rpc_method_handler if handler.request_streaming",
      "                else grpc.unary_unary_rpc_method_handler)",
      "    return ctor(wrapped, request_deserializer=handler.request_deserializer,",
      "                response_serializer=handler.response_serializer)",
    ],
    "examples/12-interceptors/python/app/interceptors.py: the auth interceptor's rejection path builds a matching fake handler the same way.",
    { fontSize: 9 });
  addNotes(s, "The body section's interceptor slides only showed the unary branch for space. This is the complete _with_logging helper, and it's worth the extra depth because RoutingService itself isn't all-unary (NegotiateRoute is bidirectional streaming), so an interceptor sitting in front of the whole service has to handle every shape the service declares, not just the one a given chapter's verify.sh happens to call. The branching is on handler.response_streaming and handler.request_streaming, the two booleans every RpcMethodHandler carries, and each of the four combinations gets its own wrapped function and its own *_rpc_method_handler constructor, because grpc.RpcMethodHandler is a tagged structure, not a single callable interface; you can't build a generic wrapper without knowing which of the four shapes you're reconstructing. The streaming branch's wrapped function is itself an async generator, re-yielding from inner inside a try/finally so log_outcome fires exactly once, after the stream is fully consumed, regardless of success or an exception partway through.");
}

{
  const s = S();
  addCodeSlide(s, "APPENDIX · AUTHN", "mint_token.py: the four demo JWT cases", LANG,
    [
      "_CASES = (\"valid\", \"expired\", \"wrong-scope\", \"bad-sig\")",
      "",
      "def mint(case: str) -> str:",
      "    now = int(time.time())",
      "    claims = {\"sub\": \"demo-client\", \"scope\": \"quote:read\", \"iat\": now, \"exp\": now + 300}",
      "    secret = SECRET",
      "",
      "    if case == \"expired\":",
      "        claims[\"exp\"] = now - 300",
      "    elif case == \"wrong-scope\":",
      "        claims[\"scope\"] = \"shipments:write\"",
      "    elif case == \"bad-sig\":",
      "        secret = WRONG_SECRET",
      "",
      "    return jwt.encode(claims, secret, algorithm=ALGORITHM)",
    ],
    "examples/20-authn-authz/python/app/mint_token.py: exp is computed at runtime, never baked into the image, so it's never stale.",
    { fontSize: 13 });
  addNotes(s, "Four cases, one baseline. valid signs with the real SECRET, sets exp five minutes in the future, and carries the quote:read scope GetQuote requires. expired is identical except exp is five minutes in the past: this proves the interceptor actually checks expiry and not just the signature. wrong-scope keeps a valid signature and a valid expiry but swaps the scope claim to one GetQuote doesn't require, demonstrating that authentication and authorization are separate checks: this token authenticates fine and only fails the later authorization step. bad-sig signs the identical claims with WRONG_SECRET, the token a caller gets by guessing wrong about the shared secret or forging one without ever having seen the real one; a server that only knows SECRET has to reject it. Minting happens at runtime, inside the already-built image, specifically so exp is always computed against the moment verify.sh actually calls GetQuote, never a timestamp baked in at build time that would eventually go stale between a build and a much later test run.");
}

{
  const s = S();
  addCodeSlide(s, "APPENDIX · PERFORMANCE", "keepalive_client.py and gzip_client.py", LANG,
    [
      "# keepalive_client.py — proves a keepalive-configured channel survives",
      "# an idle gap on the SAME channel, no reconnect needed.",
      "_KEEPALIVE_OPTIONS = [",
      "    (\"grpc.keepalive_time_ms\", 5_000),",
      "    (\"grpc.keepalive_timeout_ms\", 5_000),",
      "    (\"grpc.keepalive_permit_without_calls\", 1),",
      "]",
      "channel = grpc.aio.insecure_channel(target, options=_KEEPALIVE_OPTIONS)",
      "first = await stub.GetQuote(_REQUEST)",
      "await asyncio.sleep(idle_seconds)",
      "second = await stub.GetQuote(_REQUEST)  # same channel, after the idle gap",
      "",
      "# gzip_client.py — per-call compression changes wire bytes, never content.",
      "plain = await stub.ListRoutes(request)",
      "gzipped = await stub.ListRoutes(request, compression=grpc.Compression.Gzip)",
      "assert plain == gzipped",
    ],
    "examples/18-performance-tuning/python/app/keepalive_client.py + app/gzip_client.py.",
    { fontSize: 12 });
  addNotes(s, "Two more performance-tuning clients referenced in the body section's perf callout, shown in full here. keepalive_client.py builds one channel with the identical keepalive options the server uses, calls GetQuote once, sleeps past the configured keepalive window while making no calls at all, then calls GetQuote again on the same channel, proving the configured pings kept the connection alive across an idle gap that would otherwise risk a silent drop behind a NAT or load balancer, even though this book's flat container network has no such intermediary to actually trigger one. gzip_client.py proves the complementary, purely functional point: requesting the same ListRoutes page once with default compression and once with grpc.Compression.Gzip set explicitly on the call must decode to byte-identical responses, because compression changes wire bytes, never message content; a mismatch here would mean a bug in the compression path, not an expected side effect of asking for a smaller payload.");
}

{
  const s = S();
  addCodeSlide(s, "APPENDIX · PERFORMANCE", "pooled_client.py: the channel-reuse fix, measured", LANG,
    [
      "async def run(target: str, calls: int) -> int:",
      "    # ONE channel, ONE stub, built once, outside the loop.",
      "    channel = grpc.aio.insecure_channel(target)",
      "    stub = routing_pb2_grpc.RoutingServiceStub(channel)",
      "",
      "    amounts: list[str] = []",
      "    start = time.monotonic()",
      "    try:",
      "        for i in range(calls):",
      "            # Same stub, same underlying channel, every call below.",
      "            response = await stub.GetQuote(_REQUEST)",
      "            amounts.append(response.quote.amount)",
      "    finally:",
      "        await channel.close()",
      "    elapsed = time.monotonic() - start",
      "    print(f\"{elapsed:.6f}\")",
    ],
    "examples/18-performance-tuning/python/app/pooled_client.py: footgun_client.py (not shown) opens a fresh channel per call for the comparison.",
    { fontSize: 13 });
  addNotes(s, "This is the fix side of the channel-reuse comparison the body section's perf callout referenced. One channel and one stub are built once, before the loop, and every one of the calls in that loop reuses that same stub: the HTTP/2 connection's setup cost, TCP handshake plus TLS handshake where applicable, is paid exactly once, before the first call, rather than once per call. The companion footgun_client.py, not shown here, performs the identical workload but builds a brand-new channel inside the loop for every single call: the mistake Chapter 7 warns against from the very first unary example in this deck. Run both against the same target with the same call count and the elapsed-time gap between them is the entire argument for 'build a channel once and reuse it,' made with a stopwatch instead of a claim.");
}

{
  const s = S();
  addCodeSlide(s, "APPENDIX · SCHEMA DESIGN", "The complete ListRoutes servicer", LANG,
    [
      "class RoutingServiceServicer(routing_pb2_grpc.RoutingServiceServicer):",
      "    async def ListRoutes(self, request, context) -> routing_pb2.ListRoutesResponse:",
      "        page_size = request.page_size",
      "        if page_size <= 0:",
      "            page_size = DEFAULT_PAGE_SIZE",
      "        elif page_size > MAX_PAGE_SIZE:",
      "            page_size = MAX_PAGE_SIZE",
      "",
      "        token = request.page_token",
      "        if not token:",
      "            start = 0",
      "        else:",
      "            try:",
      "                start = int(token)",
      "            except ValueError:",
      "                await self._abort_invalid_page_token(context, token)",
      "            if start < 0 or start > len(CATALOG):",
      "                await self._abort_invalid_page_token(context, token)",
      "",
      "        end = min(start + page_size, len(CATALOG))",
      "        page = CATALOG[start:end]",
      "        try:",
      "            projected = [_apply_field_mask(route, request.field_mask) for route in page]",
      "        except ValueError as exc:",
      "            await self._abort_invalid_field_mask(context, str(exc))",
      "        next_page_token = str(end) if end < len(CATALOG) else \"\"",
      "        return routing_pb2.ListRoutesResponse(routes=projected, next_page_token=next_page_token)",
    ],
    "examples/13-schema-design/python/app/routing_service.py, complete: invalid page tokens and invalid masks both abort with a BadRequest detail.",
    { fontSize: 9 });
  addNotes(s, "The body section's schema-design code slide compressed this for space; here's the complete method, including the two abort paths the earlier slide only mentioned in notes. An out-of-range or non-numeric page_token aborts through _abort_invalid_page_token, which packs a BadRequest field violation naming page_token specifically: never a generic INTERNAL error, because a malformed continuation token is a client mistake the client can act on, not a server fault. A field_mask naming a path Route doesn't have raises ValueError inside the list comprehension, caught just outside it, and aborts through the parallel _abort_invalid_field_mask helper with the same BadRequest shape, naming field_mask instead. Both abort helpers funnel through the identical _abort_rich static method the error-handling section's code slide showed; this servicer and Chapter 11's error-handling servicer share that exact helper, because the rich-error pattern is meant to be reused verbatim across every chapter that needs it, not reinvented per chapter.");
}

{
  const s = S();
  addContentTitle(s, "APPENDIX · DEBUGGING", "Reflection, channelz & grpcurl reference");
  addBullets(s, [
    "grpcurl -plaintext host:port list / describe: server reflection, no local .proto copy needed, works over TLS/mTLS too.",
    "GRPC_TRACE=call_error,api GRPC_VERBOSITY=DEBUG python -m app.trace_probe host:port: C-core transport logging to stderr.",
    "grpc-channelz (grpcio-channelz) exposes live channel/subchannel/socket state over gRPC itself: a debugging API, not a log.",
    "grpc.StatusCode.UNAVAILABLE on a cold channel vs. grpcurl's pre-flight dial error: same failure, two different shapes.",
    "grpc_health.v1.Health/Check -d '{\"service\":\"shipping.routing.v1.RoutingService\"}': service-scoped liveness, not just the socket.",
  ], { fontSize: 15 });
  addNotes(s, "A quick reference for the debugging tools this deck's body section introduced, gathered in one place. Server reflection is the one capability every chapter in this book turns on, specifically so grpcurl never needs a local checked-out copy of the .proto to list services or describe a method's shape, and it works identically whether the port is plaintext, TLS, or mTLS, since reflection is itself an ordinary unary RPC. GRPC_TRACE and GRPC_VERBOSITY surface the C-core's own internal logging; narrowing GRPC_TRACE to one or two tracer names, call_error and api being common starting points, keeps the output usable rather than overwhelming. grpc-channelz, a separate optional service grpcio-channelz adds, exposes a running process's live channel and subchannel state as a queryable gRPC API in its own right: different from a log line, since it reflects current state, not a historical event. The UNAVAILABLE-versus-dial-error distinction is worth remembering on its own: a real application's lazily-dialing channel reports a cold target as a gRPC status on the first RPC, while grpcurl's blocking dial reports the identical condition as a transport-level error with no status code at all.");
}

{
  const s = S();
  addContentTitle(s, "APPENDIX · ON OPENSHIFT LOCAL", "Where OpenShift Local fits this book");
  addBullets(s, [
    "Generic Kubernetes (minikube) is this book's primary target for every pattern in this deck, the load-balancing section's cluster demo included.",
    "This book's OpenShift Local (CRC) appendix exercises the Quarkus stack specifically (binary S2I build, Routes, OSSM + STRICT mTLS); there is no Python variant of that appendix example in this repository.",
    "Nothing in the Python stack's contract, servicer code, or TLS/mTLS setup is OpenShift-specific; the same UBI 10 base images and the same add_secure_port call this deck's TLS section showed would carry over to any Kubernetes distribution.",
    "This deck does not claim a Python run against OpenShift Local that hasn't been built; see the Quarkus sibling deck for the verified CRC walkthrough.",
  ], { fontSize: 15 });
  addNotes(s, "This book's generic-Kubernetes target, minikube, is what every pattern in this deck (including the load-balancing section's pinned-pod-baseline and headless-plus-round-robin-fix cluster demo) runs against and is verified on. The book's separate OpenShift Local appendix, which walks through a binary S2I build, Routes, and OpenShift Service Mesh with STRICT mTLS, is a Quarkus-stack example; there is no python/ directory under that example in this repository, so nothing in this deck claims a Python run against OpenShift Local that was built and verified. Nothing about the Python stack's contract, servicer code, or TLS/mTLS wiring is OpenShift-specific: the identical UBI 10 base images and the identical grpc.ssl_server_credentials/add_secure_port call this deck's TLS section showed would carry over to any Kubernetes distribution without modification. For the verified OpenShift Local walkthrough, see the Quarkus sibling deck.");
}

pres.writeFile({ fileName: OUT })
  .then((p) => console.log("WROTE", p, "slides:", pageNum))
  .catch((e) => { console.error(e); process.exit(1); });
