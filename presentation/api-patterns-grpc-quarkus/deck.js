// deck.js — "API Patterns & Practices: gRPC — Quarkus Implementation".
// How the gRPC patterns are built in Quarkus (quarkus-grpc, Mutiny Uni/Multi),
// shipping/cargo domain, against one Protobuf contract. Real code from
// examples/*/quarkus/**.
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
  addStatusTable, addCaption, addCodeSlide, addDiagramSlide,
  addSectionDivider, addNotes,
} = H;

const OUT = path.resolve(__dirname, "api-patterns-grpc-quarkus-r1.1.pptx");
const REV = "r1.1";

const pres = newDeck();
pres.title = "API Patterns & Practices: gRPC, Quarkus Implementation";
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
  s.addText([{ text: "The Quarkus", options: { breakLine: true } }, { text: "implementation." }], {
    x: 5.95, y: 2.28, w: 6.95, h: 2.00, fontFace: FONT.title, fontSize: 48, bold: true, color: COLOR.ink, align: "left", valign: "top" });
  s.addText("Every gRPC pattern from the concepts deck, built in Quarkus: generated Mutiny stubs, Uni/Multi streaming, deadlines, interceptors, mTLS, and JWT, in the shipping & cargo domain, against one Protobuf contract.", {
    x: 6.00, y: 4.30, w: 6.80, h: 1.30, fontFace: FONT.body, fontSize: 16, italic: true, color: COLOR.caption, align: "left", valign: "top" });
  s.addText([
    { text: "Robert Sedor", options: { bold: true, color: COLOR.ink, breakLine: true } },
    { text: "Principal Chief Architect, Application Development", options: { color: COLOR.caption } },
  ], { x: 6.00, y: 5.75, w: 6.70, h: 0.80, fontFace: FONT.body, fontSize: 15, align: "left", valign: "top" });
  s.addText(REV, { x: 11.85, y: 6.40, w: 0.95, h: 0.30, fontFace: FONT.mono, fontSize: 11, color: COLOR.caption, align: "right", valign: "middle" });
  try { s.addImage({ path: `${ASSETS}/logo-candidate-2.png`, x: 11.10, y: 6.80, w: 1.55, h: 0.37 }); } catch (e) {}
  addNotes(s, "Welcome to the Quarkus implementation deck. This is deck two of three in the API Patterns & Practices: gRPC series. The concepts deck established the patterns and the reasoning, stack-agnostic; this deck shows how each of those patterns is actually built in Quarkus: the quarkus-grpc extension, generated Mutiny stubs, Uni for unary calls and Multi for every streaming shape, against the same shared Protobuf contract and the same shipping and cargo domain. Everything you'll see is real code pulled from the site's runnable examples under examples star slash quarkus. The through-line is Quarkus's defining choice for gRPC: generate the stub at build time from the shared .proto files, wire it into CDI as an injectable bean, and let Mutiny's reactive types carry backpressure and cancellation without extra code. I'm Robert Sedor. By the end you'll have seen the generated service interface, well-known-type usage, all four RPC shapes, deadline propagation across a real downstream hop, the rich error model, interceptors, FieldMask projection, the buf breaking-change gate, three concurrency models on one method, a server-owned async operation, demand-driven streaming at scale, performance tuning knobs, mTLS, JWT authorization, OpenTelemetry tracing, the load-balancing failure mode on a real cluster and its fixes, JSON/HTTP transcoding through Envoy, @QuarkusTest, a deadline-exceeded repro, and the Final Project that ties every one of those together in one process.");
}

/* ======================= 2 · AGENDA ======================= */
{
  const s = S();
  addContentTitle(s, "ROADMAP", "Agenda");
  addTwoColBullets(s,
    [
      "Setup, codegen & the generated stub",
      "Well-known types & the unary RPC",
      "Server, client & bidirectional streaming",
      "Deadlines, rich errors & interceptors",
      "Schema design & the evolution gate",
      "Concurrency: blocking, event-loop, virtual threads",
    ],
    [
      "Async operations: poll, watch, cancel",
      "Streaming at scale & performance tuning",
      "mTLS, JWT authorization & observability",
      "Load balancing on a real cluster",
      "grpc-web & JSON/HTTP transcoding",
      "Testing, debugging & the Final Project",
    ],
    { fontSize: 15 });
  addNotes(s, "The arc follows the same pattern order as the concepts deck, so the two map one to one, but every stop here is Quarkus code. We open with quarkus-grpc's build-time codegen and the generated service interface, then well-known types and the unary RPC. The middle covers all three streaming shapes in Mutiny, the deadline-and-cancellation plumbing across a real downstream call, the rich google.rpc.Status error model, and the one interceptor bean that does auth and logging for every RPC. Then schema design: FieldMask projection and pagination, and the buf breaking-change gate that keeps evolution safe. We go deep on concurrency: the same blocking I/O call run on the worker pool, pinned to one event loop, and on a virtual thread, so you can see the cost of each model side by side. From there: a server-owned long-running operation with poll and watch RPCs, demand-driven streaming that only produces when there's demand, and the performance knobs: message size, keepalive, compression. Security is mTLS plus a JWT-and-scopes interceptor; observability is OpenTelemetry trace propagation across a loopback hop plus the built-in health service. Load balancing is the one example that runs on a real Kubernetes cluster rather than Docker Compose, because the failure mode it demonstrates only exists with more than one replica. We close with grpc-web and JSON transcoding through Envoy, the @QuarkusTest suite that gates every build, a deadline-exceeded repro, and the Final Project: every pattern in this deck, in one process. A substantial appendix carries full listings. Speaker notes on every slide, appendix included.");
}

/* ======================= 3 · SERIES MAP ======================= */
{
  const s = S();
  addContentTitle(s, "SERIES MAP", "Where this deck sits");
  addBullets(s, [
    "The concepts deck is the patterns and the why, stack-agnostic. Start there for the reasoning behind a shape before it shows up here as code.",
    "This deck is the Quarkus HOW: the same shipping/cargo contract realized with quarkus-grpc and Mutiny, with real code.",
    "A sibling deck does the identical arc in Python/grpcio; both are generated from, and validated against, the one Protobuf contract in CI.",
    "Code shown here is lifted from examples/*/quarkus/**; versions are pinned (Quarkus 3.40.1 LTS on JDK 25).",
  ], { fontSize: 17 });
  addCaption(s, "Same patterns, same domain, same contract. This deck is the Quarkus realization of them.");
  addNotes(s, "A quick orientation so the three decks compose rather than repeat. The concepts deck is where the patterns and the reasoning live: if a design question comes up today about why a shape looks the way it does, that deck answers it without committing to a language. This deck is the Quarkus how: it takes each of those patterns and shows the actual Quarkus code that implements it, against the same shipping and cargo contract. There's a sibling deck that walks the identical arc in Python with grpcio, and the point of having both is that the two implementations are generated from, and validated against, one shared .proto contract, so a client can't tell which stack answered. Everything I show is real, lifted from the runnable examples under examples slash star slash quarkus, and the versions are pinned, Quarkus 3.40.1 LTS on JDK 25, so what you see is what runs.");
}

/* ======================= DIVIDER 00 — SETUP & CODEGEN ======================= */
divider("00", "Setup, codegen & the stub",
  "quarkus-grpc generates the Mutiny service interface from the shared .proto at build time.",
  "Every chapter in this deck starts from the same place: the quarkus-grpc extension reading the shared contract's .proto files during the Maven build and emitting a generated Mutiny service interface, with zero hand-written stub code. This section grounds that pipeline in the one anchor every other chapter in the book builds on: GetQuote.");

/* --- codegen diagram --- */
{
  const s = S();
  addDiagramSlide(s, "SETUP & CODEGEN", "One contract, one build-time codegen step",
    "05-contract-first-buf-flow",
    "The shared .proto under contracts/proto/ is copied into src/main/proto/ at image build time; quarkus-grpc generates the Mutiny stub from there.",
    { x: 1.10, y: 1.72, w: 11.13, h: 4.60 });
  addNotes(s, "contracts/proto/ is the single source of truth for every example in the book: it is never duplicated into a Quarkus module's source tree by hand. Instead, the Containerfile for each example COPYs exactly the .proto files that module needs into src/main/proto/ as part of the image build, and the quarkus-maven-plugin's packaging type, quarkus, binds proto code generation to the generate-sources phase, before compile. No separate protoc invocation, no protobuf-maven-plugin configuration: the quarkus-grpc extension on the classpath is what triggers it. The output is a generated Mutiny service interface, RoutingService in this chapter's case, with one method per RPC, returning Uni for unary and client-streaming methods and Multi for server-streaming and bidirectional ones. A Quarkus bean implements that interface and is discovered automatically. For a local, non-container mvn package, the same copy has to happen by hand first; the buf CLI's buf lint and buf breaking gates, covered later in this deck, run against contracts/proto/ directly in CI, independent of any one stack's build.");
}

/* --- pom.xml + application.properties --- */
{
  const s = S();
  addCodeSlide(s, "SETUP & CODEGEN", "pom.xml: one dependency, one packaging type", "java · Quarkus",
    [
      "<!-- examples/05-contract-first/quarkus/pom.xml -->",
      "<packaging>quarkus</packaging>  <!-- binds codegen to generate-sources, before compile -->",
      "",
      "<dependencies>",
      "  <!-- Generates Mutiny stubs from src/main/proto/**.proto at build time",
      "       and runs the gRPC server; no separate protoc/protobuf-maven-plugin",
      "       configuration needed. -->",
      "  <dependency>",
      "    <groupId>io.quarkus</groupId>",
      "    <artifactId>quarkus-grpc</artifactId>",
      "  </dependency>",
      "  <dependency>",
      "    <groupId>io.quarkus</groupId>",
      "    <artifactId>quarkus-opentelemetry</artifactId>",
      "  </dependency>",
      "</dependencies>",
    ],
    "The quarkus-maven-plugin's build goal drives codegen: no extra plugin wiring beyond the quarkus-grpc dependency itself.",
    { fontSize: 13 });
  addNotes(s, "Two things make this pom.xml different from an ordinary Java library module. First, packaging is quarkus, not jar: that custom lifecycle is what runs proto code generation before compilation, every time. Second, the only dependency this module needs for gRPC is quarkus-grpc itself; it pulls in grpc-java, the Mutiny bindings, and the build-time codegen step as one extension. quarkus-opentelemetry is added here too because every example in the book instruments its gRPC server automatically the moment that extension is on the classpath: quarkus.otel.instrument.grpc defaults to on, so GetQuote calls produce spans once an OTLP endpoint is reachable, with no code change. The dependencyManagement block imports the quarkus-bom at 3.40.1, the same pin every chapter in the book holds, so a version mismatch between chapters is never the reason an example behaves differently.");
}

{
  const s = S();
  addCodeSlide(s, "SETUP & CODEGEN", "application.properties: the gRPC server's own port", "properties · Quarkus",
    [
      "# examples/05-contract-first/quarkus/src/main/resources/application.properties",
      "quarkus.grpc.server.port=9000",
      "quarkus.grpc.server.host=0.0.0.0",
      "",
      "# Server reflection is on by default in dev mode only — verify.sh drives",
      "# grpcurl's reflection client in every mode, so it must be explicit here.",
      "quarkus.grpc.server.enable-reflection-service=true",
      "",
      "quarkus.otel.exporter.otlp.endpoint=${OTEL_EXPORTER_OTLP_ENDPOINT:http://localhost:4317}",
      "quarkus.otel.service.name=ch05-routing-quarkus",
    ],
    "The gRPC server listens on its own port, separate from the HTTP port: a quarkus-grpc default this whole book relies on.",
    { fontSize: 14 });
  addNotes(s, "quarkus.grpc.server.port and .host configure the gRPC Java server, a separate Netty server from the Vert.x HTTP server Quarkus REST would use, which is why examples that combine a REST front door with gRPC, like the observability and Final Project chapters, run two independent listeners in one process with no port conflict. enable-reflection-service is explicit here because it defaults to on only in dev mode, and this book's verify.sh scripts drive grpcurl's reflection client against the packaged container in every mode, not just dev, so every chapter's properties file turns it on explicitly for the server it ships. The OTel lines are the same pattern across every chapter: they point at an OTLP endpoint that falls back to localhost:4317 and simply fail soft, logged but non-fatal, when nothing is listening, so turning on the opt-in observability profile is the only thing that changes, never whether the service starts.");
}

/* ======================= DIVIDER 01 — PROTOBUF & WKT ======================= */
divider("01", "Well-known types in Java",
  "google.protobuf.Timestamp and Money-as-decimal-string, generated into protobuf-java's own compiled classes.",
  "Every compiled Protobuf message in Java is a plain, immutable, builder-pattern class: no reflection, no proxies. The well-known types are no exception: com.google.protobuf.Timestamp ships inside protobuf-java itself, the same jar quarkus-grpc already pulls in to generate every message this contract defines.");

{
  const s = S();
  addDiagramSlide(s, "WELL-KNOWN TYPES", "The well-known-type catalog",
    "04-wellknown-catalog",
    "Timestamp, Duration, FieldMask, and the wrapper types are compiled classes inside protobuf-java, not custom types this contract invents.",
    { x: 1.10, y: 1.72, w: 11.13, h: 4.60 });
  addNotes(s, "This figure is the catalog later slides draw from: Timestamp and Duration for points and spans of time, FieldMask for partial reads and writes (the ListRoutes anchor later in this deck), and the wrapper types for a scalar that needs to distinguish zero from unset. None of these are invented by this book's contract; they're part of the Protobuf standard library, shipped in every language's generated-code runtime, including protobuf-java. The next slide shows the Java side of the first two: a Route whose Leg carries real departs_at and arrives_at Timestamps, and a Money whose amount is a decimal string, never a binary float, the same convention the sibling REST site's JSON Schema enforces for the identical shape.");
}

{
  const s = S();
  addCodeSlide(s, "WELL-KNOWN TYPES", "Timestamp & decimal Money, built in Java", "java · Quarkus",
    [
      "// examples/04-well-known-types/quarkus/.../RouteBuilder.java",
      "private static final Instant DEPARTS_AT = Instant.parse(\"2026-02-01T10:00:00Z\");",
      "private static final Instant ARRIVES_AT = Instant.parse(\"2026-02-18T06:00:00Z\");",
      "",
      "Types.Leg leg = Types.Leg.newBuilder()",
      "        .setCarrier(CARRIER)",
      "        .setDepartsAt(toTimestamp(DEPARTS_AT))",
      "        .setArrivesAt(toTimestamp(ARRIVES_AT))",
      "        .build();",
      "",
      "// Money.amount is a decimal STRING, never a binary float.",
      "Types.Money price = Types.Money.newBuilder()",
      "        .setCurrency(\"USD\").setAmount(\"4200.00\").build();",
      "",
      "// com.google.protobuf.Timestamp ships inside protobuf-java itself.",
      "private static Timestamp toTimestamp(Instant instant) {",
      "    return Timestamp.newBuilder()",
      "            .setSeconds(instant.getEpochSecond())",
      "            .setNanos(instant.getNano())",
      "            .build();",
      "}",
    ],
    "Fixed, deterministic instants, not Instant.now(), so both the Quarkus and Python stacks render byte-identical JSON for the same request.",
    { fontSize: 12 });
  addNotes(s, "Two decisions in this one class carry the whole well-known-types lesson. First, toTimestamp converts a java.time.Instant into com.google.protobuf.Timestamp by hand, seconds and nanos, because that conversion is exactly what the well-known type is: a message with two int64/int32 fields and a documented JSON mapping, RFC 3339 on the wire, nothing more exotic. Second, Money.amount is a string, '4200.00', not a double, the same decimal-as-string convention this book's contract uses everywhere money appears, because a binary float cannot represent currency amounts exactly and every language's JSON number type has different precision guarantees. The instants here are fixed, not Instant.now(), so this chapter's verify.sh can assert an exact RFC 3339 string in the response and so the Python stack's identical RouteBuilder equivalent produces byte-identical output for the same request: one contract, two independent implementations, proven identical by the test, not just by inspection.");
}

/* ======================= DIVIDER 02 — UNARY ======================= */
divider("02", "Unary RPCs & the generated stub",
  "The generated Mutiny interface, implemented as a @GrpcService bean: the shape every later chapter builds on.",
  "GetQuote is this book's anchor RPC: unary request, unary response, implemented identically in every chapter that doesn't change it, so a diff between chapters shows exactly what that chapter adds.");

{
  const s = S();
  addCodeSlide(s, "UNARY RPCS", "RoutingServiceImpl.getQuote: Uni, not a callback", "java · Quarkus",
    [
      "// examples/07-unary-rpcs/quarkus/.../RoutingServiceImpl.java",
      "@GrpcService",
      "public class RoutingServiceImpl implements RoutingService {",
      "",
      "    @Override",
      "    public Uni<Routing.GetQuoteResponse> getQuote(Routing.GetQuoteRequest request) {",
      "        Types.Location origin = request.getOrigin();",
      "        Types.Location destination = request.getDestination();",
      "        Types.Money quote = QuoteCalculator.compute(request.getCargoList());",
      "",
      "        Types.Route route = Types.Route.newBuilder()",
      "                .setId(\"rte_\" + origin.getUnLocode() + \"-\" + destination.getUnLocode())",
      "                .addLegs(Types.Leg.newBuilder().setCarrier(CARRIER)",
      "                        .setOrigin(origin).setDestination(destination).build())",
      "                .setPrice(quote)",
      "                .build();",
      "",
      "        Routing.GetQuoteResponse response = Routing.GetQuoteResponse.newBuilder()",
      "                .setQuote(quote).setRoute(route).build();",
      "        return Uni.createFrom().item(response);",
      "    }",
      "}",
    ],
    "RoutingService is the generated interface; @GrpcService is the one annotation that registers this bean as its implementation.",
    { fontSize: 12 });
  addNotes(s, "RoutingService here is not hand-written: it's the interface quarkus-grpc generated from the shared .proto in the previous section, one method per RPC, each returning a Mutiny Uni or Multi depending on the RPC's shape. @GrpcService is the only annotation needed to register this class as that interface's implementation; there's no manual server registration, no manual port binding beyond what application.properties already configured. Uni.createFrom().item(response) is the simplest possible Uni: it resolves immediately, synchronously, with the one response value: no thread hop, no I/O wait. Every later chapter that touches GetQuote changes only the body of this method; the four other RoutingService methods declared on the same proto, FindOptimalRoute, ListRoutes, NegotiateRoute, RecomputeRoutes, return UNIMPLEMENTED here and pick up real implementations in later chapters, so each chapter's diff against this one shows exactly what it adds.");
}

/* ======================= DIVIDER 03 — STREAMING ======================= */
divider("03", "Streaming: server, client & bidi",
  "Multi for everything that isn't one response: built from a fixed sequence, folded from an inbound stream, or mapped 1:1.",
  "The same generated-interface, same-@GrpcService shape extends naturally to streaming: Multi<T> in either direction, composed with Mutiny's operators instead of hand-rolled iterator or callback code.");

{
  const s = S();
  addDiagramSlide(s, "SERVER STREAMING", "One request, a sequence of responses",
    "08-server-streaming",
    "Multi.createFrom().items(...) emits events as DATA frames on the one HTTP/2 stream the call opened; completing the Multi is the server's half-close.",
    { x: 1.30, y: 1.72, w: 10.73, h: 4.55 });
  addNotes(s, "WatchShipment is this chapter's server-streaming anchor: one WatchShipmentRequest in, a Multi of WatchShipmentResponse out. The server builds a fixed, four-event tracking sequence and returns Multi.createFrom().items(...).map(...): no explicit 'end of stream' call is needed, because the Multi completing is exactly what signals the server's half-close to the HTTP/2 stream underneath. Ten lines of Java are the entire implementation; everything about framing, flow control, and stream lifecycle is Mutiny's and grpc-java's problem, not this method's. The next slide shows the other two shapes: client streaming folds many requests into one response, and bidirectional streaming maps each inbound item to an outbound one without buffering the whole stream first.");
}

{
  const s = S();
  addCodeSlide(s, "STREAMING", "Client streaming (fold) & bidi (1:1 map)", "java · Quarkus",
    [
      "// examples/09-client-and-bidi-streaming/quarkus/.../TrackingServiceImpl.java",
      "",
      "// Client streaming: fold every inbound item into ONE response.",
      "@Override",
      "public Uni<ReportPositionsResponse> reportPositions(Multi<ReportPositionsRequest> request) {",
      "    return request.collect().asList()",
      "            .onItem().transform(reports -> ReportPositionsResponse.newBuilder()",
      "                    .setAcceptedCount(reports.size())",
      "                    .build());",
      "}",
      "",
      "// Bidirectional: 1:1 map — N requests in produces N responses out, in order,",
      "// WITHOUT buffering the whole stream first (unlike reportPositions above).",
      "@Override",
      "public Multi<SyncResponse> sync(Multi<SyncRequest> request) {",
      "    return request.onItem().transform(req ->",
      "            SyncResponse.newBuilder().setEvent(req.getEvent()).build());",
      "}",
    ],
    "collect().asList() buffers until the client half-closes; onItem().transform() streams a response per request with no buffering.",
    { fontSize: 13 });
  addNotes(s, "Two different Mutiny operators for two different shapes, and the contrast is the lesson. reportPositions is client-streaming, one response for the whole call, so request.collect().asList() is exactly right: it subscribes to the inbound Multi, buffers every ReportPositionsRequest until the client half-closes its side (no more coming), and completes the returned Uni with the full list at that point, exactly the 'count what arrived, ack once' shape the proto describes. sync is bidirectional, a response per request, interleaved, so request.onItem().transform(...) is the correct operator instead: it's a 1:1 mapping that preserves arrival order and emits each SyncResponse the moment its SyncRequest arrives, without waiting for the stream to finish. A response can go out before the next request arrives; nothing is buffered. Getting these backwards, folding a bidi stream, or mapping a client-streaming one, is a common mistake this pairing makes obvious once you see them side by side.");
}

/* ======================= DIVIDER 04 — DEADLINES, ERRORS, INTERCEPTORS ======================= */
divider("04", "Deadlines, rich errors & interceptors",
  "One shared clock across a downstream hop, a machine-readable error model, and one bean for every cross-cutting concern.",
  "Three patterns that only matter once a service calls another service, or a client needs more than a status code: deadline propagation, google.rpc.Status detail objects, and a single ServerInterceptor bean wired to every RPC.");

{
  const s = S();
  addDiagramSlide(s, "DEADLINES", "One shared clock, not three independent ones",
    "10-deadline-propagation",
    "Context.current().getDeadline() reads the inbound budget; withDeadlineAfter() hands the downstream call only what's left.",
    { x: 1.30, y: 1.72, w: 10.73, h: 4.55 });
  addNotes(s, "This figure is the whole point of the next code slide: a deadline that arrives on an inbound call's grpc-timeout metadata is attached to grpc-java's Context before the handler method ever runs, and the correct way to propagate it downstream is to read what's left of that same budget, not to apply a fresh, fixed deadline to the next hop. A fixed per-client deadline configured in application.properties would ignore how much time the caller actually has left; reading Context.current().getDeadline() at each hop keeps the whole call chain on one shared clock.");
}

{
  const s = S();
  addCodeSlide(s, "DEADLINES", "Carving a downstream budget from Context", "java · Quarkus",
    [
      "// examples/10-deadlines-cancellation/quarkus/.../RoutingServiceImpl.java",
      "@GrpcClient(\"quote\")",
      "MutinyQuoteServiceGrpc.MutinyQuoteServiceStub quoteClient;",
      "",
      "Deadline inbound = Context.current().getDeadline();",
      "long downstreamBudgetMs = inbound != null",
      "        ? inbound.timeRemaining(TimeUnit.MILLISECONDS) - DOWNSTREAM_MARGIN_MS",
      "        : DEFAULT_DOWNSTREAM_BUDGET_MS;",
      "",
      "if (downstreamBudgetMs <= 0) {",
      "    // Budget already gone — fail fast, no network round trip at all.",
      "    return Uni.createFrom().failure(Status.DEADLINE_EXCEEDED",
      "            .withDescription(\"no budget remaining to call QuoteService.GetQuote\")",
      "            .asRuntimeException());",
      "}",
      "",
      "return quoteClient.withDeadlineAfter(downstreamBudgetMs, TimeUnit.MILLISECONDS)",
      "        .getQuote(downstreamRequest)",
      "        .onItem().transform(resp -> buildResponse(origin, destination, resp.getQuote()));",
    ],
    "A deadline that expires before the downstream call even starts fails locally: cheaper than discovering the same thing over the wire.",
    { fontSize: 11 });
  addNotes(s, "The downstream call here is a real gRPC hop: @GrpcClient(\"quote\") injects a Mutiny stub typed to QuoteService, wired by name in application.properties to a loopback channel. The budget math is the lesson: DOWNSTREAM_MARGIN_MS is reserved off the inbound deadline for this method's own work before the downstream slice is carved, and DEFAULT_DOWNSTREAM_BUDGET_MS only applies when a caller sets no deadline at all: gRPC permits that, but 'no deadline' must never mean 'wait forever' for the downstream hop either. When the budget is already exhausted, this method fails immediately with DEADLINE_EXCEEDED rather than making the call at all: cheaper than letting grpc-java discover the same timeout a few milliseconds later over the network. And when the downstream call does exceed its slice, grpc-java raises a StatusRuntimeException(DEADLINE_EXCEEDED) from the stub, and Quarkus's default gRPC exception mapping reuses that status verbatim, so the client that called this method sees the same DEADLINE_EXCEEDED, with no translation step needed anywhere in between.");
}

{
  const s = S();
  addDiagramSlide(s, "RICH ERRORS", "The canonical code carries the category",
    "11-rich-error-model",
    "google.rpc.Status pairs one canonical code with a typed detail (BadRequest, ErrorInfo, RetryInfo) in the gRPC trailers.",
    { x: 1.30, y: 1.72, w: 10.73, h: 4.55 });
  addNotes(s, "A bare gRPC status code tells a caller whether to retry, but not what went wrong or how to fix it. The google.rpc.Status model layered on top, from com.google.api.grpc:proto-google-common-protos, a runtime library, not something this chapter's .proto invents, carries both: the canonical Code for the retry-or-don't decision, and one or more typed Any details (BadRequest.FieldViolation for a validation failure, ErrorInfo for a structured reason code, RetryInfo for exactly how long to wait) for the specifics. The next slide shows the three deterministic cases this chapter's GetQuote triggers by input, so grpcurl -v (or any client library that knows this convention) can read the rich detail straight out of the trailers.");
}

{
  const s = S();
  addCodeSlide(s, "RICH ERRORS", "StatusProto: canonical code + typed detail", "java · Quarkus",
    [
      "// examples/11-error-handling/quarkus/.../RoutingServiceImpl.java",
      "if (!violations.isEmpty()) {",
      "    return Uni.createFrom().failure(richError(Code.INVALID_ARGUMENT,",
      "            \"invalid GetQuoteRequest: \" + fields + \" required\",",
      "            Any.pack(BadRequest.newBuilder().addAllFieldViolations(violations).build())));",
      "}",
      "if (UNROUTABLE_ORIGIN.equals(origin.getUnLocode())) {",
      "    return Uni.createFrom().failure(richError(Code.NOT_FOUND,",
      "            \"origin \" + UNROUTABLE_ORIGIN + \" is unroutable\",",
      "            Any.pack(ErrorInfo.newBuilder().setReason(\"ORIGIN_UNROUTABLE\")",
      "                    .setDomain(ERROR_DOMAIN).build())));",
      "}",
      "",
      "private static StatusRuntimeException richError(Code code, String message, Any detail) {",
      "    com.google.rpc.Status richStatus = com.google.rpc.Status.newBuilder()",
      "            .setCode(code.getNumber()).setMessage(message).addDetails(detail).build();",
      "    return StatusProto.toStatusRuntimeException(richStatus);",
      "}",
    ],
    "StatusProto.toStatusRuntimeException puts the rich google.rpc.Status into the gRPC trailers: exactly where grpcurl expects to find it.",
    { fontSize: 11 });
  addNotes(s, "Three deterministic failure cases, keyed off the input, so verify.sh can assert an exact status and an exact detail for a fixed request: a blank origin or destination UN/LOCODE produces INVALID_ARGUMENT with a BadRequest listing which fields; the literal origin 'ZZZZZ' produces NOT_FOUND with an ErrorInfo carrying a machine-readable reason code; and the literal origin 'RETRY' produces UNAVAILABLE with a RetryInfo telling the caller exactly how long to wait before trying again. richError is the one helper every case shares: it builds a com.google.rpc.Status combining the canonical numeric code, a human message, and the packed Any detail, then hands it to StatusProto.toStatusRuntimeException, which is what actually puts that rich status into the gRPC trailers, the same place any client library, grpcurl included, knows to look for it. Nothing here is Quarkus-specific; this is grpc-java's own rich-error API, usable from any JVM gRPC server.");
}

{
  const s = S();
  addCodeSlide(s, "INTERCEPTORS", "One bean, every service, two concerns", "java · Quarkus",
    [
      "// examples/12-interceptors/quarkus/.../AuthLoggingInterceptor.java",
      "@ApplicationScoped",
      "@GlobalInterceptor   // applies to every gRPC service in the application",
      "public class AuthLoggingInterceptor implements ServerInterceptor {",
      "",
      "    public <ReqT, RespT> ServerCall.Listener<ReqT> interceptCall(",
      "            ServerCall<ReqT, RespT> call, Metadata headers, ServerCallHandler<ReqT, RespT> next) {",
      "        String method = call.getMethodDescriptor().getFullMethodName();",
      "        if (!isReflection(method) && headers.get(AUTHORIZATION) == null) {",
      "            call.close(Status.UNAUTHENTICATED.withDescription(\"missing 'authorization'\"), new Metadata());",
      "            return new ServerCall.Listener<>() { };   // handler never runs",
      "        }",
      "        // Wrap the CALL (not the handler) — close() is the one place every",
      "        // RPC shape reports its final status.",
      "        ServerCall<ReqT, RespT> timedCall = new ForwardingServerCall.SimpleForwardingServerCall<>(call) {",
      "            @Override public void close(Status status, Metadata trailers) {",
      "                logOutcome(method, status, startNanos);",
      "                super.close(status, trailers);",
      "            }",
      "        };",
      "        return next.startCall(timedCall, headers);",
      "    }",
      "}",
    ],
    "@GlobalInterceptor wires one @ApplicationScoped bean to every @GrpcService with zero per-service registration.",
    { fontSize: 11 });
  addNotes(s, "@GlobalInterceptor is the Quarkus-specific part: it registers this one CDI bean against every gRPC service in the application, RoutingService included, a second @GrpcService added later would run through this exact interceptor with no extra wiring at all. Everything else is plain grpc-java. Two concerns, in order: an auth hook that reads the authorization header out of the call's Metadata, gRPC's header map, before a single byte of the request message is deserialized, and closes the call with UNAUTHENTICATED right here if it's absent, so the handler GetQuote or an UNIMPLEMENTED stub never runs at all. The server reflection service is explicitly exempted, because grpcurl list and describe need to work with no token at all. The second concern wraps the ServerCall itself, not the handler, via ForwardingServerCall: close(status, trailers) is the one place every RPC shape, unary or streaming, successful or not, reports its final status, making it the single correct place to log method, status, and elapsed time for every call.");
}

/* ======================= DIVIDER 05 — SCHEMA DESIGN & EVOLUTION ======================= */
divider("05", "Schema design & the evolution gate",
  "FieldMask projection on a paginated list, and buf breaking as the CI gate that keeps a contract change compatible.",
  "ListRoutes pages through a catalog and projects each result through the caller's FieldMask; buf breaking is what stops an incompatible change from ever reaching main.");

{
  const s = S();
  addDiagramSlide(s, "SCHEMA DESIGN", "FieldMask: project, don't filter client-side",
    "13-fieldmask-projection",
    "An unset FieldMask means 'everything'; a populated one rebuilds the message with only the named top-level paths set.",
    { x: 1.30, y: 1.72, w: 10.73, h: 4.55 });
  addNotes(s, "The key design decision FieldMask forces is what an absent mask means. This chapter's convention, and most real APIs', is that zero paths means the caller wants everything, which is the only reading that keeps ListRoutes backward compatible with a client built before the field existed. The next slide shows how that projection is actually built: not a string-matching trick, but a fresh, empty Route.Builder with only the named paths merged in, so anything not named is absent from the wire, not merely zeroed, because proto3 omits unset or default fields by construction.");
}

{
  const s = S();
  addCodeSlide(s, "SCHEMA DESIGN", "ListRoutes: pagination + FieldMaskUtil.merge", "java · Quarkus",
    [
      "// examples/13-schema-design/quarkus/.../RoutingServiceImpl.java",
      "int end = Math.min(start + pageSize, catalog.size());",
      "List<Types.Route> page = catalog.subList(start, end);",
      "",
      "FieldMask mask = request.getFieldMask();",
      "for (Types.Route route : page) {",
      "    projected.add(applyFieldMask(route, mask));",
      "}",
      "String nextPageToken = end < catalog.size() ? String.valueOf(end) : \"\";",
      "",
      "private static Types.Route applyFieldMask(Types.Route route, FieldMask mask) {",
      "    if (mask.getPathsCount() == 0) {",
      "        return route;   // unset mask == \"everything\"",
      "    }",
      "    if (!FieldMaskUtil.isValid(Types.Route.getDescriptor(), mask)) {",
      "        throw new IllegalArgumentException(\"field_mask names a path Route does not have\");",
      "    }",
      "    FieldMask normalized = FieldMaskUtil.normalize(mask);",
      "    Types.Route.Builder projected = Types.Route.newBuilder();",
      "    FieldMaskUtil.merge(normalized, route, projected);",
      "    return projected.build();",
      "}",
    ],
    "FieldMaskUtil.isValid rejects an unrecognized path outright: never silently ignored.",
    { fontSize: 11 });
  addNotes(s, "FieldMaskUtil comes from protobuf-java's util library, the same jar that ships FieldMask itself: nothing bespoke. applyFieldMask returns the route unchanged when the mask is empty, satisfying the 'unset means everything' convention from the previous slide. When the mask IS populated, FieldMaskUtil.isValid checks every named path against Route's own descriptor and rejects anything Route doesn't actually have: a typo'd path fails loudly as INVALID_ARGUMENT rather than being silently dropped. FieldMaskUtil.normalize sorts and de-duplicates the paths, and FieldMaskUtil.merge does the actual projection: it builds into a fresh, empty Route.Builder, so any field not named in the mask stays at its protobuf zero value and is therefore omitted from the wire entirely, proto3's own encoding rule, not something this code has to implement by hand. Pagination alongside it is equally plain: page_size is clamped between a default and a maximum, and page_token is just the next array offset in this demo, opaque to the client but not cryptographically anything.");
}

{
  const s = S();
  addDiagramSlide(s, "EVOLUTION GATE", "buf breaking: the CI gate against main",
    "14-buf-breaking-gate",
    "buf lint, buf build, and buf breaking --against main all run in CI before a contract change can land.",
    { x: 1.30, y: 1.72, w: 10.73, h: 4.55 });
  addNotes(s, "This is the one slide in the section that isn't Quarkus code, because the evolution gate lives in the shared contract's CI, ahead of any one stack's build, exactly the point: an incompatible schema change should never even reach the Quarkus or Python example that would have to work around it. contracts/buf.yaml configures breaking: use: FILE, the strictest of buf's breaking-change categories, meaning a changed field type, a reused field number, or a removed field on an existing message all fail the check. The GitHub Actions workflow runs three steps in order: buf lint for style, buf build -o /dev/null to confirm every import resolves, and buf breaking --against the main branch's version of contracts/proto, skipped only on the very first introduction of a proto file, when main has no baseline yet to compare against. Every chapter's own Quarkus or Python build regenerates its stubs from whatever passed this gate; no stack re-validates compatibility on its own.");
}

/* ======================= DIVIDER 06 — CONCURRENCY ======================= */
divider("06", "Concurrency: three models, one method",
  "@Blocking, pinned to one event loop, and a virtual thread: the same ~400ms of I/O, three different threading costs.",
  "The same simulated blocking lookup, dispatched three different ways from one method, makes the cost of getting Quarkus's execution model wrong directly observable.");

{
  const s = S();
  addDiagramSlide(s, "CONCURRENCY", "Quarkus's execution models",
    "15-jvm-execution-models",
    "The default @Blocking worker pool, the Vert.x event loop, and a JDK virtual thread: three ways one gRPC method can run.",
    { x: 1.30, y: 1.72, w: 10.73, h: 4.55 });
  addNotes(s, "This figure lays out the three threading models this chapter's one method switches between. The correct default for any method doing blocking I/O, a JDBC call, a blocking file read, the simulated ~400ms lookup this chapter uses, is @Blocking, which dispatches the invocation onto Quarkus's default Vert.x worker pool before a single line of the method body runs; eight concurrent calls in that mode use eight of the worker pool's threads (default size 20) and overlap in time. The event loop is the opposite case: a small, fixed pool (2x the host's CPU count by default) meant for non-blocking work only: running blocking I/O directly on it is the literal 'thread starvation' failure mode this chapter names. Virtual threads are a third, illustrative model: a fresh platform-independent thread per call, reproducing by hand what @RunOnVirtualThread does automatically when it's the sole execution-model annotation on a method.");
}

{
  const s = S();
  addDiagramSlide(s, "CONCURRENCY", "What starvation looks like under load",
    "15-thread-exhaustion-overlap",
    "Eight concurrent calls either overlap (worker pool, virtual threads) or queue behind each other on one shared event-loop thread.",
    { x: 1.30, y: 1.72, w: 10.73, h: 4.55 });
  addNotes(s, "This is the contrast the previous figure sets up, made concrete: the same eight concurrent FindOptimalRoute calls either overlap, the correct @Blocking and virtual-thread paths, or queue behind each other on a single pinned event-loop context, which is exactly what the 'starving' mode on the next slide reproduces, serialized onto one shared Vert.x context so the timing is reproducible at any core count rather than depending on how many event loops the host happens to run. The visible cost is latency: eight overlapping ~400ms calls finish in roughly 400ms total; eight serialized ones take roughly 8 times that, and, critically, so does every other request sharing that same event loop, because a starved event loop doesn't just slow down the calls routed onto it, it stalls everything else scheduled there too.");
}

{
  const s = S();
  addCodeSlide(s, "CONCURRENCY", "One method, three dispatch targets", "java · Quarkus",
    [
      "// examples/15-backend-io-concurrency/quarkus/.../RoutingServiceImpl.java",
      "@Blocking",
      "@Override",
      "public Uni<FindOptimalRouteResponse> findOptimalRoute(FindOptimalRouteRequest request) {",
      "    Supplier<FindOptimalRouteResponse> work = () -> buildResponse(originCode, destCode);",
      "    return switch (mode) {",
      "        case MODE_STARVING -> onEventLoop(work);     // WRONG: blocks the loop",
      "        case MODE_VIRTUAL -> onVirtualThread(work);  // one fresh virtual thread per call",
      "        default -> Uni.createFrom().item(work);      // CORRECT: @Blocking already hopped us off",
      "    };",
      "}",
      "",
      "private Uni<FindOptimalRouteResponse> onEventLoop(Supplier<FindOptimalRouteResponse> work) {",
      "    Context context = starvingContext();   // ONE shared context, reused every call",
      "    return Uni.createFrom().emitter(emitter -> context.runOnContext(ignored -> {",
      "        emitter.complete(work.get());   // the blocking lookup runs INSIDE the loop",
      "    }));",
      "}",
    ],
    "@Blocking is the correct default; onEventLoop reproduces the starvation bug for contrast.",
    { fontSize: 11 });
  addNotes(s, "@Blocking on the method itself is what makes the default branch correct without any extra code in the body: quarkus-grpc has already dispatched this invocation onto the Vert.x worker pool before the switch statement runs, so Uni.createFrom().item(work) in the default case runs the lookup right where it's called, no further hop needed. The 'starving' mode exists purely to demonstrate the failure this annotation prevents: Context.runOnContext schedules the identical blocking lookup onto one fixed, shared event-loop context, the same context across every starving call, rather than each call's own current context, which is what makes the serialization reproducible regardless of how many CPU cores the host has. The virtual-thread path, not shown in full here, calls Thread.ofVirtual().start(...) directly, reproducing by hand what the real @RunOnVirtualThread annotation does automatically when it's a method's only execution-model annotation: this demo can't just add that annotation to a second method, because one shared method needs to switch models at request time based on a demo-only mode flag.");
}

/* ======================= DIVIDER 07 — ASYNC OPERATIONS ======================= */
divider("07", "Async operations: poll, watch, cancel",
  "A server-owned Operation record on its own service, shared by the job that advances it and the RPCs that read it.",
  "RecomputeRoutes kicks off a long-running job; a separate OperationsService exposes GetOperation, WatchOperation, and CancelOperation against the same shared state.");

{
  const s = S();
  addDiagramSlide(s, "ASYNC OPERATIONS", "One Operation, three ways to observe it",
    "16-operation-lifecycle",
    "GetOperation polls a snapshot; WatchOperation streams progress; CancelOperation stops the job early, all against one shared OperationState.",
    { x: 1.30, y: 1.72, w: 10.73, h: 4.55 });
  addNotes(s, "This is a separate @GrpcService bean from RoutingServiceImpl, not three more methods bolted onto RoutingService: quarkus-grpc generates a fully abstract interface per service, and adding RPCs to RoutingService would be source-breaking for every existing implementation of it, even though buf breaking would never flag a new RPC as wire-incompatible. Putting the three Operation RPCs on their own OperationsService instead is the shape AIP-151 and google.longrunning.Operations both prescribe. The two beans share one @ApplicationScoped OperationRegistry, so a RecomputeRoutes call on RoutingServiceImpl and a GetOperation or WatchOperation call here read and write the exact same OperationState record: CDI injection, not a database, is what ties them together in this single-process example.");
}

{
  const s = S();
  addCodeSlide(s, "ASYNC OPERATIONS", "OperationsServiceImpl: get, watch, cancel", "java · Quarkus",
    [
      "// examples/16-async-long-running-jobs/quarkus/.../OperationsServiceImpl.java",
      "@Override",
      "public Uni<Types.Operation> getOperation(GetOperationRequest request) {",
      "    OperationState state = registry.get(request.getOperationId());",
      "    return state == null ? Uni.createFrom().failure(notFound(...)) : Uni.createFrom().item(state.snapshot());",
      "}",
      "",
      "@Override",
      "public Multi<Types.Operation> watchOperation(WatchOperationRequest request) {",
      "    OperationState state = registry.get(request.getOperationId());",
      "    // emitOn moves every emission onto the worker pool, not the event loop",
      "    // that opened this stream.",
      "    return Multi.createFrom().<Types.Operation>emitter(emitter -> streamSnapshots(state, emitter))",
      "            .emitOn(Infrastructure.getDefaultExecutor());",
      "}",
      "",
      "@Override",
      "public Uni<Types.Operation> cancelOperation(CancelOperationRequest request) {",
      "    OperationState state = registry.get(request.getOperationId());",
      "    boolean cancelledNow = state.cancel();   // synchronized — races the background job safely",
      "    return Uni.createFrom().item(state.snapshot());",
      "}",
    ],
    "watchOperation polls every 150ms server-side and completes the Multi the moment the operation reports done.",
    { fontSize: 11 });
  addNotes(s, "getOperation is the simplest lookup: a snapshot of whatever OperationState currently holds, or NOT_FOUND if the id is unknown. watchOperation is a server-streaming RPC built from an emitter, not a fixed list: streamSnapshots loops, emitting a snapshot every WATCH_POLL_MS and completing the Multi the instant the operation reports done, so a caller gets a live progress feed without polling client-side at all. emitOn(Infrastructure.getDefaultExecutor()) matters here specifically because the loop inside streamSnapshots calls Thread.sleep between emissions, exactly the blocking call the previous section's concurrency chapter warned about, so emitOn moves every emission onto the worker pool, never the event loop that accepted this stream. cancelOperation calls state.cancel(), a synchronized method on OperationState that returns true only if this call is the one that moved the operation to terminal: the mutual-exclusion that keeps a background job and a concurrent cancel from both believing they own the final transition. The full OperationState listing is in the appendix.");
}

/* ======================= DIVIDER 08 — STREAMING AT SCALE & PERFORMANCE ======================= */
divider("08", "Streaming at scale & performance",
  "Demand-driven Multi so a slow consumer applies real backpressure, plus the knobs that trade message size, latency, and CPU.",
  "A long-lived feed exposes what a four-event demo hides: production has to be gated on demand, and the server has real tuning knobs for message size, keepalive, and compression.");

{
  const s = S();
  addDiagramSlide(s, "STREAMING AT SCALE", "Demand-driven, not eager",
    "17-slow-consumer-backpressure",
    "Production starts only once MultiEmitter.requested() shows outstanding demand: a slow consumer naturally throttles the producer.",
    { x: 1.30, y: 1.72, w: 10.73, h: 4.55 });
  addNotes(s, "The earlier server-streaming anchor built its whole four-event list before the Multi even existed: fine for four fixed events, the wrong default for a feed that's actually long-lived. This chapter's WatchShipment fixes that: production is gated on demand, checked both immediately (the generated gRPC bridge's subscriber already calls Subscription.request during onSubscribe, so demand often exists from the first instant) and again on every later onRequest callback, which fires when the stream becomes ready to write more. A slow consumer that stops requesting, a cancelled call, a stream not ready to write, simply never gets another event scheduled; nothing queues up server-side waiting to be dropped. The contrast case, a booking id of bkg_eager, pre-builds and timestamps every event before the Multi exists, visibly the wrong shape once you compare the two side by side.");
}

{
  const s = S();
  addCodeSlide(s, "STREAMING AT SCALE", "demandDrivenMulti: produce only on demand", "java · Quarkus",
    [
      "// examples/17-streaming-at-scale/quarkus/.../TrackingServiceImpl.java",
      "private Multi<WatchShipmentResponse> demandDrivenMulti(",
      "        String bookingId, List<Waypoint> waypoints, long[] delaysMs) {",
      "    return Multi.createFrom().emitter(emitter -> {",
      "        AtomicInteger index = new AtomicInteger(0);",
      "        AtomicBoolean producing = new AtomicBoolean(false);",
      "        Runnable maybeStart = () -> {",
      "            if (emitter.requested() > 0 && producing.compareAndSet(false, true)) {",
      "                scheduleStep(emitter, bookingId, waypoints, delaysMs, index, producing);",
      "            }",
      "        };",
      "        // onRequest covers demand granted AFTER this lambda runs; the explicit",
      "        // maybeStart.run() below catches the INITIAL demand the bridge already sent.",
      "        emitter.onRequest(requested -> maybeStart.run());",
      "        maybeStart.run();",
      "    });",
      "}",
      "// scheduleStep: emits one event via Vertx.setTimer (never Thread.sleep),",
      "// then either chains the next step (demand remains) or stops and lets the",
      "// next onRequest() restart the chain.",
    ],
    "Vertx.setTimer paces production without blocking a thread: the pacing itself costs nothing while waiting.",
    { fontSize: 11 });
  addNotes(s, "The subtlety this slide is really about is the race between the initial demand and the onRequest callback. gRPC's reactive bridge calls Subscription.request during onSubscribe before this emitter lambda has a chance to register its onRequest handler, so that first unit of demand already landed in emitter.requested() with no callback to observe it: the explicit maybeStart.run() right after registering onRequest is what catches exactly that case; without it, a stream could sit forever waiting for a callback that already fired. scheduleStep produces exactly one event, waits via Vertx.setTimer rather than a blocking Thread.sleep so the pacing costs no thread at all, and then either chains directly into the next step if demand remains, or sets producing back to false and stops: the next onRequest call, fired when the stream becomes ready to write more, is what restarts the chain from wherever index left off. This whole mechanism is invisible to a well-behaved consumer; it only matters the moment a consumer is slow enough that demand actually runs out between events.");
}

{
  const s = S();
  addDiagramSlide(s, "PERFORMANCE", "The levers that actually move the needle",
    "18-performance-levers",
    "Message size caps, keepalive timing, and response compression: configuration, not code, and each has a real tradeoff.",
    { x: 1.30, y: 1.72, w: 10.73, h: 4.55 });
  addNotes(s, "Three independent levers, each configured, not coded. Raising the inbound message-size cap matters because quarkus-grpc's default is 4MB with the separate-server topology every chapter in this book uses: fine for GetQuote's few dozen bytes, not enough for a large incoming request or a big ListRoutes page. Keepalive timing is about surviving a silent intermediary: a load balancer or NAT device can drop an idle HTTP/2 connection out from under a long-lived channel if nothing pings it periodically. Compression is the one with a real tradeoff rather than an unconditional win: gzip is a clear improvement for ListRoutes' padded, repetitive payload, and close to a wash, all CPU cost, no size benefit, for GetQuote's tiny response, which is exactly why the next slide's config applies it server-wide only because this example's dominant payload justifies it, not as a universal default.");
}

{
  const s = S();
  addCodeSlide(s, "PERFORMANCE", "application.properties: the three knobs", "properties · Quarkus",
    [
      "# examples/18-performance-tuning/quarkus/src/main/resources/application.properties",
      "",
      "# 1. Inbound cap: separate-server mode defaults to 4MB; raised for headroom.",
      "quarkus.grpc.server.max-inbound-message-size=16777216",
      "",
      "# 2. Keepalive: ping an otherwise-idle connection so a silent intermediary",
      "#    doesn't drop it. permit-keep-alive-time is the floor this server",
      "#    tolerates on a CLIENT-initiated ping before treating it as abusive.",
      "quarkus.grpc.server.netty.keep-alive-time=5s",
      "quarkus.grpc.server.netty.permit-keep-alive-time=5s",
      "quarkus.grpc.server.netty.permit-keep-alive-without-calls=true",
      "",
      "# 3. gzip every response — a clear win for ListRoutes' padded page,",
      "#    close to a wash for GetQuote's few dozen bytes.",
      "quarkus.grpc.server.compression=gzip",
    ],
    "Verified against the installed quarkus-grpc 3.40.1 config model: the 4MB-vs-256KB split between separate- and unified-server mode is explicit in its javadoc.",
    { fontSize: 13 });
  addNotes(s, "Every one of these three knobs lives under quarkus.grpc.server because this example, like every other chapter in the book, leaves quarkus.grpc.server.use-separate-server at its default of true, which puts grpc-java's own Netty server, not the Vert.x HTTP server, in front of the gRPC service; that's also why the keepalive properties are nested one level deeper, under the Netty-specific config block, rather than the Vert.x TLS registry a unified-server setup would use. The keepalive values here, 5 seconds, are short for this example so a verify.sh script can exercise an idle gap without a slow test; a production value is typically tens of seconds to a few minutes. None of these three settings required a single line of Java to change: they're exactly the kind of tuning that should live in configuration, reviewable and environment-specific, rather than hardcoded into a servicer.");
}

/* ======================= DIVIDER 09 — SECURITY: TLS, MTLS, AUTHN & AUTHZ ======================= */
divider("09", "Security: transport and identity",
  "mTLS terminated in the gRPC Java server, and a JWT-plus-scopes interceptor layered on top of Chapter 12's shape.",
  "Transport security and caller identity are two separable layers: certificates prove the connection, a verified token with scopes decides what that caller may do.");

{
  const s = S();
  addDiagramSlide(s, "TLS & MTLS", "Mutual verification, not just encryption",
    "19-mtls-mutual-verification",
    "client-auth=REQUIRED means the handshake fails without a client certificate the server's trust-store recognizes, before any RPC runs.",
    { x: 1.30, y: 1.72, w: 10.73, h: 4.55 });
  addNotes(s, "Plain TLS proves the server's identity to the client; mTLS adds the reverse, and this chapter's server runs in REQUIRED mode, its steady state. The rejection, when it happens, is a transport-layer event, a connection reset, not a gRPC status code the application chose, because it happens in the TLS handshake itself, before a single byte of any request is deserialized and before grpc-java's own status machinery is even reachable. The next slide shows exactly how that's configured for the gRPC Java server specifically, which is a different configuration surface than the Vert.x-based alternative server mode would use.");
}

{
  const s = S();
  addCodeSlide(s, "TLS & MTLS", "quarkus.grpc.server.ssl.*: the gRPC Java server", "properties · Quarkus",
    [
      "# examples/19-tls-mtls/quarkus/src/main/resources/application.properties",
      "#",
      "# This is the gRPC JAVA server (use-separate-server defaults to true), so",
      "# TLS lives under quarkus.grpc.server.ssl.* — NOT quarkus.http.ssl.* or the",
      "# quarkus.tls.<name>.* registry, which apply to the Vert.x-based server.",
      "quarkus.grpc.server.plain-text=false",
      "quarkus.grpc.server.ssl.certificate=/certs/server.crt",
      "quarkus.grpc.server.ssl.key=/certs/server.key",
      "",
      "# This gRPC Java server's trust-store loads through Vert.x's KeyStoreHelper",
      "# and needs an actual Java keystore — a plain PEM CA is rejected outright.",
      "quarkus.grpc.server.ssl.trust-store=/certs/ca-truststore.jks",
      "quarkus.grpc.server.ssl.trust-store-password=changeit",
      "",
      "# NONE / REQUEST / REQUIRED — this example's steady state is REQUIRED.",
      "quarkus.grpc.server.ssl.client-auth=${GRPC_CLIENT_AUTH:REQUIRED}",
    ],
    "Confirmed against the installed quarkus-grpc 3.40.1 reference guide, not assumed: PEM for cert/key, a Java keystore for the trust-store.",
    { fontSize: 13 });
  addNotes(s, "Two file formats are doing different jobs here, and getting that confused is the most common mistake with this configuration surface. The server's own certificate and key accept plain PEM directly, which is what certgen (this example's own certificate generator) produces. The trust-store, the CA that client certificates must chain to, does not accept a plain PEM CA for this server; it loads through Vert.x's KeyStoreHelper and needs an actual Java keystore, confirmed empirically against the installed quarkus-grpc 3.40.1 behavior. A PKCS12 trust-store built with openssl's pkcs12 -export -nokeys doesn't work either: it loads with zero usable trust anchors under Java's PKIX validator, so mTLS handshakes fail silently rather than cleanly. certgen uses keytool -importcert instead, producing a trust-store Java recognizes correctly. client-auth is read from an environment variable with REQUIRED as the default, specifically so a verify.sh script can flip this same image between TLS-only and mTLS without a rebuild.");
}

{
  const s = S();
  addDiagramSlide(s, "AUTHN & AUTHZ", "Bearer JWT in metadata, verified before the handler runs",
    "20-jwt-in-metadata-flow",
    "The interceptor verifies signature and expiry, then checks a per-method scope, all before RoutingServiceImpl ever runs.",
    { x: 1.30, y: 1.72, w: 10.73, h: 4.55 });
  addNotes(s, "Authentication and authorization are two separable questions, and this chapter's interceptor answers both, in order, before the handler runs. First: is this token signed by a key this server trusts, and has it not expired, a question JwtVerifier answers with dependency-light HMAC verification, no OIDC client or JWKS fetch needed because this chapter's token uses one fixed, baked-in HS256 secret with no identity provider in the loop. Second, only once that's settled: does the token's scope claim contain whatever scope this specific method requires, a question this deck's AuthzInterceptor answers with a small static map. Both failures close the call before RoutingServiceImpl.getQuote or listRoutes ever executes; the method itself never has to know authorization exists.");
}

{
  const s = S();
  addCodeSlide(s, "AUTHN & AUTHZ", "AuthzInterceptor: verify, then check scope", "java · Quarkus",
    [
      "// examples/20-authn-authz/quarkus/.../AuthzInterceptor.java",
      "private static final Map<String, String> METHOD_SCOPES = Map.of(",
      "        \"shipping.routing.v1.RoutingService/GetQuote\", \"quote:read\",",
      "        \"shipping.routing.v1.RoutingService/ListRoutes\", \"routes:admin\");",
      "",
      "String authorization = headers.get(AUTHORIZATION);",
      "if (authorization == null || !authorization.startsWith(BEARER_PREFIX)) {",
      "    return reject(call, method, startNanos, Status.UNAUTHENTICATED",
      "            .withDescription(\"missing 'authorization: Bearer <jwt>' metadata\"));",
      "}",
      "Map<String, Object> claims;",
      "try {",
      "    claims = jwtVerifier.verify(authorization.substring(BEARER_PREFIX.length()));",
      "} catch (JwtVerifier.TokenError e) {",
      "    return reject(call, method, startNanos, Status.UNAUTHENTICATED.withDescription(\"invalid token: \" + e.getMessage()));",
      "}",
      "",
      "String requiredScope = METHOD_SCOPES.get(method);",
      "if (requiredScope != null && !grantedScopes(claims).contains(requiredScope)) {",
      "    return reject(call, method, startNanos, Status.PERMISSION_DENIED",
      "            .withDescription(\"token lacks required scope '\" + requiredScope + \"'\"));",
      "}",
    ],
    "JwtVerifier does signature + exp with the JDK's own Mac and a constant-time MessageDigest.isEqual comparison: full listing in the appendix.",
    { fontSize: 11 });
  addNotes(s, "METHOD_SCOPES is the whole per-method authorization policy, expressed as one map keyed on MethodDescriptor.getFullMethodName()'s 'pkg.Service/Method' format: a method with no entry is treated as 'authenticated only.' ListRoutes is gated on routes:admin, a scope the demo tokens never carry, so calling it gets PERMISSION_DENIED before RoutingServiceImpl.listRoutes ever runs; that method would also answer UNIMPLEMENTED if it were ever reached, but that's a separate, later fact about this example's scope, not the authorization decision made here. jwtVerifier.verify does the heavy lifting the appendix shows in full: split the token into three dot-separated segments, recompute an HMAC-SHA256 over the first two with the JDK's own javax.crypto.Mac, and compare using MessageDigest.isEqual, a constant-time comparison chosen over a short-circuiting one, because a signature check that returns early on the first mismatched byte leaks how many leading bytes were correct through timing, the textbook side channel for MAC verification. Server reflection is exempted from all of this, exactly as Chapter 12's interceptor exempted it, so grpcurl can still list and describe the service with no token.");
}

/* ======================= DIVIDER 10 — OBSERVABILITY ======================= */
divider("10", "Observability & health",
  "Zero-code trace propagation across a loopback hop, Prometheus metrics, and the built-in grpc.health.v1 service.",
  "quarkus-opentelemetry instruments the gRPC client and server automatically; quarkus-micrometer-registry-prometheus and the built-in health service need nothing beyond being on the classpath.");

{
  const s = S();
  addDiagramSlide(s, "OBSERVABILITY", "One trace, across a loopback hop",
    "21-otel-trace-seam",
    "A W3C traceparent is injected on the way out and extracted on the way in, automatically, with zero code in either servicer.",
    { x: 1.30, y: 1.72, w: 10.73, h: 4.55 });
  addNotes(s, "The seam this figure names is the one place a trace could silently break: the hop from one gRPC service to another inside the same process. quarkus-opentelemetry's gRPC client instrumentation injects a W3C traceparent header onto the outbound call's metadata automatically, whenever the calling code is itself already inside a span; the server-side instrumentation extracts that same header automatically before the handler runs, so Span.current() in the downstream method is already a child of whatever span started the request: no manual propagation code anywhere. The next slide shows both halves of that seam in one method: a REST caller's trace continuing through a gRPC hop with nothing but a log line to prove it.");
}

{
  const s = S();
  addCodeSlide(s, "OBSERVABILITY", "Trace continuity + the free surfaces", "java · Quarkus",
    [
      "// examples/21-observability/quarkus/.../RoutingServiceImpl.java",
      "@GrpcClient(\"quote\")",
      "MutinyQuoteServiceGrpc.MutinyQuoteServiceStub quoteClient;",
      "",
      "@Override",
      "public Uni<GetQuoteResponse> getQuote(GetQuoteRequest request) {",
      "    String traceId = Span.current().getSpanContext().getTraceId();",
      "    LOG.infof(\"RoutingServiceImpl.GetQuote traceId=%s %s -> %s, calling QuoteService\",",
      "            traceId, origin.getUnLocode(), destination.getUnLocode());",
      "    return quoteClient.getQuote(downstreamRequest)",
      "            .onItem().transform(resp -> buildResponse(origin, destination, resp.getQuote()));",
      "}",
      "",
      "// application.properties — no code needed for any of these three:",
      "//   quarkus-opentelemetry        -> traces, auto-instrumented gRPC client + server",
      "//   quarkus-micrometer-registry-prometheus -> gRPC server metrics at /q/metrics",
      "//   grpc.health.v1.Health        -> registered automatically for every @GrpcService",
    ],
    "The same traceId logged here and in QuoteServiceImpl is verify.sh's trace-continuity assertion.",
    { fontSize: 12 });
  addNotes(s, "Span.current() here is already a child span by the time this method runs, whether the caller was grpcurl hitting this RPC directly or BookingResource's REST handler calling it over its own loopback @GrpcClient, either path's W3C traceparent arrived on the inbound call's metadata and was extracted automatically. Logging the trace id here is half of what this chapter's trace-continuity check verifies; QuoteServiceImpl logs the matching other half, and a passing test means one real trace id threads through a REST call, a gRPC hop, and a second gRPC hop, not three disconnected spans that happen to look related. The three free surfaces in the comment block are the chapter's other half: quarkus-micrometer-registry-prometheus publishes gRPC server metrics at /q/metrics the moment it's on the classpath, and quarkus-grpc registers the built-in grpc.health.v1.Health service automatically for every @GrpcService bean present: no separate dependency, no enable flag, and no code in this file for either one.");
}

/* ======================= DIVIDER 11 — MESH & LOAD BALANCING ======================= */
divider("11", "Load balancing on a real cluster",
  "A reused HTTP/2 channel meets three replicas: the pinned-pod baseline, the headless + round-robin fix, and the mesh fix.",
  "This is the one example in the book that runs on a live minikube cluster rather than Docker Compose, because the failure mode it demonstrates only exists once a service has more than one replica.");

{
  const s = S();
  addDiagramSlide(s, "LOAD BALANCING", "The pinned-pod baseline",
    "22-grpc-lb-problem",
    "A plain ClusterIP Service resolves to one virtual IP; kube-proxy picks a backend pod once per connection, not once per RPC: all 30 calls over one reused channel land on the same pod.",
    { x: 1.30, y: 1.72, w: 10.73, h: 4.55 });
  addNotes(s, "Three replicas of the same GetQuote server, fronted by an entirely ordinary ClusterIP Service: nothing misconfigured, nothing a toy example of bad YAML. The real recorded run against it: 30 GetQuote calls over one reused channel, all 30 answered by the exact same pod, while kubectl get pods confirmed the other two replicas were Running and ready the whole time. pick_first, grpc-core's default load-balancing policy, does exactly what its name says: a ClusterIP Service resolves to exactly one address, so there's only ever one thing to pick first. This is the identical discipline Chapter 7 taught, build one channel, reuse it for the life of the process, colliding with a Kubernetes primitive that makes its routing decision once per TCP connection, not once per request. Every chapter before this one ran against one server process, so this choice was never visible; the moment a service has more than one replica, it becomes one.");
}

{
  const s = S();
  addDiagramSlide(s, "LOAD BALANCING", "Two fixes: client-side and mesh",
    "22-l4-vs-l7-balancing",
    "The headless + round-robin fix: a clean 10/10/10 split across all three pods. The mesh fix: the identical plain Service, unchanged client, same 10/10/10 split.",
    { x: 1.30, y: 1.72, w: 10.73, h: 4.55 });
  addNotes(s, "The headless + round-robin fix changes nothing about the client's code path and everything about what DNS tells it: a headless Service (clusterIP: None) resolves to one DNS A record per ready pod instead of one virtual IP standing in for all of them, and a channel built with a dns:/// target and round_robin as its LB policy opens a persistent subchannel to each address and cycles through all three. The real recorded tally over the identical 30-call client: a clean 10/10/10 split across the same three pods the pinned baseline collapsed onto one of. The mesh fix is different in kind, not degree: Istio's sidecar redirects outbound traffic through a local Envoy proxy before kube-proxy's Service-VIP rewrite ever runs, and that proxy, which already knows every pod behind the Service from Istio's control plane, picks a backend per individual HTTP/2 stream, not once per connection. Running the unchanged client against the same plain ClusterIP Service the baseline pinned to one pod, with STRICT mTLS and retry/timeout policy from a DestinationRule and VirtualService layered on top, produces the identical 10/10/10 split: with zero client code change at all.");
}

/* ======================= DIVIDER 12 — GRPC-WEB & TRANSCODING ======================= */
divider("12", "grpc-web & JSON/HTTP transcoding",
  "Envoy, in front of the unmodified Quarkus service, unwraps grpc-web framing and transcodes plain JSON into native gRPC.",
  "The Quarkus service never knows a browser or a plain JSON client exists: Envoy's filter chain is the entire seam.");

{
  const s = S();
  addDiagramSlide(s, "TRANSCODING", "One filter chain, two client shapes",
    "23-grpc-web-transcoding-seam",
    "grpc_web unwraps a grpc-web-framed call; grpc_json_transcoder decodes plain JSON against the baked-in proto descriptor, both forward to the same gRPC cluster.",
    { x: 1.30, y: 1.72, w: 10.73, h: 4.55 });
  addNotes(s, "Nothing about RoutingServiceImpl changes for this chapter: the Quarkus server still speaks native gRPC/HTTP2 on its own port, exactly as every prior chapter left it. Envoy sits in front of it and runs one HTTP connection manager with two gRPC-aware filters, in order: grpc_web first, which unwraps a grpc-web-framed POST, application/grpc-web+proto, into a native gRPC call; a plain JSON request's content-type doesn't match that filter's trigger, so it passes through untouched. grpc_json_transcoder runs next, and acts only on anything not already application/grpc, a plain JSON POST, decoding its body against a baked-in compiled proto descriptor and re-encoding it as a native gRPC call; a request the grpc_web filter already converted passes through this second filter untouched too, because it's no longer JSON. The router filter forwards the now-uniformly-native-gRPC call to the Quarkus cluster over HTTP/2.");
}

{
  const s = S();
  addCodeSlide(s, "TRANSCODING", "envoy-quarkus.yaml: both filters, one listener", "yaml · Envoy",
    [
      "# examples/23-grpc-web-transcoding/envoy/envoy-quarkus.yaml",
      "http_filters:",
      "  - name: envoy.filters.http.grpc_web",
      "    typed_config:",
      "      \"@type\": type.googleapis.com/envoy.extensions.filters.http.grpc_web.v3.GrpcWeb",
      "  - name: envoy.filters.http.grpc_json_transcoder",
      "    typed_config:",
      "      \"@type\": .../grpc_json_transcoder.v3.GrpcJsonTranscoder",
      "      proto_descriptor: /etc/envoy/descriptor.binpb",
      "      services: [\"shipping.routing.v1.RoutingService\"]",
      "      auto_mapping: true",
      "      convert_grpc_status: true",
      "  - name: envoy.filters.http.router",
      "",
      "clusters:",
      "  - name: app",
      "    typed_extension_protocol_options:",
      "      envoy.extensions.upstreams.http.v3.HttpProtocolOptions:",
      "        explicit_http_config: { http2_protocol_options: {} }",
      "    load_assignment:",
      "      endpoints: [{ endpoint: { address: { socket_address: { address: quarkus, port_value: 9000 } } } }]",
    ],
    "convert_grpc_status maps a gRPC status back onto an HTTP status code for the plain-JSON caller.",
    { fontSize: 11 });
  addNotes(s, "Filter order is the whole mechanism here, and it's not arbitrary: a request passes through grpc_web, then grpc_json_transcoder, then router, and each filter only acts on content it recognizes, so a given request is transformed by at most one of the first two. explicit_http_config with http2_protocol_options on the app cluster is what tells Envoy to speak HTTP/2 to the upstream Quarkus service, required because gRPC is an HTTP/2-only protocol regardless of what the downstream client spoke. auto_mapping lets the transcoder derive a JSON-to-RPC mapping from the proto descriptor directly, without a separate google.api.http annotation on every method, and convert_grpc_status is what turns a gRPC status code like NOT_FOUND back into the HTTP status code a plain JSON/REST client actually expects. The descriptor itself, descriptor.binpb, is a compiled binary form of the same shared .proto every chapter in this book already generates from; nothing about the contract changes to support this.");
}

/* ======================= DIVIDER 13 — TESTING & DEBUGGING ======================= */
divider("13", "Testing & debugging",
  "@QuarkusTest with an auto-wired @GrpcClient as the hard CI gate, and a configurable delay for reproducing DEADLINE_EXCEEDED on demand.",
  "A real in-process test server that gates every build, and one knob that turns a transient timeout into something you can reproduce reliably.");

{
  const s = S();
  addDiagramSlide(s, "TESTING", "The gRPC test pyramid",
    "25-grpc-test-pyramid",
    "@QuarkusTest boots the full gRPC server in-process; @GrpcClient self-wires to it with zero host/port configuration.",
    { x: 1.30, y: 1.72, w: 10.73, h: 4.55 });
  addNotes(s, "This figure places @QuarkusTest's level in the larger test pyramid for a gRPC service, unit tests below it for pure logic like QuoteCalculator, contract tests against the shared .proto above it, and this in-process integration level answering the real question: does the actual generated stub, the actual @GrpcService bean, and the actual wire format all agree. The next slide shows exactly how little code that takes in Quarkus specifically.");
}

{
  const s = S();
  addCodeSlide(s, "TESTING", "@QuarkusTest + @GrpcClient: zero config", "java · Quarkus",
    [
      "// examples/25-testing-and-cli/quarkus/.../RoutingServiceTest.java",
      "@QuarkusTest",
      "class RoutingServiceTest {",
      "",
      "    @GrpcClient",
      "    RoutingService client;   // self-wires to the test server's own address",
      "",
      "    @Test",
      "    void getQuoteComputesTheExpectedAmountAndRoute() {",
      "        GetQuoteRequest request = GetQuoteRequest.newBuilder()",
      "                .setOrigin(Location.newBuilder().setUnLocode(\"USNYC\").build())",
      "                .setDestination(Location.newBuilder().setUnLocode(\"NLRTM\").build())",
      "                .addCargo(Cargo.newBuilder().setWeightKg(1200.5).build())",
      "                .build();",
      "",
      "        GetQuoteResponse response = client.getQuote(request).await().atMost(Duration.ofSeconds(5));",
      "",
      "        assertEquals(\"3001.25\", response.getQuote().getAmount(), \"quote.amount\");",
      "        assertEquals(\"rte_USNYC-NLRTM\", response.getRoute().getId(), \"route.id\");",
      "    }",
      "}",
    ],
    "'In the case of using a client to test an exposed service that does not use TLS, there is no need to provide any configuration': the Quarkus gRPC guide, confirmed against 3.40.1.",
    { fontSize: 11 });
  addNotes(s, "@QuarkusTest boots the full application for the test JVM, including the real gRPC server this module wires up in application.properties, on its own port, exactly as it runs in production. @GrpcClient then injects a client typed to the same generated Mutiny RoutingService interface RoutingServiceImpl implements: no manual channel, no manual stub, no host or port configuration, because a client with no client-specific config in a @QuarkusTest self-wires to the test server's own address automatically. client.getQuote(request).await().atMost(...) blocks this test thread for exactly one reply, with a tight explicit timeout so a hung server fails the test instead of hanging the build forever. This is the hard gate every chapter in the book relies on: the Containerfile's build stage runs mvn verify, not -DskipTests, so if this one assertion goes red, the Maven build fails, the container image build fails, and verify.sh fails before a single grpcurl call ever runs against a broken image.");
}

{
  const s = S();
  addCodeSlide(s, "DEBUGGING", "A configurable delay to reproduce DEADLINE_EXCEEDED", "java · Quarkus",
    [
      "// examples/26-debugging/quarkus/.../RoutingServiceImpl.java",
      "@ConfigProperty(name = \"ch26.quote-delay-ms\", defaultValue = \"2000\")",
      "long quoteDelayMs;",
      "",
      "@Override",
      "public Uni<GetQuoteResponse> getQuote(GetQuoteRequest request) {",
      "    GetQuoteResponse response = /* same formula every unary chapter uses */;",
      "    // A client deadline shorter than quoteDelayMs cannot be met; one longer",
      "    // than it succeeds normally — same request, same server, either way.",
      "    return Uni.createFrom().item(response)",
      "            .onItem().delayIt().by(Duration.ofMillis(quoteDelayMs));",
      "}",
      "",
      "// FindOptimalRoute/ListRoutes/NegotiateRoute/RecomputeRoutes stay",
      "// UNIMPLEMENTED here — this chapter's UNIMPLEMENTED repro",
      "// calls FindOptimalRoute for exactly that reason.",
    ],
    "delayIt().by() schedules the emission on Mutiny's worker pool rather than Thread.sleep: other requests keep flowing while this one waits.",
    { fontSize: 13 });
  addNotes(s, "QUOTE_DELAY_MS stands in for a slow downstream dependency without actually adding one: the deadlines chapter earlier in this deck wired a real downstream hop for the same lesson; this chapter only needs a deadline to have something to race against, so an artificial, configurable delay is simpler. A client deadline set shorter than quoteDelayMs cannot be met and reproduces DEADLINE_EXCEEDED reliably, on demand, against the exact same request and server that succeeds fine with a longer deadline, the kind of reliable repro that's hard to get from a flaky downstream dependency. onItem().delayIt().by(...) is the detail to note: it schedules the delayed emission on Mutiny's default worker pool, not a blocking Thread.sleep, so this one slow call doesn't tie up the event loop thread and stall every other request the server is handling concurrently. The UNIMPLEMENTED repro this chapter also teaches calls FindOptimalRoute, which is why that method, and three others, are left exactly as declared in the proto and never given a real implementation in this chapter's example.");
}

/* ======================= DIVIDER 14 — THE FINAL PROJECT ======================= */
divider("14", "The Final Project",
  "Every pattern in this deck, in one process: mTLS, JWT scopes, OTel tracing, three gRPC services, and a REST front door.",
  "RoutingService, QuoteService, TrackingService, and the built-in Health service all run behind one mTLS-required, JWT-gated port, with internal loopback calls presenting the same client certificate and a service-minted bearer token.");

{
  const s = S();
  addDiagramSlide(s, "THE FINAL PROJECT", "Every service, one process, one port",
    "27-final-project-architecture",
    "Booking -> Routing -> Quote, each loopback hop carrying a client certificate, a bearer token, and a propagated trace context.",
    { x: 1.20, y: 1.70, w: 10.93, h: 4.60 });
  addNotes(s, "This is the composition point for the entire deck: BookingResource's REST front door calls into RoutingServiceImpl over a loopback gRPC hop, which calls QuoteServiceImpl over a second loopback hop, and TrackingServiceImpl and the built-in grpc.health.v1.Health service share the same one mTLS-required, JWT-gated port. Every pattern shown earlier in this deck is present here at once: the mTLS configuration from the security section, the AuthzInterceptor's scope checks, OTel's trace propagation across every hop, and the generated Mutiny stubs from the very first section. Zero contract change: every RPC implemented here was already declared in the shared .proto; this is simply the first place several of them, the streaming and bidirectional ones especially, run instead of answering UNIMPLEMENTED.");
}

{
  const s = S();
  addCodeSlide(s, "THE FINAL PROJECT", "SecureGrpcClients: the internal loopback hop", "java · Quarkus",
    [
      "// examples/27-complete-project/quarkus/.../security/SecureGrpcClients.java",
      "public static ManagedChannel loopbackChannel() {",
      "    SslContext sslContext = GrpcSslContexts.forClient()",
      "            .trustManager(new File(CA_CRT))",
      "            .keyManager(new File(CLIENT_CRT), new File(CLIENT_KEY))   // presents a CLIENT cert too",
      "            .build();",
      "    return NettyChannelBuilder.forAddress(\"localhost\", 9000)",
      "            .sslContext(sslContext)",
      "            .overrideAuthority(\"localhost\")   // matches the SAN certgen writes into server.crt",
      "            .build();",
      "}",
      "",
      "public void start(Listener<RespT> responseListener, Metadata headers) {",
      "    headers.put(AUTHORIZATION, \"Bearer \" + InternalTokenIssuer.token());",
      "    // Hand-built channel, NOT a Quarkus-managed @GrpcClient, so OTel never",
      "    // sees it automatically — inject the trace context into metadata by hand.",
      "    GlobalOpenTelemetry.getPropagators().getTextMapPropagator()",
      "            .inject(Context.current(), headers, (carrier, k, v) -> carrier.put(...));",
      "    super.start(responseListener, headers);",
      "}",
    ],
    "Built with plain grpc-java (NettyChannelBuilder/GrpcSslContexts), not @GrpcClient: this internal hop has zero ambiguity about identity to resolve.",
    { fontSize: 11 });
  addNotes(s, "This class is the one place in the whole book that builds a channel with plain grpc-java instead of a Quarkus-managed @GrpcClient, and the Javadoc explains exactly why: proving which quarkus.grpc.clients.<name>.ssl.* key shape the gRPC Java client transport reads for a client certificate, the reference guide documents the trust-store key but not a client-identity key, is unnecessary friction for an internal loopback hop that already has zero ambiguity about identity. grpc-java's own, upstream-documented SslContextBuilder.keyManager(cert, key) has no such ambiguity, so that's what this uses directly. Two things ride on every call this channel makes: the BearerTokenInterceptor attaches the internal service token InternalTokenIssuer mints, the same authorization: Bearer convention AuthzInterceptor checks on the way in; and because this hand-built channel bypasses Quarkus's own OTel auto-instrumentation entirely, the trace context has to be injected into the outgoing metadata by hand, using OpenTelemetry's own TextMapPropagator: the one piece of plumbing a @GrpcClient would have done automatically.");
}

/* ======================= CLOSING ======================= */
{
  const s = S();
  addContentTitle(s, "CLOSING", "What you've seen, and where to go next");
  addTwoColBullets(s,
    [
      "A generated Mutiny interface and a @GrpcService bean: codegen, not hand-written stubs.",
      "Deadlines carved from Context, rich google.rpc.Status errors, and one @GlobalInterceptor bean.",
      "FieldMask projection, the buf breaking gate, and three concurrency models on one method.",
      "Demand-driven streaming, performance knobs, mTLS, and JWT scopes.",
    ],
    [
      "OTel trace propagation and the built-in health service, with no extra code.",
      "The load-balancing failure mode on a real cluster, and both of its fixes.",
      "Envoy transcoding, @QuarkusTest, a reproducible DEADLINE_EXCEEDED, and the Final Project.",
      "Full listings, pom.xml, application.properties, and every class excerpted here, in the appendix.",
    ],
    { fontSize: 15 });
  addNotes(s, "That's the full arc: every pattern from the concepts deck, realized in real Quarkus code pulled from examples/*/quarkus, against the one shared Protobuf contract this whole series holds constant. The sibling Python deck walks the identical arc with grpcio, and the two are validated against each other in CI through the shared contract, never by inspection alone. The appendix that follows carries the full listings this deck only had room to excerpt, complete pom.xml and application.properties files, the full OperationState and JwtVerifier classes, and the deterministic NegotiationPolicy from the Final Project, plus a short note on running these same services, unmodified, on OpenShift Local. Questions are welcome on any pattern, any chapter, or the contract itself.");
}

/* ======================= APPENDIX DIVIDER ======================= */
divider("A", "Appendix",
  "Full listings for every excerpt in this deck: keep this section open in another window.",
  "Everything here is real code from examples/*/quarkus, shown in full where the body deck only had room for an excerpt: complete build files, the synchronized OperationState, the full JwtVerifier, the deterministic NegotiationPolicy, and a short note on OpenShift Local.");

{
  const s = S();
  addCodeSlide(s, "APPENDIX · BUILD FILES", "The Final Project's full pom.xml", "xml · Maven",
    [
      "<!-- examples/27-complete-project/quarkus/pom.xml -->",
      "<packaging>quarkus</packaging>",
      "<properties><quarkus.platform.version>3.40.1</quarkus.platform.version></properties>",
      "<dependencies>",
      "  <dependency><groupId>io.quarkus</groupId><artifactId>quarkus-grpc</artifactId></dependency>",
      "  <!-- This module builds its OWN mTLS channel for internal loopback hops",
      "       (SecureGrpcClients) instead of a Quarkus-managed @GrpcClient. -->",
      "  <dependency><groupId>io.grpc</groupId><artifactId>grpc-netty-shaded</artifactId></dependency>",
      "  <!-- The REST front door: POST /booking/quote. -->",
      "  <dependency><groupId>io.quarkus</groupId><artifactId>quarkus-rest-jackson</artifactId></dependency>",
      "  <!-- CDI-managed ObjectMapper for JwtVerifier's claims decoding. -->",
      "  <dependency><groupId>io.quarkus</groupId><artifactId>quarkus-jackson</artifactId></dependency>",
      "  <!-- Zero-code REST+gRPC tracing across the Booking->Routing->Quote seam. -->",
      "  <dependency><groupId>io.quarkus</groupId><artifactId>quarkus-opentelemetry</artifactId></dependency>",
      "  <!-- gRPC server metrics, automatic once on the classpath alongside quarkus-grpc. -->",
      "  <dependency><groupId>io.quarkus</groupId><artifactId>quarkus-micrometer-registry-prometheus</artifactId></dependency>",
      "</dependencies>",
    ],
    "Six dependencies cover mTLS-authenticated internal gRPC, a REST front door, JWT claims decoding, tracing, and metrics.",
    { fontSize: 11 });
  addNotes(s, "This is the complete dependency list the Final Project needs to combine everything shown in the body deck into one process: quarkus-grpc for the generated Mutiny stubs and the gRPC server itself, grpc-netty-shaded for the hand-built mTLS loopback channel SecureGrpcClients constructs, quarkus-rest-jackson for the one REST endpoint fronting the whole system, quarkus-jackson for JwtVerifier's claims decoding, quarkus-opentelemetry for the zero-code tracing that threads one trace id across the REST call and both internal gRPC hops, and quarkus-micrometer-registry-prometheus for the metrics surface. Every one of these was introduced individually in an earlier chapter's own pom.xml; this is simply all of them in one module, pinned to the same 3.40.1 Quarkus BOM every chapter in the book holds.");
}

{
  const s = S();
  addCodeSlide(s, "APPENDIX · BUILD FILES", "The Final Project's full application.properties", "properties · Quarkus",
    [
      "# examples/27-complete-project/quarkus/src/main/resources/application.properties",
      "quarkus.grpc.server.port=9000",
      "quarkus.grpc.server.host=0.0.0.0",
      "quarkus.grpc.server.enable-reflection-service=true",
      "",
      "# mTLS (Ch19 shape, unchanged)",
      "quarkus.grpc.server.plain-text=false",
      "quarkus.grpc.server.ssl.certificate=/certs/server.crt",
      "quarkus.grpc.server.ssl.key=/certs/server.key",
      "quarkus.grpc.server.ssl.trust-store=/certs/ca-truststore.jks",
      "quarkus.grpc.server.ssl.trust-store-password=changeit",
      "quarkus.grpc.server.ssl.client-auth=REQUIRED",
      "",
      "# REST front door — POST /booking/quote; also serves /q/metrics",
      "quarkus.http.host=0.0.0.0",
      "quarkus.http.port=8080",
      "",
      "# OTel — always-on for this chapter",
      "quarkus.otel.exporter.otlp.endpoint=${OTEL_EXPORTER_OTLP_ENDPOINT:http://localhost:4317}",
      "quarkus.otel.service.name=ch27-final-project-quarkus",
    ],
    "Every external grpcurl/ghz call, and every internal loopback call this process makes to itself, must present the client certificate.",
    { fontSize: 11 });
  addNotes(s, "This is every property from every earlier chapter's own file, converged onto one process: the gRPC server's own port and reflection flag from the very first section, the mTLS block unchanged from the security section, client-auth is REQUIRED unconditionally here, not read from an environment variable, because this is the Final Project's steady state and there's no verify.sh phase that needs to flip it, the REST front door's HTTP port from the observability section, and the same OTel endpoint convention every chapter uses, always-on rather than opt-in for this one chapter. Nothing in this file is new; the point of showing it in full is that combining eight chapters' worth of individual concerns into one process required no new configuration surface, only the union of what each concern already needed on its own.");
}

{
  const s = S();
  addCodeSlide(s, "APPENDIX · ASYNC OPERATIONS", "OperationState: the full synchronized record", "java · Quarkus",
    [
      "// examples/16-async-long-running-jobs/quarkus/.../OperationState.java",
      "final class OperationState {",
      "    private volatile boolean done;",
      "    private volatile int progressPct;",
      "    private volatile String message;",
      "",
      "    synchronized Types.Operation snapshot() {",
      "        return Types.Operation.newBuilder().setId(id).setKind(kind)",
      "                .setDone(done).setProgressPct(progressPct).setMessage(message).build();",
      "    }",
      "    synchronized void advance(int pct, String msg) {",
      "        if (done) return;   // cancelled underneath the job; ignore the late update",
      "        this.progressPct = pct; this.message = msg;",
      "    }",
      "    synchronized void complete(String msg) {",
      "        if (done) return;",
      "        this.done = true; this.progressPct = 100; this.message = msg;",
      "    }",
      "    synchronized boolean cancel() {",
      "        if (done) return false;   // cancel arrived too late, or twice",
      "        this.done = true; this.message = \"operation cancelled by client request at \" + progressPct + \"% progress\";",
      "        return true;",
      "    }",
      "}",
    ],
    "Every mutation goes through a synchronized method so the background job and a concurrent cancel can never both claim the terminal transition.",
    { fontSize: 11 });
  addNotes(s, "This is the full listing the async-operations body slide referenced. Every mutating method is synchronized on the same monitor, and every one of them checks the done flag first and no-ops if it's already set; that's what makes a race between the background job calling advance or complete and a client calling cancel through OperationsServiceImpl safe: whichever call acquires the monitor first and sets done wins, and the other one's effect is silently discarded rather than corrupting state or double-completing. cancel returning a boolean is the one place this matters externally too: OperationsServiceImpl logs whether this call was the one that actually moved the operation to terminal, which is the only way to answer 'did my cancel actually do anything' when a job might have finished naturally in the same instant.");
}

{
  const s = S();
  addCodeSlide(s, "APPENDIX · AUTHN", "JwtVerifier: dependency-light HMAC, in full", "java · Quarkus",
    [
      "// examples/20-authn-authz/quarkus/.../JwtVerifier.java",
      "public Map<String, Object> verify(String token) {",
      "    String[] parts = token.split(\"\\\\.\", -1);",
      "    if (parts.length != 3) throw new TokenError(\"malformed token\");",
      "",
      "    byte[] expectedSignature = hmacSha256(parts[0] + \".\" + parts[1], SECRET);",
      "    byte[] actualSignature = Base64.getUrlDecoder().decode(pad(parts[2]));",
      "    // Constant-time comparison: a short-circuiting check leaks how many",
      "    // leading bytes matched via timing — the textbook MAC side channel.",
      "    if (!MessageDigest.isEqual(expectedSignature, actualSignature)) {",
      "        throw new TokenError(\"signature verification failed\");",
      "    }",
      "",
      "    Map<String, Object> claims = objectMapper.readValue(",
      "            Base64.getUrlDecoder().decode(pad(parts[1])), Map.class);",
      "    long nowEpochSeconds = System.currentTimeMillis() / 1000;",
      "    if (((Number) claims.get(\"exp\")).longValue() < nowEpochSeconds) {",
      "        throw new TokenError(\"token expired\");",
      "    }",
      "    return claims;",
      "}",
    ],
    "HmacSHA256 via the JDK's own javax.crypto.Mac: no OIDC client, no JWKS fetch, for a token this example mints itself.",
    { fontSize: 11 });
  addNotes(s, "The body deck's AuthzInterceptor slide called jwtVerifier.verify and moved on; this is what that call actually does. Three dot-separated segments are required, or the token is rejected outright as malformed. The signing input is the first two segments joined by a dot, and the expected signature is an HMAC-SHA256 over that input using the JDK's own javax.crypto.Mac with a fixed, shared secret: no OIDC client, no JWKS endpoint, no network round trip, because this chapter's token has no real identity provider behind it and a production service authenticating real tokens would use quarkus-oidc or SmallRye JWT instead, never hand-rolled verification like this. MessageDigest.isEqual is deliberate, not incidental: a naive byte-array equals() that returns false the moment it finds a mismatch leaks, through timing, how many leading bytes of the signature were actually correct, a real and exploitable side channel against MAC verification, and isEqual is specifically designed to take constant time regardless of where the first difference falls.");
}

{
  const s = S();
  addCodeSlide(s, "APPENDIX · FINAL PROJECT", "NegotiationPolicy: deterministic by design", "java · Quarkus",
    [
      "// examples/27-complete-project/quarkus/.../NegotiationPolicy.java",
      "public static final String ACCEPT_THRESHOLD = \"5000.00\";",
      "private static final BigDecimal COUNTER_FACTOR = new BigDecimal(\"0.90\");",
      "",
      "public static NegotiateRouteResponse negotiate(NegotiateRouteRequest request) {",
      "    Types.Route proposal = request.getProposal();",
      "    BigDecimal price = new BigDecimal(proposal.getPrice().getAmount());",
      "",
      "    if (price.compareTo(new BigDecimal(ACCEPT_THRESHOLD)) <= 0) {",
      "        return NegotiateRouteResponse.newBuilder().setAccepted(true).setCounter(proposal).build();",
      "    }",
      "    String counterAmount = price.multiply(COUNTER_FACTOR)",
      "            .setScale(2, RoundingMode.HALF_UP).toPlainString();",
      "    Types.Route counterRoute = proposal.toBuilder()",
      "            .setPrice(proposal.getPrice().toBuilder().setAmount(counterAmount).build())",
      "            .build();",
      "    return NegotiateRouteResponse.newBuilder().setAccepted(false).setCounter(counterRoute).build();",
      "}",
    ],
    "No randomness, no clock dependence: verify.sh asserts an exact counter amount for a fixed input, identical on both stacks.",
    { fontSize: 12 });
  addNotes(s, "This is the real negotiation policy behind NegotiateRoute, the bidirectional-streaming RPC that stayed UNIMPLEMENTED through every earlier chapter and only gets a real body in the Final Project. The policy itself is simple and, more importantly, deterministic: a proposal priced at or under $5000.00 is accepted as-is, and anything over it is countered at exactly 90% of the proposed price, computed with BigDecimal and HALF_UP rounding to two decimal places, never a double, for the same decimal-precision reason Money.amount is a string everywhere else in this contract. No randomness and no clock dependence means verify.sh can assert an exact counter amount for a fixed input and get the identical answer from both the Quarkus and the Python implementation of this same policy: the same discipline every other anchor's formula in this book follows, extended to the one RPC shape, bidirectional streaming, that none of the single-request anchors could exercise.");
}

{
  const s = S();
  addCodeSlide(s, "APPENDIX · OPENSHIFT LOCAL", "The same contract, on CRC: x-served-by trailer", "java · Quarkus",
    [
      "// examples/99-appendix-a-openshift-crc/quarkus/.../ServedByInterceptor.java",
      "@Singleton",
      "@GlobalInterceptor",
      "public class ServedByInterceptor implements ServerInterceptor {",
      "    private static final Metadata.Key<String> SERVED_BY =",
      "            Metadata.Key.of(\"x-served-by\", Metadata.ASCII_STRING_MARSHALLER);",
      "",
      "    public <ReqT, RespT> ServerCall.Listener<ReqT> interceptCall(",
      "            ServerCall<ReqT, RespT> call, Metadata headers, ServerCallHandler<ReqT, RespT> next) {",
      "        ServerCall<ReqT, RespT> wrapped = new ForwardingServerCall.SimpleForwardingServerCall<>(call) {",
      "            @Override public void close(Status status, Metadata trailers) {",
      "                trailers.put(SERVED_BY, PodIdentity.NAME);   // HOSTNAME env var, no Downward API plumbing",
      "                super.close(status, trailers);",
      "            }",
      "        };",
      "        return next.startCall(wrapped, headers);",
      "    }",
      "}",
    ],
    "No quarkus.grpc.server.ssl.* here: on CRC, OpenShift Service Mesh's STRICT PeerAuthentication terminates mTLS in the sidecar instead.",
    { fontSize: 11 });
  addNotes(s, "Appendix A of the book ports this same GetQuote contract onto OpenShift Local, unchanged: same shipping.quote.v1.QuoteService.GetQuote RPC, same frozen proto, deployed with an in-cluster S2I build instead of a pulled container image. ServedByInterceptor is the one piece of code worth showing in full here, because it's the same convention the mesh-and-load-balancing chapter uses, ported to Java: a response trailer, not a proto field, so it adds zero bytes to the contract and exists purely so grpcurl -v or a load client can tell which pod actually answered a given call: the whole point of a canary demo on a real cluster. The absence in this module's pom.xml and application.properties is just as important as what's present: no quarkus.grpc.server.ssl.* anywhere, because on OpenShift Local this service runs inside OpenShift Service Mesh 3's mesh, and STRICT PeerAuthentication terminates mTLS in the Envoy sidecar instead of in the JVM: the same infrastructure-versus-application-layer choice the mesh chapter's STRICT mTLS section makes on minikube with plain Istio.");
}


/* --- Scan to explore (QR codes) --- */
{
  const s = S();
  addContentTitle(s, "SCAN TO EXPLORE", "Take it with you");

  s.addImage({ path: `${ASSETS}/qr-grpc-site.png`, x: 2.30, y: 1.78, w: 3.10, h: 3.10 });
  s.addText("The site", { x: 1.55, y: 4.98, w: 4.60, h: 0.40,
    fontFace: FONT.title, fontSize: 18, bold: true, color: COLOR.ink, align: "center", valign: "middle" });
  s.addText("Chapters, the Protobuf contracts, and both-stack runnable examples", { x: 1.45, y: 5.40, w: 4.80, h: 0.72,
    fontFace: FONT.body, fontSize: 13, italic: true, color: COLOR.caption, align: "center", valign: "top" });
  s.addText("patterncatalyst.github.io/api-patterns-and-practices-grpc", { x: 1.45, y: 6.12, w: 4.80, h: 0.32,
    fontFace: FONT.mono, fontSize: 10, color: COLOR.red, align: "center", valign: "middle" });

  s.addImage({ path: `${ASSETS}/qr-hub.png`, x: 7.93, y: 1.78, w: 3.10, h: 3.10 });
  s.addText("Workshops & Tutorials", { x: 7.18, y: 4.98, w: 4.60, h: 0.40,
    fontFace: FONT.title, fontSize: 18, bold: true, color: COLOR.ink, align: "center", valign: "middle" });
  s.addText("The whole series: every workshop, tutorial, and deck in one place", { x: 7.08, y: 5.40, w: 4.80, h: 0.72,
    fontFace: FONT.body, fontSize: 13, italic: true, color: COLOR.caption, align: "center", valign: "top" });
  s.addText("patterncatalyst.github.io/patterncatalyst-workshops-tutorials-list", { x: 7.08, y: 6.12, w: 4.80, h: 0.32,
    fontFace: FONT.mono, fontSize: 9, color: COLOR.red, align: "center", valign: "middle" });

  addNotes(s, "This is the Quarkus implementation deck, so the left code takes you to the runnable Quarkus example and contract, the right to the whole series. On the left, the site: the chapters, the Protobuf contracts, and the runnable both-stack examples, all public. On the right, the Workshops and Tutorials hub: every workshop, tutorial, and deck in the series in one place, including the REST, GraphQL, and WebSockets siblings. Scan whichever is useful; both are on the Pattern Catalyst GitHub organization.");
}


pres.writeFile({ fileName: OUT })
  .then((p) => console.log("WROTE", p, "slides:", pageNum))
  .catch((e) => { console.error(e); process.exit(1); });
