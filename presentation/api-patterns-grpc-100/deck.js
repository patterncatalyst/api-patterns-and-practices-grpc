// deck.js — "API Patterns & Practices: Protobuf & gRPC — 100 (Concepts)".
// Stack-agnostic: the WHAT and WHY of Protobuf and gRPC, shipping/cargo domain.
// Snippets are WIRE-LEVEL ONLY — .proto, buf CLI, grpcurl, protobuf wire bytes,
// proto3<->JSON, google.rpc.Status — never Java or Python. The Quarkus and
// Python companion decks (../api-patterns-grpc-quarkus, ../api-patterns-grpc-python)
// carry the implementations.
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
  addStatusTable, addCaption, addPerfCallout, addCodeSlide, addDiagramSlide,
  addSectionDivider, addNotes,
} = H;

const OUT = path.resolve(__dirname, "api-patterns-grpc-100-r1.1.pptx");
const REV = "r1.1";

const pres = newDeck();
pres.title = "API Patterns & Practices: Protobuf & gRPC: 100 (Concepts)";
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
  s.addText("API PATTERNS & PRACTICES · GRPC · 100", { x: 6.00, y: 1.82, w: 6.90, h: 0.34,
    fontFace: FONT.title, fontSize: 14, bold: true, color: COLOR.red, charSpacing: 6, align: "left", valign: "middle" });
  s.addText([{ text: "Protobuf & gRPC:", options: { breakLine: true } }, { text: "the what, the why." }], {
    x: 5.95, y: 2.28, w: 6.95, h: 1.70, fontFace: FONT.title, fontSize: 46, bold: true, color: COLOR.ink, align: "left", valign: "top" });
  s.addText("The design patterns behind a production gRPC system: the contract language, the four RPC shapes, reliability, evolution, security, and scale, in the shipping & cargo domain. Stack-agnostic: snippets are wire-level only. The Quarkus and Python decks show the implementations.", {
    x: 6.00, y: 4.15, w: 6.80, h: 1.45, fontFace: FONT.body, fontSize: 15, italic: true, color: COLOR.caption, align: "left", valign: "top" });
  s.addText([
    { text: "Robert Sedor", options: { bold: true, color: COLOR.ink, breakLine: true } },
    { text: "Principal Chief Architect, Application Development", options: { color: COLOR.caption } },
  ], { x: 6.00, y: 5.75, w: 6.70, h: 0.80, fontFace: FONT.body, fontSize: 15, align: "left", valign: "top" });
  s.addText(REV, { x: 11.85, y: 6.40, w: 0.95, h: 0.30, fontFace: FONT.mono, fontSize: 11, color: COLOR.caption, align: "right", valign: "middle" });
  try { s.addImage({ path: `${ASSETS}/logo-candidate-2.png`, x: 11.10, y: 6.80, w: 1.55, h: 0.37 }); } catch (e) {}
  addNotes(s, "Welcome. This is the 100-level deck in the API Patterns & Practices: gRPC series, and it is the what and the why: the patterns themselves, not any one framework's implementation of them. The domain is shipping and cargo throughout: a RoutingService that quotes and routes a booking, a TrackingService that watches a shipment move, a QuoteService it calls downstream. The premise for the whole series is one proto contract, two runtimes: every pattern we discuss ships in both Quarkus and Python/grpcio, generated from the same .proto files and asserted against the same contract in CI. But in this deck the snippets are wire-level only: .proto, the buf CLI, grpcurl calls and their output, decoded protobuf bytes, proto3-to-JSON mapping, google.rpc.Status, because the goal is to make each design decision defensible independent of language. When you want to see how a pattern is actually built, the two companion decks take over. I'm Robert Sedor, Principal Chief Architect in Application Development. By the end you should be able to explain why gRPC fits next to REST and GraphQL, how the four RPC shapes map to real interactions, how deadlines and rich errors keep a call chain's failures visible, how a schema evolves without breaking a deployed client, and how the whole system holds up under load, behind mTLS, traced end to end.");
}

/* ======================= 2 · AGENDA ======================= */
{
  const s = S();
  addContentTitle(s, "ROADMAP", "Agenda");
  addTwoColBullets(s,
    [
      "Why gRPC, and the decision lens",
      "Protobuf, the contract language",
      "Contract-first with Buf",
      "HTTP/2 & why gRPC is fast",
      "The four RPC shapes",
      "Reliability: deadlines & errors",
    ],
    [
      "Schema design & evolution",
      "Streaming at scale & performance",
      "Security: TLS, mTLS & authorization",
      "Observability, mesh & load balancing",
      "Browsers, transcoding & cross-protocol",
      "Testing, debugging & the Final Project",
    ],
    { fontSize: 16 });
  addCaption(s, "Stack-agnostic throughout. Every code sample is wire-level: .proto, buf, grpcurl, protobuf bytes, JSON mapping.");
  addNotes(s, "Here's the arc. We start with why gRPC exists next to REST and GraphQL, and a five-axis decision lens every later section reuses. Then the contract language itself: Protobuf's messages, field numbers, and the wire encoding that makes gRPC's framing cheap, followed by contract-first development with Buf, the tool that turns a schema review into a CI gate. HTTP/2 explains why gRPC is fast: multiplexing, header compression, and binary framing. From there, the four RPC shapes: unary, server-streaming, client-streaming, and bidirectional, each tied to a real interaction in the shipping domain. The middle of the deck is reliability: deadlines that propagate across a call chain, and the rich error model built on google.rpc.Status. Then schema design and evolution: field granularity, pagination, FieldMask projection, and exactly what buf breaking does and doesn't catch. We close with the production concerns: streaming at scale and performance tuning, security with TLS/mTLS and token-based authorization, observability and load balancing (including a service mesh), reaching gRPC from a browser, and finally testing, debugging, and the Final Project that runs every one of these mechanisms at once. Everything here is conceptual and stack-agnostic; cross-references are by topic, not slide number.");
}

/* ======================= DIVIDER 01 ======================= */
divider("01", "Why gRPC, and the decision lens",
  "What gRPC is, where it fits next to REST and GraphQL, and a five-axis framework for choosing it with intent.",
  "Before any design work, two foundations. First, a precise statement of what gRPC is: a typed method call compiled from a single .proto contract into both a client stub and a server skeleton, with no textual form on the wire. Second, a decision framework: RPC shape, sync call versus stream, deadline and budget, failure class and retryability, and concurrency model. This gives us the vocabulary every later section reuses, the same way the book closes every chapter with a Decision callout that runs its topic through these five axes.");

/* --- three paradigms --- */
{
  const s = S();
  addDiagramSlide(s, "FOUNDATIONS", "Three paradigms, one intent",
    "01-three-paradigms",
    "REST, gRPC, and GraphQL answering the identical request, quote a shipment from USNYC to NLRTM, with three different mental models.",
    { x: 1.30, y: 1.75, w: 10.73, h: 4.60 });
  addNotes(s, "Same client intent, three different mental models. REST thinks in nouns and verbs: a resource at a URI, manipulated with HTTP methods. GraphQL thinks in one graph to traverse, with the client naming exactly the fields it wants. gRPC thinks in a typed method call: RoutingService.GetQuote(request) returns GetQuoteResponse, not an HTTP verb against a URL. The detail worth sitting with is in the gRPC column: the .proto file is not documentation describing an API that exists independently; it is the contract, and it compiles to both the client stub and the server skeleton. There is no hand-written client code reading a spec and no server routing layer parsing a path template; protoc or buf generate produces both sides from one source. That's a structurally different relationship between the contract and the code than either REST or GraphQL has, and it's the reason gRPC's correctness guarantees look different from both: a client and server generated from the same proto cannot disagree about a method's shape, because neither one hand-wrote that shape in the first place.");
}

/* --- decision framework --- */
{
  const s = S();
  addDiagramSlide(s, "DECISION LENS", "The five-axis decision framework",
    "02-decision-framework",
    "RPC shape, sync vs. stream, deadline & budget, failure class & retryability, concurrency model: reused in every Decision callout that follows.",
    { x: 1.30, y: 1.70, w: 10.73, h: 4.55 });
  addNotes(s, "This is the lens every later section in this deck reuses. RPC shape asks the fastest-eliminating question: one response, a sequence of responses, a sequence of requests, or both at once. Sync vs. stream asks a narrower, operational question: does the caller block for one value or hold a connection open and consume values as they arrive. Deadline and budget is about dividing a time budget across a chain of calls, not setting one deadline in isolation, the hardest part in practice. Failure class and retryability says gRPC's canonical status codes let a caller tell transient conditions (UNAVAILABLE, retry with backoff) from permanent ones (INVALID_ARGUMENT, never retry) without parsing an error string. Concurrency model is about the server: given many concurrent calls, how do you avoid blocking a thread on I/O it doesn't need to block on. Worked example: RoutingService.GetQuote, the method this whole book keeps returning to. It's unary: one origin, one destination, one cargo manifest in, one Money and one Route out. It's synchronous because there's nothing to stream and the caller needs the price before it can proceed. Its deadline is a tight slice of the booking service's own request budget, carved and propagated rather than invented fresh. Its failures split cleanly: UNAVAILABLE and budget-permitting DEADLINE_EXCEEDED are safe to retry because it's a pure read; INVALID_ARGUMENT never is. And because the work is I/O-bound, waiting on a downstream call, not computing, it runs on whichever concurrency model avoids pinning a thread for that wait. Read this diagram once, and the short Decision box at the end of every section after it becomes a checkable claim instead of a slogan.");
}

/* --- four RPC shapes --- */
{
  const s = S();
  addDiagramSlide(s, "RPC SHAPES", "The four RPC shapes",
    "02-four-rpc-shapes",
    "Request cardinality crossed with response cardinality resolves to unary, server-streaming, client-streaming, and bidirectional.",
    { x: 1.30, y: 1.70, w: 10.73, h: 4.55 });
  addNotes(s, "Protobuf's service definitions name all four shapes directly, and the shipping contract uses every one of them for a reason tied to the interaction, not to variety for its own sake. RoutingService.GetQuote is unary because pricing a shipment is a single question with a single, immediately-known answer: nothing produces more than one value, so a stream would add bookkeeping for no benefit. TrackingService.WatchShipment is server-streaming because a shipment's location is a sequence of facts arriving over the life of a voyage, and the caller wants each one as it happens rather than re-asking on a timer. TrackingService.ReportPositions inverts that: a telemetry agent has many position reports to hand off and wants one acknowledgment: client-streaming, not a loop of unary calls paying a round trip per report. RoutingService.NegotiateRoute is bidirectional because negotiation is a back-and-forth where either side sends at a time of its own choosing. Picking the shape first matters because the remaining four decision axes behave differently depending on it: a deadline on a unary call bounds one round trip; a deadline on a streaming call bounds how long the stream may stay open, a different number entirely. We'll see a concrete grpcurl call against each of these four shapes shortly.");
}

/* ======================= DIVIDER 02 ======================= */
divider("02", "Protobuf, the contract language",
  "Messages, field numbers, and the wire encoding that makes gRPC's binary framing cheaper than JSON, plus the well-known types at the edges.",
  "Every gRPC contract starts here: a .proto file defining messages as a set of numbered fields, never positional and never named on the wire. This section opens the wire format itself: tags, wire types, and length-prefixed bytes, then covers the well-known types (Timestamp, Duration, FieldMask, Any) that handle the cases a bare scalar handles badly, and how proto3 renders to and from JSON at the edges.");

/* --- protobuf anatomy diagram --- */
{
  const s = S();
  addDiagramSlide(s, "PROTOBUF", "A message's anatomy: fields, tags, wire bytes",
    "03-protobuf-anatomy",
    "A Money message, currency (tag 1), amount (tag 2), alongside the 14-byte serialized form it actually produces on the wire.",
    { x: 1.60, y: 1.70, w: 10.13, h: 4.55 });
  addNotes(s, "A protobuf message is a set of fields, and every field carries a tag number, not a name, on the wire. Money has two string fields: currency at tag 1, amount at tag 2. Serialized, that becomes a 0x0A key byte, which decodes as field 1, wire type 2 (length-delimited), a length byte, then the raw UTF-8 bytes for 'USD'; then a 0x12 key byte for field 2, another length byte, then the bytes for '1250.00'. Fourteen bytes total, with zero bytes spent on the strings 'currency' or 'amount': the field number is the only thing that travels, and the generated code on both ends already knows what number 1 and number 2 mean. There are four wire types in total: VARINT for integers and booleans, I64 and I32 for fixed-width 64- and 32-bit values, and LEN for length-delimited strings, bytes, embedded messages, and packed repeated fields. This is why renumbering a field is one of the few truly dangerous changes in a proto: the number is the identity on the wire, forever, for as long as any client built against the old number might still be talking to you, a claim we'll make precise in the evolution section.");
}

/* --- proto excerpt code --- */
{
  const s = S();
  addCodeSlide(s, "PROTOBUF", "The shared domain types, once", "proto3",
    [
      "// contracts/proto/shipping/type/v1/types.proto",
      "syntax = \"proto3\";",
      "package shipping.type.v1;",
      "",
      "// Money as decimal strings, to avoid binary float drift.",
      "message Money {",
      "  string currency = 1;  // ISO 4217, e.g. \"USD\"",
      "  string amount = 2;    // decimal string, e.g. \"1250.00\"",
      "}",
      "",
      "// A port or terminal, identified by UN/LOCODE (e.g. \"USNYC\").",
      "message Location {",
      "  string un_locode = 1;",
      "  string name = 2;",
      "}",
      "",
      "// A customer's request to ship cargo — the aggregate root.",
      "message Booking {",
      "  string id = 1;              // \"bkg_\" prefix, ULID-shaped",
      "  Location origin = 2;",
      "  Location destination = 3;",
      "  repeated Cargo cargo = 4;",
      "  Money quote = 6;",
      "  google.protobuf.Timestamp created_at = 7;",
      "}",
    ],
    "Defined once here, imported by every service package (routing, tracking, quote), one source of truth, every field numbered explicitly.",
    { fontSize: 11 });
  addNotes(s, "This is the real shared-types file every service package in the system imports: the single-source-of-truth analog of a shared JSON Schema component in a REST contract. Money stores amount as a decimal string, never a float or a fixed-point integer, for the same reason a REST API does: binary floating point drifts, and a currency amount cannot afford that. Location is identified by UN/LOCODE, the five-character standard port and terminal codes like USNYC and NLRTM, reusing an existing identifier standard rather than inventing one. Booking is the aggregate root: notice every field carries an explicit number, assigned once and never reused, and the message composes other messages (Location, Money) and a well-known type (Timestamp) rather than reinventing any of their shapes: repeated Cargo cargo shows the ordered-collection shape directly; the real file also carries a map<string,string> of labels, trimmed from this excerpt for space, whose lack of ordering the appendix contrasts against repeated's guaranteed order. Every RPC shape and every service we look at from here forward builds on these exact message definitions, imported by reference, never copy-pasted.");
}

/* --- well-known JSON mapping diagram --- */
{
  const s = S();
  addDiagramSlide(s, "WELL-KNOWN TYPES", "proto3 JSON mapping, read both directions",
    "04-wellknown-json-mapping",
    "Library JSON renders camelCase: Timestamp as RFC 3339, Money.amount as a decimal string; grpcurl's own printed output reverts to snake_case.",
    { x: 1.30, y: 1.70, w: 10.73, h: 4.55 });
  addNotes(s, "Every gRPC message has a canonical JSON mapping, which matters anywhere a human or a JSON-only tool touches the wire: grpcurl, logs, a REST-transcoding gateway. The proto3 JSON spec renders field names in lowerCamelCase by default (un_locode becomes unLocode), renders a google.protobuf.Timestamp as an RFC 3339 string, and, critically for financial data, Money.amount is a string in our contract specifically so JSON doesn't coerce it into a binary-float-backed JSON number. One quirk worth knowing before it surprises you in a demo: grpcurl happily accepts a request body written in proto3 JSON's default camelCase, but it prints the response back using each message's original, snake_case field names, so you type unLocode going in and read un_locode coming back out. The request and the response pass through the same JSON mapping in opposite directions, and the tool doesn't normalize the two to match. We'll see this exact behavior on the next slide with a real captured call.");
}

/* --- JSON mapping code --- */
{
  const s = S();
  addCodeSlide(s, "WELL-KNOWN TYPES", "Timestamp, Money, and the camelCase/snake_case quirk", "grpcurl",
    [
      "$ grpcurl -plaintext -d '{\"origin\":{\"unLocode\":\"USNYC\"},",
      "    \"destination\":{\"unLocode\":\"NLRTM\"}}' \\",
      "    localhost:9007 shipping.routing.v1.RoutingService/FindOptimalRoute",
      "",
      "# Response — grpcurl prints snake_case field names, even though the",
      "# request above was written in proto3 JSON's default camelCase:",
      "route.legs[0].carrier      = \"MAERSK\"",
      "route.legs[0].departs_at   = \"2026-02-01T10:00:00Z\"   // Timestamp -> RFC 3339",
      "route.legs[0].arrives_at   = \"2026-02-18T06:00:00Z\"",
      "route.price.currency       = \"USD\"",
      "route.price.amount         = \"4200.00\"                // decimal STRING, never a float",
    ],
    "Both servers are generated from the same .proto and render this identically: the only variable left is JSON mapping, not business logic.");
  addNotes(s, "A real captured call. The request goes in with unLocode, proto3 JSON's default camelCase rendering of the un_locode field. The response comes back with route.legs[0].departs_at and arrives_at rendered as RFC 3339 timestamp strings, not epoch integers, because the underlying field type is google.protobuf.Timestamp, and the JSON mapping for that well-known type is specified once, for every proto3 message that uses it, rather than hand-rolled per field. route.price.amount comes back as the string '4200.00', never a JSON number, for exactly the float-drift reason Money was designed as decimal strings. And notice the field names on the way out, departs_at, not departsAt, which is grpcurl's own rendering convention, not a bug in the server. This single call, run against two independently generated servers built from the same proto, produces byte-identical output on both, which is the whole promise of contract-first development: the mapping is a property of the schema, not of either implementation.");
}

/* ======================= DIVIDER 03 ======================= */
divider("03", "Contract-first with Buf",
  "One proto, three gates: lint, build, breaking, before either stack generates a line of code.",
  "Contract-first means the .proto is reviewed and gated before any handler is written. Buf is the tool: it lints for naming and style, builds to confirm every import resolves, and diffs a candidate against a baseline to catch a breaking change before it ever reaches a generated stub. This section covers the gate itself; the next chapter in this story, exactly what buf breaking does and doesn't catch, comes later, in schema design and evolution.");

/* --- contract-first flow diagram --- */
{
  const s = S();
  addDiagramSlide(s, "BUF", "One proto, two generators, one gate",
    "05-contract-first-buf-flow",
    "buf lint, buf build, and buf breaking run before either stack generates a stub; one CI gate asserts both generated servers against the same contract.",
    { x: 1.30, y: 1.70, w: 10.73, h: 4.55 });
  addNotes(s, "This is the spine of contract-first development. One proto file feeds three Buf gates in sequence. Quarkus and Python each generate their own stubs from the same source only once all three gates pass: a change that fails lint, fails to build, or breaks compatibility never reaches either stack's generated code. Once generated, each stack's independently-written server implements the same method, and one CI script asserts both servers against the identical contract: not just that they return OK, but that they return the same answer. This is the payoff that makes contract-first worth the review-step cost it adds: a silent divergence between two independently-deployed services doesn't surface as a lint warning, it surfaces as two services that compile cleanly and disagree about what a message means, exactly the failure buf breaking exists to catch before it ships.");
}

/* --- buf.yaml code --- */
{
  const s = S();
  addCodeSlide(s, "BUF", "buf.yaml: the gate contract itself", "yaml",
    [
      "# contracts/buf.yaml",
      "version: v2",
      "modules:",
      "  - path: proto",
      "lint:",
      "  use:",
      "    - STANDARD",
      "breaking:",
      "  use:",
      "    - FILE",
    ],
    "breaking: FILE is the stricter of buf's two breaking categories: it treats a deleted-but-reserved field as still breaking. More in Schema design & evolution.",
    { fontSize: 20 });
  addNotes(s, "This is the entire configuration that drives every gate in the system: small by design, because the two meaningful decisions are which rule sets to use, not a pile of custom rules. lint: STANDARD is Buf's recommended naming, comment, and style rule set. breaking: FILE is the more interesting choice: Buf actually ships two breaking-change categories, FILE and the looser WIRE_JSON, and FILE is the stricter one: among other things, it does not grant an exception for deleting a field that was first marked reserved. We'll see exactly what that means, and why this book picks the stricter option in the schema design and evolution section. For now, the point is that this ten-line file is what every later proto change in the system has to pass before a single line of generated code exists.");
}

/* --- grpcurl on the wire code --- */
{
  const s = S();
  addCodeSlide(s, "BUF", "On the wire: reflection, no local .proto needed", "grpcurl",
    [
      "$ grpcurl -plaintext localhost:9005 list",
      "grpc.reflection.v1alpha.ServerReflection",
      "shipping.routing.v1.RoutingService",
      "",
      "$ grpcurl -plaintext -d '{\"origin\":{\"unLocode\":\"USNYC\"},",
      "    \"destination\":{\"unLocode\":\"NLRTM\"},",
      "    \"cargo\":[{\"weightKg\":1200.5}]}' \\",
      "    localhost:9005 shipping.routing.v1.RoutingService/GetQuote",
      "",
      "# quote.amount == \"3001.25\"   (1200.5 * 2.50, rounded half-up, as a string)",
      "# Swap port 9005 for 9006 — the Python stack answers identically.",
    ],
    "Server reflection means grpcurl needs zero local .proto copies: the server itself describes its own services and messages over the wire.");
  addNotes(s, "Once a proto passes all three Buf gates and both stacks generate stubs from it, grpcurl is how you poke at the running system without writing a client. The list command uses gRPC server reflection, a well-known service every server in this book enables, to discover what RoutingService even offers, with zero local copies of the .proto file required. The GetQuote call that follows is the exact request from the chapter's own worked example: one cargo item at 1200.5 kilograms, and the quote comes back as the string '3001.25': 1200.5 times 2.50, rounded half-up, rendered as a decimal string per the Money convention we just covered. The real payoff of contract-first shows up in the last line: the identical request against the Python stack on a different port produces the identical answer, because both servers were generated from, and are asserted against, the same proto file, not because anyone hand-synchronized two implementations.");
}

/* ======================= DIVIDER 04 ======================= */
divider("04", "HTTP/2 & why gRPC is fast",
  "Multiplexed streams on one connection, header compression, and binary framing with no field names on the wire.",
  "gRPC's performance story is mostly HTTP/2's story: many RPCs share one TCP connection as independent, interleaved streams; repeated headers compress via HPACK instead of re-sending as text; and the body of every message is the length-prefixed binary format from the previous section, which costs a fraction of the equivalent JSON. This section makes that saving concrete, in bytes.");

/* --- http2 multiplexing diagram --- */
{
  const s = S();
  addDiagramSlide(s, "HTTP/2", "Three RPCs, three streams, one connection",
    "06-http2-multiplexing",
    "GetQuote, ListRoutes, and FindOptimalRoute interleave as independent HTTP/2 streams on one TCP connection; HPACK keeps their headers from repeating.",
    { x: 1.30, y: 1.70, w: 10.73, h: 4.55 });
  addNotes(s, "HTTP/1.1 either serializes requests on one connection or opens several connections to get concurrency: both have real costs. HTTP/2 multiplexes: one TCP connection carries many independent streams, each one a numbered sequence of frames, and frames from different streams interleave freely on the wire without blocking each other at the HTTP layer. Here, GetQuote, ListRoutes, and FindOptimalRoute are three separate calls on three separate streams, all sharing one connection, with their HEADERS and DATA frames arriving in actual send order rather than call order. HPACK is the header-compression layer underneath: instead of re-sending ':method: POST' and 'content-type: application/grpc' as text on every single stream, HPACK maintains a shared compression table both sides reference, so repeated headers cost almost nothing after the first stream establishes them. Combined with one long-lived, reused channel, which the four-RPC-shapes section already assumed, this is why a gRPC service under load opens drastically fewer connections than an equivalent HTTP/1.1 service making the same number of calls.");
}

/* --- wire bytes + size comparison code --- */
{
  const s = S();
  addCodeSlide(s, "HTTP/2", "Wire bytes: protobuf vs. the equivalent JSON", "hex",
    [
      "// Money { currency = \"USD\"; amount = \"1250.00\"; } — 14 bytes, no field names:",
      "0x0A 0x03  55 53 44                   // field 1 (currency), LEN, len 3, \"USD\"",
      "0x12 0x07  31 32 35 30 2E 30 30        // field 2 (amount),   LEN, len 7, \"1250.00\"",
      "",
      "// A nested message costs one extra key + length byte per level — no depth",
      "// tracking required, since every key only encodes the CURRENT field's number:",
      "0x0A 0x0E  <14 bytes of Money>  0x12 ...   // GetQuoteResponse.quote, then .route",
      "",
      "// The same value as JSON — self-describing, and larger:",
      "{\"currency\":\"USD\",\"amount\":\"1250.00\"}      // 37 bytes",
    ],
    "14 bytes vs. 37 for one Money value, and the gap widens with every nested message, since JSON repeats field names at every level.");
  addNotes(s, "Two savings stack on top of each other. First, within one message: protobuf spends exactly a tag byte and, for length-delimited types, a length byte per field, two bytes of overhead regardless of how long the field name is, while JSON spends the entire quoted field name, every single time, on every single message instance. For our Money example that's 14 bytes of protobuf against 37 bytes of equivalent JSON, and that ratio only gets worse for a message with more and longer field names than currency and amount. Second, nesting: embedding one message inside another, Money inside a GetQuoteResponse, which also carries a Route, costs protobuf exactly one more key byte and one more length byte per level of nesting, and a parser never has to track how deep it is, because every key only ever encodes the current message's own field number and wire type. JSON, by contrast, re-pays the full field-name tax at every nesting level. None of this means JSON is a bad format: it's self-describing, which protobuf is not, but it is why a gRPC service moving the same logical data moves measurably fewer bytes, which matters at the scale and frequency internal service-to-service calls run at.");
}

/* ======================= DIVIDER 05 ======================= */
divider("05", "The four RPC shapes, called",
  "A client stub, a reused channel, a server skeleton, and grpcurl calls against all four shapes.",
  "With the shapes named in the decision framework, this section shows the stub-to-stub path every call travels, and then drives each shape with a real grpcurl call: unary, server-streaming, and client/bidirectional streaming, each against the exact method it was built for.");

/* --- unary stub-to-stub diagram --- */
{
  const s = S();
  addDiagramSlide(s, "UNARY", "The stub-to-stub path",
    "07-unary-stub-to-stub",
    "One proto compiles to a generated client stub and a generated server skeleton; every call travels typed call in, protobuf on the wire, typed call out.",
    { x: 1.30, y: 1.70, w: 10.73, h: 4.55 });
  addNotes(s, "This is the path every single RPC in this system travels, regardless of shape. Client code calls a generated stub with a typed request object: never a hand-built URL or a hand-written request line. The stub hands off to one HTTP/2 channel, built once per process and reused for the process's lifetime rather than opened per call. The channel carries the request as protobuf-encoded bytes, the format from the Protobuf section, to a generated server skeleton, which dispatches to the actual handler. The handler returns a typed response, which travels back the same path in reverse. There is no textual form of this request anywhere on the wire: you cannot curl a gRPC endpoint and get a sensible answer, because there's no request line to type by hand: only a compiled stub producing compiled bytes. That's the trade gRPC makes for its wire efficiency and its generated-code safety: less ad hoc debuggability, which is exactly why grpcurl and server reflection, the tools we've been using all along, exist as the answer to 'how do I poke at this without writing a client'.");
}

/* --- server streaming diagram --- */
{
  const s = S();
  addDiagramSlide(s, "SERVER STREAMING", "WatchShipment: one request, one stream, four events",
    "08-server-streaming",
    "One WatchShipmentRequest opens a single HTTP/2 stream; four ordered TrackingEvent frames follow, then the server half-closes.",
    { x: 1.30, y: 1.70, w: 10.73, h: 4.55 });
  addNotes(s, "Server-streaming in its purest form. The client sends exactly one request, opening a single HTTP/2 stream. The server then writes a sequence of DATA frames onto that same stream, here, four TrackingEvents in order: PENDING at the origin port, CONFIRMED at the same port, IN_TRANSIT and DELIVERED at the destination, before finally half-closing its own side, which signals 'that's every event, I'm done'. The client reads to completion with no separate polling loop and no guessing about whether another event is coming; the half-close itself is the end-of-stream signal. Compare this to the alternative of polling a GetShipmentStatus endpoint on a timer: three out of four polls would return the unchanged answer, wasting a round trip each time, and the fourth poll would only catch a state change up to one whole polling interval after it actually happened. One open stream, pushed the instant each event posts, beats that on both axes: fewer wasted calls and no staleness beyond ordinary network latency.");
}

/* --- grpcurl across shapes code --- */
{
  const s = S();
  addCodeSlide(s, "ALL FOUR SHAPES", "Driving each shape with grpcurl", "grpcurl",
    [
      "# Unary — one request, one response:",
      "$ grpcurl -plaintext -d '{\"origin\":{\"unLocode\":\"USNYC\"},\"destination\":{\"unLocode\":\"NLRTM\"},",
      "    \"cargo\":[{\"weightKg\":1200.5}]}' localhost:9005 shipping.routing.v1.RoutingService/GetQuote",
      "",
      "# Server-streaming — grpcurl prints one JSON object per frame, until half-close:",
      "$ grpcurl -plaintext -d '{\"bookingId\":\"bkg_demo\"}' \\",
      "    localhost:9080 shipping.tracking.v1.TrackingService/WatchShipment",
      "",
      "# Client-streaming — 3 requests folded into ONE response:",
      "$ printf '%s\\n' '{\"event\":{\"bookingId\":\"bkg_demo\",\"note\":\"p1\"}}' \\",
      "    '{\"event\":{\"bookingId\":\"bkg_demo\",\"note\":\"p2\"}}' '{\"...\":\"p3\"}' \\",
      "  | grpcurl -plaintext -d @ localhost:9090 shipping.tracking.v1.TrackingService/ReportPositions",
      "# -> accepted_count = 3",
    ],
    "-d @ streams newline-delimited JSON requests from stdin: the same flag drives bidirectional calls, interleaving reads and writes.",
    { fontSize: 11 });
  addNotes(s, "One CLI, all four shapes, no generated client needed. Unary is the familiar -d with one JSON payload, one response back. Server-streaming uses the identical -d flag, but grpcurl keeps printing one JSON object per frame until the server half-closes: there's no 'give me N messages' flag, because the RPC itself decides how many frames the stream carries. Client-streaming flips that: -d @ reads newline-delimited JSON messages from stdin, so a shell printf can feed three separate position reports into ReportPositions, and the single response that comes back folds all three into one accepted_count of 3: proving the server actually consumed every request, not just that the stream opened and closed cleanly. The fourth shape, bidirectional, RoutingService.NegotiateRoute, uses the same -d @ mechanism, except now grpcurl interleaves reads and writes on the same connection, printing a response as soon as one arrives rather than waiting for the whole input to finish, which is exactly the half-close-independent, two-way conversation bidirectional streaming is for.");
}

/* ======================= DIVIDER 06 ======================= */
divider("06", "Reliability: deadlines & errors",
  "A deadline on every call, a canonical status vocabulary, and typed error details a client can act on without parsing a string.",
  "Two mechanisms carry the weight of production reliability. A deadline states up front the longest an answer is still useful, and it has to be divided across a call chain, not set once in isolation. gRPC's canonical status codes, enriched with google.rpc.Status detail messages, let a caller distinguish a malformed request from a transient outage from an overloaded server: three very different responses that a single INTERNAL code would erase.");

/* --- deadline propagation diagram --- */
{
  const s = S();
  addDiagramSlide(s, "DEADLINES", "The same downstream delay, two different outcomes",
    "10-deadline-propagation",
    "A 10-second client deadline absorbs a 2-second downstream delay cleanly; a 1-second deadline cancels the same call mid-flight with DEADLINE_EXCEEDED.",
    { x: 1.30, y: 1.70, w: 10.73, h: 4.55 });
  addNotes(s, "A three-hop chain, the booking service, RoutingService.GetQuote, QuoteService.GetQuote, carrying the same artificial two-second delay on the downstream hop, run twice with two different client deadlines. With a generous ten-second deadline, RoutingService carves out roughly 9.9 seconds for the downstream call, the two-second delay completes comfortably inside that slice, and OK responses flow back up both hops. With a tight one-second deadline, RoutingService carves out roughly 0.9 seconds instead, the downstream call gets cancelled partway through its two-second delay before it can finish, and DEADLINE_EXCEEDED flows back up both hops. The deadline gets actively propagated and re-carved at every hop, not checked once at the top, and the hard part is dividing a budget the caller handed you across however many hops your own call fans out into, not setting one number. Get the slice wrong in either direction and you either fail calls that would have succeeded, or let one slow dependency hold an entire chain hostage.");
}

/* --- rich error model diagram --- */
{
  const s = S();
  addDiagramSlide(s, "ERRORS", "A gRPC error is a code, a message, and typed details",
    "11-rich-error-model",
    "google.rpc.Status carries a canonical code plus typed detail messages, ErrorInfo, BadRequest, RetryInfo, in the gRPC trailers, which a client unpacks before deciding whether to retry.",
    { x: 1.30, y: 1.70, w: 10.73, h: 4.55 });
  addNotes(s, "A canonical gRPC status code alone tells a client what kind of failure occurred; google.rpc.Status adds why, in a typed, machine-readable form, riding in the gRPC trailers alongside the code. RoutingService.GetQuote failing with NOT_FOUND packs an ErrorInfo detail carrying a reason and a domain; a malformed request packs a BadRequest with the specific field violations; a transient condition packs a RetryInfo naming exactly how long to wait before retrying. A client reads the code first and branches immediately: UNAVAILABLE, an idempotent DEADLINE_EXCEEDED, and RESOURCE_EXHAUSTED go down a retryable path that backs off and tries again; INVALID_ARGUMENT, NOT_FOUND, and FAILED_PRECONDITION go down a non-retryable path that surfaces the failure right now, because retrying them unchanged wastes a retry budget on an answer that cannot improve. This is the same discipline REST achieves with RFC 9457 Problem Details, a machine-readable error shape instead of a prose string, expressed in gRPC's own typed-details mechanism instead.");
}

/* --- retryable vs not table --- */
{
  const s = S();
  addContentTitle(s, "ERRORS", "The canonical codes, grouped by what a client does next");
  addStatusTable(s, [
    { code: "INVALID_ARGUMENT", name: "malformed request", purpose: "Retry never: the same request fails the same way again." },
    { code: "NOT_FOUND / FAILED_PRECONDITION", name: "state of the world", purpose: "Retry never: describes a fact, not a glitch reaching it." },
    { code: "UNAVAILABLE / DEADLINE_EXCEEDED", name: "transient", purpose: "Retry with backoff, or only if idempotent, for a deadline." },
    { code: "RESOURCE_EXHAUSTED", name: "self-imposed overload", purpose: "Retry yes, honoring backoff: the server is shedding load to protect itself." },
    { code: "UNAUTHENTICATED / PERMISSION_DENIED", name: "auth", purpose: "Retry only after fixing the credential or the grant." },
    { code: "INTERNAL", name: "last resort", purpose: "No better name for it yet: never the default; collapsing to it erases the signal." },
  ], { colW: [3.10, 2.60, 6.39], rowH: 0.65 });
  addCaption(s, "Don't collapse everything to INTERNAL; it erases the one signal a client actually acts on: retry, give up, or page someone.");
  addNotes(s, "This is the table every retry policy in the system is built from: not alphabetical, but grouped by what a caller does with the information. A malformed request and a fact about the world are both permanently non-retryable, but for different reasons: one never parses correctly, the other correctly reports that, say, an origin doesn't route: retrying either wastes effort. Transient conditions are the opposite: UNAVAILABLE and DEADLINE_EXCEEDED usually clear on their own, so backing off and retrying is the right move, with the caveat that a DEADLINE_EXCEEDED retry is only safe if the call is idempotent and budget remains, since retrying a non-idempotent call that already partially executed risks doing the work twice. RESOURCE_EXHAUSTED is a server shedding load to protect itself, the gRPC analog of an HTTP 429, and calls for backing off, not hammering it harder. Auth failures need the credential or the grant fixed before any retry helps. And INTERNAL is explicitly the last resort: a well-built service picks a more specific code whenever the failure has a real classification, because collapsing everything to INTERNAL erases the one signal a client can actually act on.");
}

/* --- google.rpc.Status payload code --- */
{
  const s = S();
  addCodeSlide(s, "ERRORS", "google.rpc.Status, captured off the wire", "grpcurl",
    [
      "$ grpcurl -plaintext -d '{\"destination\":{\"unLocode\":\"NLRTM\"}}' \\",
      "    localhost:9110 shipping.routing.v1.RoutingService/GetQuote",
      "ERROR: Code: InvalidArgument   # Message names BadRequest + the missing field",
      "",
      "$ grpcurl -plaintext -d '{\"origin\":{\"unLocode\":\"ZZZZZ\"},\"destination\":{\"unLocode\":\"NLRTM\"}}' \\",
      "    localhost:9110 shipping.routing.v1.RoutingService/GetQuote",
      "ERROR: Code: NotFound   # Message names ErrorInfo + reason=ORIGIN_UNROUTABLE",
      "",
      "$ grpcurl -plaintext -d '{\"origin\":{\"unLocode\":\"RETRY\"},\"destination\":{\"unLocode\":\"NLRTM\"}}' \\",
      "    localhost:9110 shipping.routing.v1.RoutingService/GetQuote",
      "ERROR: Code: Unavailable   # Message names RetryInfo (retry_delay = 2s)",
    ],
    "Three requests, three codes, three detail types, ErrorInfo, BadRequest, RetryInfo, from google/rpc/error_details.proto, never declared in routing.proto itself.",
    { fontSize: 11 });
  addNotes(s, "Three real calls against the same method, each exercising a different failure class. A missing origin is INVALID_ARGUMENT with a BadRequest detail naming the offending field, permanently non-retryable. An origin that parses fine but doesn't route anywhere, 'ZZZZZ', is NOT_FOUND with an ErrorInfo detail carrying a machine-readable reason, ORIGIN_UNROUTABLE, also non-retryable, because it's a fact about the routing graph, not a glitch. A sentinel input that simulates a transient backend hiccup comes back UNAVAILABLE with a RetryInfo detail that names exactly how long to wait, two seconds, before trying again. None of these detail types, ErrorInfo, BadRequest, RetryInfo, are declared anywhere in routing.proto; they come from a shared, well-known error-details schema that every gRPC implementation on every stack already knows how to pack and unpack, the same way every stack already knows how to render a Timestamp. A client branches on the code first, then unpacks the detail only if it needs the specifics, never the other way around.");
}

/* ======================= DIVIDER 07 ======================= */
divider("07", "Schema design & evolution",
  "Field granularity, pagination, and projection, then exactly what buf breaking catches, and what reserved does and does not excuse.",
  "A schema that ships once never changes; a schema that ships to production evolves constantly, with deployed clients that can't all upgrade in lockstep. This section covers the day-to-day design choices, when to nest a message versus reference it by id, how to paginate a large collection, how FieldMask lets one message serve two different views, then gets precise about the one invariant that can never move: a field's number.");

/* --- pagination/granularity synthesis as evolution diagram --- */
{
  const s = S();
  addDiagramSlide(s, "EVOLUTION", "Safe changes leave every number's meaning untouched",
    "14-evolution-compatibility",
    "Rename, add a field, add an RPC, widen a numeric type: all safe. Renumber, reuse a number, retype, or remove a field a reader needs: all breaking.",
    { x: 1.30, y: 1.70, w: 10.73, h: 4.55 });
  addNotes(s, "Two design choices set up this matrix. Message granularity: nest a child message when its identity only makes sense as part of the parent, a Leg has no meaning outside the Route that contains it, and reference by id when a value has its own callers and its own lifecycle, the way a carrier_id points at a separate CarrierService rather than embedding the whole carrier record. Pagination and FieldMask follow the same instinct toward decoupling: an opaque, server-defined page token survives inserts and deletes between calls in a way a client-computed offset silently doesn't, and a FieldMask lets one Route message serve both a summary list view and a detail view without two separate RPCs. All of that is upstream of the matrix on this slide, which is what actually governs whether a later change to any of these messages is safe to ship. Renaming a field, adding a new one at an unused number, adding a whole new RPC, or widening a numeric type (int32 to int64, same wire type, a varint either way) are all safe: no existing reader's interpretation of any existing field changes. Renumbering a field, reusing a retired number, changing a field's wire type, or removing a field a reader still depends on are all breaking: an old binary in the field, compiled against the old shape, will misread the new bytes. The field number, not the name, is the one thing that can never move once a message has shipped to even one deployed client you don't control.");
}

/* --- reserved + v1->v2 code --- */
{
  const s = S();
  addCodeSlide(s, "EVOLUTION", "reserved blocks reuse; a v2 package sidesteps the gate entirely", "proto3",
    [
      "// candidate-safe/ — adding a field is safe; reserving retired numbers",
      "// pre-blocks a future accident:",
      "message GetQuoteRequest {",
      "  reserved 10, 11;",
      "  reserved \"internal_only\";",
      "  string origin_un_locode = 1;",
      "  string legacy_notes = 4;      // untouched",
      "  int32 cargo_count = 5;        // new",
      "}",
      "",
      "// shipping/routing/v2/routing.proto — a NEW path, invisible to",
      "// `buf breaking --against v1`, which only diffs matching paths:",
      "message GetQuoteRequest {",
      "  reserved 4; reserved \"legacy_notes\";   // drops the v1 field",
      "  string origin_un_locode = 1;",
      "  int32 cargo_count = 5;",
      "}",
    ],
    "v1 and v2 coexist at runtime during a rolling deploy: old clients keep talking to v1, new clients move to v2, by two different file paths.",
    { fontSize: 12 });
  addNotes(s, "Two different ways to make a change that would otherwise be rejected. reserved pre-blocks a field number or name so a future change can never accidentally reuse it: that's what the safe candidate does with numbers 10 and 11 and the name internal_only, none of which anything has ever used. A new package version is the other, more drastic tool: shipping.routing.v2.GetQuoteRequest drops field 4 entirely, the exact deletion that would fail buf breaking inside v1, but because this message lives at an entirely new file path, shipping/routing/v2/routing.proto, buf breaking run against the v1 baseline never even compares it; there's nothing on the baseline side at that path to diff against. This is not the tool being lenient about packages: buf breaking only ever diffs files it finds at a matching path on both sides, so a new version is structurally invisible to the gate by construction. During the rolling deploy this enables, the old RoutingServiceImpl keeps serving clients still generated from v1, while a second implementation serves clients that have migrated to v2, both running simultaneously, from two different generated packages, off two different files on disk.");
}

/* --- buf breaking failure code --- */
{
  const s = S();
  addCodeSlide(s, "EVOLUTION", "buf breaking, run against a seeded regression", "text",
    [
      "$ buf breaking candidate-breaking --against baseline",
      "candidate-breaking/.../routing.proto: field \"2\" (destination_un_locode) was deleted.",
      "candidate-breaking/.../routing.proto: field \"4\" (legacy_notes) was deleted.",
      "candidate-breaking/.../routing.proto: field \"3\" (weight_kg) changed type",
      "    from \"double\" to \"int32\".",
      "$ echo $?",
      "100",
      "",
      "# Reserving the number first does NOT change the verdict:",
      "$ buf breaking candidate-breaking-reserved --against baseline",
      "candidate-breaking-reserved/.../routing.proto: field \"4\" (legacy_notes) was deleted.",
      "$ echo $?",
      "100   # identical failure — reserved blocks future reuse, not this deletion",
    ],
    "Real output from the book's own seeded-failure proof: deleting a field, reserved or not, fails the FILE breaking category every time.");
  addNotes(s, "This is real, captured output from the book's own seeded-failure proof, which exists specifically to show the gate actually bites rather than trusting that it would. The breaking candidate deletes two fields and retypes a third, and buf breaking names all three violations by field number and exits 100: not a vague 'something changed', but the precise field and the precise change. The second, more interesting case directly answers a question a careful reader would ask: would reserving the field number first have made the deletion safe? candidate-breaking-reserved deletes the identical legacy_notes field, field 4, except this time it's been marked reserved on the way out. The failure is identical: same field, same exit code. Marking a field reserved stops a future field from reusing that retired number or name; it does nothing to excuse deleting the field right now, under the stricter FILE breaking category this book's buf.yaml chooses. Buf does ship a looser rule that grants exactly that exception, but it lives in the WIRE_JSON category, not FILE, which is precisely why the choice of breaking category, back on the buf.yaml slide, isn't a default to accept without reading it.");
}

/* ======================= DIVIDER 08 ======================= */
divider("08", "Streaming at scale & performance",
  "HTTP/2 flow control under a slow consumer, and the four levers that actually move the needle: channels, message size, compression, keepalive.",
  "A stream that behaves correctly at demo scale can still misbehave under real load if the consumer falls behind, or if the easy performance levers were left untouched. This section covers backpressure at the HTTP/2 flow-control layer, then the concrete levers: channel reuse, max message size, compression, and keepalive, and what each one costs to turn on.");

/* --- flow control diagram --- */
{
  const s = S();
  addDiagramSlide(s, "BACKPRESSURE", "A stalled consumer runs the flow-control window to zero",
    "17-http2-flow-control-window",
    "A reading consumer keeps the receive window replenished with WINDOW_UPDATE frames; a stalled one lets it run out, and the server's sender blocks.",
    { x: 1.30, y: 1.70, w: 10.73, h: 4.55 });
  addNotes(s, "HTTP/2 flow control is what keeps a fast server from flooding a slow consumer's memory on a long-lived stream like WatchShipment. Every stream starts with a receive window, commonly 64 KiB, and every DATA frame the server sends consumes some of that window. A client that's actively reading sends WINDOW_UPDATE frames back as it consumes data, replenishing the credit continuously, and the server keeps writing. A client that stops draining its receive buffer, blocked downstream, or simply not calling the next read, stops sending WINDOW_UPDATE frames, the window shrinks toward zero, and the server's sender blocks with no credit left to write. This is backpressure working as designed, not a bug: it propagates the slow consumer's problem back to the producer at the transport layer, automatically, with no application code having to notice and react. The lever a server author actually controls is upstream of this: whether the server even generates events demand-driven, pulled only when there's room, or eagerly pre-materializes them regardless of whether the consumer is ready, which decides how much pressure ever reaches this mechanism in the first place.");
}

/* --- performance levers diagram --- */
{
  const s = S();
  addDiagramSlide(s, "PERFORMANCE", "Four tuning knobs, and what each one costs",
    "18-performance-levers",
    "Keepalive, max message size, gzip compression, and channel pooling: each buys something real, each has a cost except one.",
    { x: 1.30, y: 1.70, w: 10.73, h: 4.55 });
  addNotes(s, "Four levers, in the order you should actually reach for them. Channel pooling, reuse one channel, never reconnect per call, has no real cost and should simply always be on; there is no workload shape where opening a fresh channel per call is the right call, and the cost compounds with every call a service makes over its lifetime. Keepalive keeps an idle connection alive across a quiet gap at the cost of periodic ping traffic: worth it for any stream a caller might hold open longer than the shortest idle timeout anywhere in its network path, which in practice means every long-lived stream, since that timeout is rarely visible to either endpoint. Max message size raises the ceiling on how large a single message may be, at the cost of raising it on both the sending and receiving side together, and the better fix is usually to shrink the payload (pagination, FieldMask projection) rather than raise the cap indefinitely, since a bigger allowed message is a bigger chunk of memory the server commits to holding per in-flight call. Gzip compression shrinks the payload on the wire at a real CPU cost per call: worth it for a large, repetitive payload like a paginated route catalog, a wash or a net loss for a already-small or already-compressed one, which the next slide's numbers make concrete.");
}

/* --- ghz code --- */
{
  const s = S();
  addCodeSlide(s, "PERFORMANCE", "ghz: a load-test run, loose bounds by design", "text",
    [
      "$ docker compose run --rm ghz --insecure \\",
      "    --proto /contracts/shipping/routing/v1/routing.proto --import-paths /contracts \\",
      "    --call shipping.routing.v1.RoutingService.GetQuote \\",
      "    -d '{\"origin\":{\"unLocode\":\"USNYC\"},\"destination\":{\"unLocode\":\"NLRTM\"},",
      "         \"cargo\":[{\"weightKg\":1200.5}]}' \\",
      "    -c 10 -n 300 -O json quarkus:9000",
      "",
      "# A real run on this book's dev box:",
      "quarkus ghz: errors=0 rps=910.32 p99=0.0194s",
      "",
      "# Bounds are loose because CI runners are shared and noisy;",
      "# the point is PROOF OF NO DEGRADATION under load, not a performance claim.",
    ],
    "ghz has no server-reflection support: it needs the .proto file directly, not just an address, since there's no stub to generate a call from.");
  addNotes(s, "ghz is a dedicated gRPC load-testing tool, ten concurrent workers firing three hundred total GetQuote calls in this run, and the real captured result is zero errors, about 910 requests per second, and a 99th-percentile latency under 20 milliseconds, against the unary anchor method this whole book keeps returning to. One detail worth knowing if you reach for ghz yourself: unlike grpcurl, it has no server-reflection support, so it needs the actual .proto file mounted in, not just a host and port: there's no stub for it to generate a call from otherwise. And notice what the bounds in a real CI gate check for: not a specific throughput number, which would be a flaky assertion on shared, noisy CI infrastructure, but that error count stays at zero and latency stays within a generous envelope: proof that a server under concurrent load behaves the same as it does under one-request-at-a-time testing, not a performance benchmark to brag about. That distinction, correctness under load, not a number to chase, is what makes a load test belong in a CI gate at all.");
}

/* ======================= DIVIDER 09 ======================= */
divider("09", "Security: TLS, mTLS & authorization",
  "One-way TLS verifies the server; mutual TLS adds the other direction; a JWT in metadata carries identity end to end, with per-method scopes.",
  "Transport security and application-level authorization answer different questions. TLS and mTLS are about the connection: is this the server I think it is, and, with mTLS, is this a client the server actually trusts. A JWT carried in gRPC metadata is about the request: who is making this specific call, and what are they allowed to do. Production systems commonly use both together, each covering a hop the other doesn't.");

/* --- mTLS diagram --- */
{
  const s = S();
  addDiagramSlide(s, "TLS / MTLS", "mTLS adds the second direction of trust",
    "19-mtls-mutual-verification",
    "One-way TLS: the server never asks who is calling. mTLS: the server verifies the client's certificate too, and a client without one is turned away at the handshake.",
    { x: 1.30, y: 1.70, w: 10.73, h: 4.55 });
  addNotes(s, "Ordinary, one-way TLS is what most of the public web runs on: the client verifies the server's certificate against a CA it already trusts, and the server never asks who's calling: any client holding the right CA succeeds. Mutual TLS adds the missing direction: the server is configured to require a client certificate, verifies it against the same CA, and a client presenting no certificate, or the wrong one, is rejected at the TLS handshake itself, before a single byte of application logic runs. For an internal service that should only ever be called by other known services in the same system, mTLS is the cheapest form of service identity available: cheaper than a bearer token, because there's no credential sitting in a log line to steal, only a private key that never has to leave the calling service's own filesystem. The decision rule is correspondingly simple: require mutual TLS for internal, service-to-service traffic; reserve one-way TLS for a public-facing endpoint whose callers can't reasonably be expected to hold a client certificate at all.");
}

/* --- auth interceptor pipeline diagram --- */
{
  const s = S();
  addDiagramSlide(s, "AUTHORIZATION", "Authentication gates authorization, never the reverse",
    "20-auth-interceptor-pipeline",
    "Signature and expiry are checked before scope: a forged or expired token never reaches the per-method authorization check at all.",
    { x: 1.30, y: 1.70, w: 10.73, h: 4.55 });
  addNotes(s, "A bearer JWT rides in gRPC metadata as an ordinary 'authorization' entry on the HEADERS frame, ahead of the DATA frame carrying the actual request, and compressed by HPACK like any other header. The interceptor pipeline that reads it runs two checks, strictly in order. First, authentication: does a token exist, is its signature valid, has it not expired: a failure here is UNAUTHENTICATED, meaning 'I don't know who you are.' Only once that passes does authorization run: does the identity that token names have the scope this specific method requires: a failure here is PERMISSION_DENIED, meaning 'I know who you are, and you're not allowed to do this.' Those are two different claims a debugging engineer needs to tell apart, which is exactly why they're two different codes rather than one undifferentiated 'auth failed' bucket. And the ordering is deliberate: a forged or expired token never gets far enough to be asked what scope it's allowed: authentication gates authorization, never the other way around. The same per-method scope lookup means one authenticated token can produce different outcomes on different methods in the same call session: allowed on GetQuote, denied on an admin-gated method, because the requirement is attached to the method, not to the connection.");
}

/* ======================= DIVIDER 10 ======================= */
divider("10", "Observability, mesh & load balancing",
  "One trace crossing a REST-to-gRPC seam, and the L4 load-balancing problem a plain Kubernetes Service has, with two real fixes.",
  "Two production realities. First, distributed tracing: a single request crossing a REST front door and two gRPC hops should produce one trace, not three disconnected logs, and W3C trace context travels in gRPC metadata the same way a JWT does. Second, load balancing: a gRPC channel over a plain Kubernetes Service pins its entire lifetime to one pod, the pinned-pod baseline, and this section measures that problem, then measures the headless-Service-plus-round-robin fix against it.");

/* --- otel trace seam diagram --- */
{
  const s = S();
  addDiagramSlide(s, "TRACING", "One REST request, one trace, three nested spans",
    "21-otel-trace-seam",
    "POST /booking/quote, RoutingService.GetQuote, and QuoteService.GetQuote all share the same trace id: a REST root span with two gRPC child spans nested beneath it.",
    { x: 1.30, y: 1.70, w: 10.73, h: 4.55 });
  addNotes(s, "A single REST request fans out into a three-hop chain, the REST front door, RoutingService.GetQuote, and the downstream QuoteService.GetQuote it calls, and all three produce spans sharing one trace id, drawn here as a waterfall: a wide root span at the top, a narrower gRPC child span beneath it, and a still-narrower grandchild span beneath that. The trace context that makes this possible, a W3C traceparent header, encoding the trace id, the parent span id, and sampling flags, rides across the REST-to-gRPC seam and the gRPC-to-gRPC seam as ordinary metadata, extracted and re-emitted automatically by each framework's own OpenTelemetry instrumentation, with zero manual propagation code in the handler. That's the same mechanism a JWT uses to cross a boundary, metadata, carrying a completely different kind of payload. The operational payoff: an engineer debugging a slow or failed booking quote doesn't stitch together three separate services' logs by timestamp and guesswork; they follow one trace id through every hop it touched.");
}

/* --- LB problem diagram (the pinned-pod baseline) --- */
{
  const s = S();
  addDiagramSlide(s, "LOAD BALANCING", "The pinned-pod baseline",
    "22-grpc-lb-problem",
    "A plain ClusterIP Service, three replicas, one long-lived gRPC channel: every call lands on whichever single pod kube-proxy picked when the connection first opened.",
    { x: 1.30, y: 1.70, w: 10.73, h: 4.55 });
  addNotes(s, "This is the load-balancing problem gRPC's own long-lived, reused connection creates. A plain Kubernetes ClusterIP Service balances TCP connections, not individual RPCs: kube-proxy picks one pod when the gRPC channel's one connection is first established, and every call on that channel, for the channel's entire lifetime, goes to that same pod. Measured directly against a three-replica deployment: the pinned-pod baseline sends all 30 calls to Pod A, and Pods B and C never see a single one, the opposite of the even distribution a stateless, connect-per-request HTTP/1.1 client would get automatically. The dangerous part is that nothing about this looks broken from the client's side: every call succeeds, every response is correct, and the skew is only visible if you specifically measure traffic per pod. The next slide fixes exactly this.");
}

/* --- LB fix diagram (headless + round-robin) --- */
{
  const s = S();
  addDiagramSlide(s, "LOAD BALANCING", "The headless + round-robin fix",
    "22-lb-fixes-headless-and-mesh",
    "A headless Service plus client-side round_robin opens three subchannels instead of one; a service mesh sidecar gets the same result with the client's code unchanged.",
    { x: 1.30, y: 1.70, w: 10.73, h: 4.55 });
  addNotes(s, "The fix measured here changes nothing about the client's code path and everything about what DNS tells it: a headless Service (clusterIP: None) returns one DNS A record per ready pod instead of one virtual IP standing in for all of them, and a channel built with a dns:/// target plus the round_robin load-balancing policy opens one persistent subchannel to each address, cycling through all three. The same 30-call loop against this target produces a clean, measured 10/10/10 split across the three pods. The trade-off: this fix is entirely the client's responsibility: every caller, in every language, has to independently remember to ask for a headless name and set round_robin. The second panel shows the alternative: a service mesh sidecar moves the same per-request load-balancing decision onto infrastructure the client's code never has to know exists, at the cost of running and operating a mesh.");
}

/* --- LB measured numbers callout --- */
{
  const s = S();
  addContentTitle(s, "LOAD BALANCING", "The measured numbers, not just the theory");
  addTwoColBullets(s,
    [
      { text: "Pinned-pod baseline (plain ClusterIP)", options: { bold: true, bullet: false } },
      "One channel, one connection, one pod picked at connect time.",
      "30 calls -> Pod A: 30, Pod B: 0, Pod C: 0.",
      "Correct per-call behavior, hidden traffic skew.",
    ],
    [
      { text: "Headless Service + client round_robin", options: { bold: true, bullet: false } },
      "Same channel code; DNS returns 3 A records instead of 1 virtual IP.",
      "30 calls -> Pod A: 10, Pod B: 10, Pod C: 10.",
      "A service mesh sidecar gets the same result without any client change.",
    ],
    { fontSize: 15 });
  addCaption(s, "Reach for the client-side fix when every caller is code you control; reach for a mesh when callers are heterogeneous or not all under one team.");
  addNotes(s, "These numbers are real, measured output, not an illustration: the same 30-call test loop, the same three-pod deployment, run twice. The pinned-pod baseline is the default, unremarkable-looking behavior of a standard Kubernetes Service in front of a gRPC server: every call succeeds, every response is correct, and yet two of your three replicas sit completely idle for the life of that connection, a failure mode that's invisible unless you specifically measure per-pod traffic, because nothing about it looks broken from the client's side. The headless-Service fix produces a clean 10/10/10 split with zero server-side changes: only the Service type and one client-side channel option. The decision this section leaves you with: reach for the client-side fix when every caller is code your own team controls and can audit, because it costs nothing to run and nothing to operate; reach for a service mesh the moment callers are heterogeneous, numerous, or not all under one team's control, because the fix then becomes infrastructure configuration instead of a convention every caller independently has to remember, and it arrives bundled with mTLS and retry policy that would otherwise need reimplementing per language.");
}

/* ======================= DIVIDER 11 ======================= */
divider("11", "Browsers, transcoding & cross-protocol",
  "A browser can't dial native gRPC: grpc-web and JSON transcoding are the two real doors in, and HTTP/3 is a transport question, not a gRPC-API question yet.",
  "Native gRPC needs HTTP/2 trailers and a raw stream a browser's fetch and XHR APIs cannot produce. This section covers the seam that lets a browser or a plain JSON client reach the identical RPC a native client calls, and closes with where HTTP/3 actually stands relative to gRPC today: a transport that exists, not yet a gRPC binding either reference stack ships.");

/* --- grpc-web transcoding seam diagram --- */
{
  const s = S();
  addDiagramSlide(s, "CROSS-PROTOCOL", "Three doors, one RPC",
    "23-grpc-web-transcoding-seam",
    "A browser's grpc-web client, a plain JSON/HTTP client, and a hand-written REST shim all reach the identical RoutingService.GetQuote, native gRPC, on port 9000.",
    { x: 1.30, y: 1.70, w: 10.73, h: 4.55 });
  addNotes(s, "A browser's fetch and XHR APIs cannot open a raw HTTP/2 stream or read HTTP/2 trailers, which means a browser cannot dial native gRPC directly: not a missing library, but a platform limitation. Envoy sits in front and solves it two different ways depending on the caller. A grpc_json_transcoder filter lets any ordinary JSON-over-HTTP client, a script, another backend, an internal tool, call the proto's own native shape directly, with zero hand-written mapping code per RPC. A grpc_web filter is specifically for a browser: it repackages gRPC's HEADERS-DATA-trailing-HEADERS framing into a single ordinary HTTP/1.1 response body a browser's fetch call can actually read. And a hand-written REST shim remains a legitimate third door, for an endpoint that needs its own purpose-built request and response shape, a booking form, a dashboard widget, that doesn't map cleanly onto any one RPC's native fields. All three converge on the identical RoutingService.GetQuote, native gRPC, unmodified: the transcoding layer adapts the protocol, never the business logic underneath it.");
}

/* --- protocol decision matrix diagram --- */
{
  const s = S();
  addDiagramSlide(s, "CROSS-PROTOCOL", "The same five questions, asked of three transports",
    "24-protocol-decision-matrix",
    "gRPC/HTTP2, REST/HTTP2, and WebSockets compared on contract, direction, browser reach, backpressure, and tooling: the same decision lens, applied to transport choice.",
    { x: 1.30, y: 1.70, w: 10.73, h: 4.55 });
  addNotes(s, "Choose gRPC when both ends of a call are services your own team controls, the interaction needs a typed, CI-enforced contract, and any of the four RPC shapes, especially bidirectional streaming, fits the problem; the up-front cost is browser reach, which the grpc-web and transcoding patterns we just covered close the moment a browser client shows up. Choose REST over HTTP/2, Server-Sent Events or chunked transfer, when the consumer is a browser or a loosely-coupled external caller, the data only needs to flow one direction, and the integration cost of a generated stub outweighs the benefit of one. Choose WebSockets when you need full-duplex exchange with a browser specifically and the message shapes are too fluid, or too close to the UI's own event model, to justify a generated contract at all. And don't choose a transport based on an HTTP/3 timeline: HTTP/2 is the gRPC transport everywhere today, on every major implementation, and that stays true until a reference gRPC library ships a native QUIC transport binding: worth revisiting the day that lands, not a reason to wait today.");
}

/* ======================= DIVIDER 12 ======================= */
divider("12", "Testing, debugging & the Final Project",
  "The test pyramid, the four failure modes a gRPC call can take, and the Final Project running every mechanism in this deck at once.",
  "Every claim this book makes is proven, not asserted: a test pyramid from in-process unit tests up through a load-test gate, and a short, memorizable list of the shapes a gRPC failure actually takes. The Final Project closes the loop: one system running all four RPC shapes, mTLS, JWT authorization, and distributed tracing simultaneously, with the Decision Framework from the opening section run against the whole thing.");

/* --- test pyramid diagram --- */
{
  const s = S();
  addDiagramSlide(s, "TESTING", "The gRPC test pyramid",
    "25-grpc-test-pyramid",
    "In-process unit tests, verify.sh integration assertions, and a pinned ghz load test are all CI-gated; GUI exploration (grpcui, Insomnia, Yaak) sits on top, illustrative only.",
    { x: 1.30, y: 1.70, w: 10.73, h: 4.55 });
  addNotes(s, "Put the cheapest, fastest layer of the pyramid in the build gate, not the slowest. At the base, an in-process test, no network, no container, no external process, runs in milliseconds, which is exactly why it belongs where a red result has to block an artifact from being produced; a build-stage gate that took minutes per run would get skipped under deadline pressure, and a gate that gets skipped stops being a gate. Above that, integration assertions against a real running container over a real socket, grpcurl-driven, in this book's verify.sh convention, prove things only a real network call can prove: that reflection is actually reachable, that TLS actually negotiates, that a port is actually bound. A load test sits above that, proving the server doesn't silently degrade under concurrency, not making a performance claim. At the very top, GUI exploration tools, grpcui, Insomnia, Yaak, are explicitly illustrative only, for a human understanding an unfamiliar service's shape; they're not part of the asserted, repeatable gate, because a human clicking through a UI isn't a check anyone can rerun identically in CI.");
}

/* --- debug failure modes diagram --- */
{
  const s = S();
  addDiagramSlide(s, "DEBUGGING", "Four failure modes, and how to tell them apart from the client side",
    "26-debug-failure-modes",
    "UNIMPLEMENTED, DEADLINE_EXCEEDED, UNAVAILABLE, and a TLS handshake failure each have a distinct symptom, cause, and fix.",
    { x: 1.30, y: 1.70, w: 10.73, h: 4.55 });
  addNotes(s, "Start every unexplained gRPC failure with reflection: a describe call against the target costs one command and tells you whether the method you're calling exists at all, ruling out UNIMPLEMENTED in one step. From there, the diagnostic branches on one question: did the error text contain a status Code line at all? If it did, the server ran, and the failure is application-level: treat DEADLINE_EXCEEDED as a budget-versus-work problem first, comparing what the deadline actually said against how long the call actually took, before suspecting application logic. If there's no Code line, nothing reached the server: UNAVAILABLE from a cold or closed channel, or a TLS handshake failure with no status code at all, which shows up as a dial-level error like 'Failed to dial target host' rather than a clean gRPC status. That second case is usually the simplest fix in this whole table and the easiest to misdiagnose: a TLS client talking to a plaintext server, or the reverse, check the obvious transport mismatch (plaintext vs. TLS, wrong port) before reaching for certificates or firewalls.");
}

/* --- final project architecture diagram --- */
{
  const s = S();
  addDiagramSlide(s, "FINAL PROJECT", "Every mechanism in this deck, running at once",
    "27-final-project-architecture",
    "All four RPC shapes, mTLS + JWT at every hop, one OpenTelemetry trace crossing the REST-to-gRPC seam, buf and ghz framing the CI gate.",
    { x: 1.30, y: 1.70, w: 10.73, h: 4.55 });
  addNotes(s, "Every prior section in this deck picked one mechanism and held everything else constant. The Final Project is where that discipline pays off: one system running RoutingService.GetQuote (unary) and NegotiateRoute (bidirectional), QuoteService.GetQuote as the downstream hop, and TrackingService's WatchShipment (server-streaming) and ReportPositions (client-streaming): all four RPC shapes from the decision framework, in one process, on both stacks. Every hop presents an mTLS client certificate and a bearer JWT with per-method scopes, including the internal, loopback hop from RoutingService into QuoteService, which gets no exemption from the checks an external caller faces. OpenTelemetry threads one trace id through the REST front door and both gRPC hops. And none of this is new proto: every method here was declared in the contract from the earliest chapter that introduced its service, with buf breaking proving the contract stayed frozen, and a pinned ghz load test proving the mTLS-and-JWT-protected server doesn't silently degrade under concurrent load. Nothing here is a new mechanism: every mechanism in this deck, proven to compose.");
}

/* --- final project on the wire code --- */
{
  const s = S();
  addCodeSlide(s, "FINAL PROJECT", "On the wire: three failure layers, then success", "grpcurl",
    [
      "$ grpcurl -plaintext localhost:9270 list",
      "Failed to dial target host \"localhost:9270\": tls: first record does not",
      "    look like a TLS handshake                     # plaintext vs. mTLS: fails at the HANDSHAKE",
      "",
      "$ grpcurl -cacert ca.crt -cert client.crt -key client.key -servername quarkus \\",
      "    -d '{...}' localhost:9270 shipping.routing.v1.RoutingService/GetQuote",
      "ERROR:  Code: Unauthenticated   # mTLS passed; no bearer token -> UNAUTHENTICATED",
      "  Message: missing 'authorization: Bearer <jwt>' metadata",
      "",
      "$ curl -s -X POST localhost:8270/booking/quote -d '{\"origin\":\"USNYC\",...}'",
      "{\"traceId\":\"7a1f9c3e...\",\"quote\":{\"currency\":\"USD\",\"amount\":\"2500.00\"},",
      " \"route\":{\"id\":\"rte_USNYC-NLRTM\",\"legs\":[{\"carrier\":\"MAERSK\"}]}}",
    ],
    "A transport rejection, an authentication rejection, and success are three different outcomes, encountered in exactly that order: verify.sh asserts all three.",
    { fontSize: 10.5 });
  addNotes(s, "Three real, captured outcomes against the same server, in the order a real call actually encounters them. A plaintext call against an mTLS-required port never produces a gRPC status at all: the TLS handshake itself fails, which is why the error text is a transport-level dial failure, not a Code line. A properly mTLS-authenticated call with no bearer token clears the handshake but fails the next layer: UNAUTHENTICATED, with a message naming exactly what's missing. And the full flow, mTLS and a valid token both present, arriving through the REST front door this time, succeeds, returning a trace id a client can hand to an engineer, plus the identical quote and route shape this deck has used as its anchor example from the very first section. Three failure classes, three distinct checks, stacked in the order a real call actually encounters them, never collapsed into one undifferentiated 'rejected' bucket, which is the same discipline the rich-error-model section argued for, now proven end to end against a real mTLS-and-JWT-protected server.");
}

/* --- decision recap bullets --- */
{
  const s = S();
  addContentTitle(s, "FINAL PROJECT", "The five axes, run against the whole system");
  addBullets(s, [
    "RPC shape: each method keeps the shape its own interaction demands: unary, bidirectional, server- and client-streaming all appear, none forced into unary.",
    "Sync vs. stream: the REST front door stays single request/response; the two tracking RPCs stay streams, because neither a location history nor a batch upload is naturally one message.",
    "Deadline & budget: the unary chain inherits its deadline-propagation shape unchanged, but a long-lived bidirectional stream needs its own idle-timeout policy, a real gap this build names rather than hides.",
    "Failure class: a transport rejection, UNAUTHENTICATED, and PERMISSION_DENIED are three independently-asserted outcomes, in the order a real call meets them, never one \"auth failed\" bucket.",
    "Concurrency model: every handler is non-blocking end to end, because a system layering mTLS, JWT, and tracing onto every call cannot afford even one of them to block a thread the runtime needed elsewhere.",
  ], { fontSize: 15 });
  addNotes(s, "This is the same five-axis framework from the very first section of this deck, run one more time, against a complete system instead of a single worked example. RPC shape: nothing here is forced into unary the way a REST-only instinct would default to; each method keeps the shape its own communication pattern actually demands. Sync versus stream: the REST front door is a single synchronous request/response because a caller asking for one quote wants one answer, not a feed; the streaming RPCs stay streams for the mirror-image reason. Deadline and budget is where this system exposes a real limitation: the unary deadline-propagation chain from the reliability section carries over unchanged, but a long-lived bidirectional negotiation needs its own idle-timeout and overall-duration policy that this particular build does not set, a limitation this book names rather than quietly leaving implicit, because a slide that only shows what works teaches half the lesson. Failure class stays three distinct, ordered checks, never one bucket. And concurrency model closes the loop: every handler stays non-blocking end to end, because layering three cross-cutting concerns onto every single call cannot afford even one of them to pin a thread the runtime needed for other work. Read every Decision box in this deck in sequence, and you've reconstructed the book's entire argument without re-reading the prose that built it.");
}

/* ======================= APPENDIX ======================= */
{
  const s = pres.addSlide();
  pageNum += 1;
  addSectionDivider(s, "A", "Appendix",
    "Secondary figures, reference tables, overflow listings, and a glossary, kept open in another window.");
  addNotes(s, "Everything from here on is reference material: figures that support the body sections but didn't need their own moment on stage, a full canonical status-code table, a longer proto listing, and a glossary of terms used throughout. Keep this open in a second window rather than reading it start to finish.");
}

// ---- Appendix: secondary figures, one per slide, grouped by body section ----
const APPENDIX_FIGURES = [
  // Section 1 — Why gRPC
  { eyebrow: "APPX · WHY GRPC", file: "01-stub-to-stub-path",
    title: "One .proto, a client stub, a server skeleton",
    caption: "One .proto compiles into a client stub and a server skeleton; every call travels typed call in, protobuf on the wire, typed call out: no textual form to curl.",
    notes: "There is no textual form of a gRPC request: curl -X POST routing:9000/GetQuote never works, because there's no request line to type. Only a compiled stub, producing compiled bytes, on both ends." },

  // Section 2 — Protobuf
  { eyebrow: "APPX · PROTOBUF", file: "03-field-shapes",
    title: "repeated, map, and oneof: three composite shapes",
    caption: "repeated keeps order; map sugars repeated {key,value} pairs with none; oneof clears every other member the instant one is set: a generated-code guarantee, not a convention.",
    notes: "Three ways a message can hold more than one value, each with a different contract. repeated preserves order as part of the contract. map makes no ordering promise at all when you walk its entries. oneof's exclusivity is enforced by generated code: setting one member clears every other, automatically." },
  { eyebrow: "APPX · PROTOBUF", file: "04-wellknown-catalog",
    title: "The well-known types, by the problem each solves",
    caption: "Timestamp, Duration, FieldMask, Any, Struct, and wrapper types, each paired with the real contract field that uses it (or doesn't).",
    notes: "google.protobuf gives you six well-known types for the shapes a bare scalar handles badly: an instant, a span, a set of field paths, a dynamically-typed envelope, untyped JSON, and present-vs-absent. The shipping contract uses four of the six; Struct and wrapper types are shown as non-examples." },

  // Section 3 — Buf
  { eyebrow: "APPX · BUF", file: "05-buf-three-gates",
    title: "Three gates, in sequence, before either stack generates code",
    caption: "buf lint enforces STANDARD naming and style; buf build confirms every import resolves; buf breaking diffs against main. A change failing any gate never reaches stub generation.",
    notes: "The three Buf commands run in this order because each is cheaper than the next: lint is nearly instant, build catches structural errors, and breaking is the expensive, meaningful diff against history." },

  // Section 4 — HTTP/2
  { eyebrow: "APPX · HTTP/2", file: "06-nested-message-bytes",
    title: "Nesting costs one key + length prefix per level",
    caption: "A GetQuoteResponse embedding a Money message costs exactly one extra key byte and one length byte beyond Money's own bytes: a parser never tracks nesting depth.",
    notes: "Every key only ever encodes the current message's own field number and wire type, regardless of how deep that message is nested, which is why a protobuf parser needs no explicit depth-tracking state machine." },

  // Section 5 — Four RPC shapes
  { eyebrow: "APPX · RPC SHAPES", file: "07-channel-decides-call-style",
    title: "Blocking vs. async: a type-level split on one stack, a channel-level split on the other",
    caption: "Quarkus generates three distinct stub types from one proto (blocking, Mutiny, service interface); Python's one generated stub serves both styles, decided by which kind of channel it's built over.",
    notes: "This figure is a preview of the implementation decks, not a code requirement here: the concept that matters at this level is that call style (blocking vs. non-blocking) is a separate decision from which RPC shape you chose, and each stack resolves that decision differently." },
  { eyebrow: "APPX · RPC SHAPES", file: "08-polling-vs-streaming",
    title: "Polling wastes calls and adds staleness",
    caption: "A client polling GetShipmentStatus on a timer wastes three of four round trips and still lags up to one interval behind; one WatchShipment stream pushes each event the instant it posts.",
    notes: "The alternative to server-streaming, drawn out explicitly: polling trades implementation simplicity for wasted calls and staleness, and the gap widens the longer the watched process runs." },
  { eyebrow: "APPX · RPC SHAPES", file: "09-client-bidi-streaming",
    title: "Client-streaming folds many requests into one response; bidi runs two independent directions",
    caption: "ReportPositions folds three requests into one ReportPositionsResponse; Sync (bidirectional) interleaves independently-paced requests and responses on one connection.",
    notes: "The two streaming shapes that aren't server-streaming, side by side: one collapses a sequence into a single acknowledgment, the other keeps both directions independent and ongoing." },
  { eyebrow: "APPX · RPC SHAPES", file: "09-half-close-sequence",
    title: "Half-close ends the client's writes, not the stream",
    caption: "The client's last DATA frame carries END_STREAM, closing only its write side; the server reads to completion, then closes its own half with the response.",
    notes: "There's no separate 'done sending' message in gRPC: only a flag on the last frame. The server keeps reading buffered frames after that flag arrives; the stream itself stays open until the server closes its own half too." },

  // Section 6 — Reliability
  { eyebrow: "APPX · RELIABILITY", file: "10-cancellation-propagation",
    title: "A cancelled call either tears down work immediately, or lets it run for no one",
    caption: "A cancellable pipeline (Mutiny Uni / asyncio Task) tears down in-flight work the instant a deadline expires; a thread blocked on a raw sleep has no hook to interrupt and runs to completion wastefully.",
    notes: "The concurrency-model axis made concrete: only a cancellable representation of in-flight work lets a downstream deadline's expiry actually stop that work, instead of merely stopping the caller from waiting on it." },
  { eyebrow: "APPX · RELIABILITY", file: "11-status-code-taxonomy",
    title: "The canonical codes, grouped by meaning, not the alphabet",
    caption: "Malformed request, state of the world, transient, overload, auth, and INTERNAL as the last resort: six groups, each implying a different client action.",
    notes: "This is the source grouping behind the retryable-vs-not table shown in the main body; the full taxonomy adds FAILED_PRECONDITION and the auth codes as their own explicit rows." },
  { eyebrow: "APPX · RELIABILITY", file: "12-interceptor-chain",
    title: "The server-side interceptor chain, and its short-circuit path",
    caption: "Logging/timing and an auth hook wrap every call in order; the response passes back through in reverse; a rejected call short-circuits straight back to the client without ever reaching the handler.",
    notes: "The symmetry test for what belongs in an interceptor versus a handler: if the same code, unmodified, is correct in front of every method a service exposes, it belongs in the chain. The moment it needs an if-branch keyed on which method is running, that branch belongs back in the handler." },
  { eyebrow: "APPX · RELIABILITY", file: "12-metadata-headers-trailers",
    title: "Headers travel before the first message; trailers only at close",
    caption: "A header carries what the caller already knew; a trailer carries what the callee only learned by the end, status, counts, timing, sent at close(status, trailers).",
    notes: "Metadata is the one map an interceptor reads on the way in (headers) and writes on the way out (trailers): the same mechanism a JWT and a trace context both ride on, just populated with different keys." },

  // Section 7 — Schema design & evolution
  { eyebrow: "APPX · SCHEMA DESIGN", file: "13-message-granularity",
    title: "Nest when identity depends on the parent; reference by id when it doesn't",
    caption: "A Leg embedded in a Route has no identity outside it; a carrier_id references a Carrier with its own list, its own lifecycle, fetched via a separate service.",
    notes: "The granularity decision that precedes every pagination and projection choice: does this value have meaning, and callers, of its own? If yes, reference it by id instead of embedding it." },
  { eyebrow: "APPX · SCHEMA DESIGN", file: "13-pagination-page-tokens",
    title: "An opaque, server-defined page token chains calls safely",
    caption: "Call 1 returns a next_page_token; Call 2 carries it forward. An empty next_page_token is the only exhaustion signal: no count, no boolean.",
    notes: "Reach for a token over a client-supplied offset whenever the underlying collection can change between calls: any collection backed by a live datastore. An offset silently skips or repeats rows the moment a row is inserted or removed mid-page." },
  { eyebrow: "APPX · SCHEMA DESIGN", file: "13-fieldmask-projection",
    title: "FieldMask projects a response down to only what was asked for",
    caption: "field_mask.paths=['id','price'] narrows a full Route down to just those two fields; an unset mask means everything: projection is opt-in narrowing only.",
    notes: "One schema can serve a summary view and a detail view of the same data without two separate RPCs, at the cost of the client needing to know which paths exist, which the library rejects loudly, not silently, if it doesn't." },
  { eyebrow: "APPX · SCHEMA DESIGN", file: "14-buf-breaking-gate",
    title: "The buf breaking gate, as verify.sh actually runs it",
    caption: "Safe compared against baseline exits 0; breaking, reserved or not, exits 100, naming the exact violation by field.",
    notes: "This is the structural shape behind the real captured buf breaking output shown in the main body: every candidate in the book's own seeded-failure proof against one baseline." },
  { eyebrow: "APPX · SCHEMA DESIGN", file: "14-package-versioning-v2",
    title: "v1 and v2 coexist on disk and at runtime",
    caption: "A second implementation serves v2 clients while the first keeps serving v1 clients, unmodified, invisible to buf breaking by construction, since the tool only compares matching file paths.",
    notes: "The package-version escape hatch, drawn as a running system: both versions coexist during a rolling deploy, each served by its own implementation, generated from its own file." },

  // Section 8 — Streaming at scale & performance
  { eyebrow: "APPX · STREAMING AT SCALE", file: "17-slow-consumer-backpressure",
    title: "Demand-driven production spreads timestamps; eager pre-materialization clusters them",
    caption: "A demand-paced Multi/async generator produces events only when pulled; an eager, pre-built list stamps everything at the instant the call started, wasting work a short-lived call never needed.",
    notes: "The producer-side lever that decides how much pressure ever reaches the HTTP/2 flow-control window: build events on demand for anything unbounded or expensive; pre-materializing stays fine only for Chapter 8's shape: short, fixed, cheap." },
  { eyebrow: "APPX · STREAMING AT SCALE", file: "17-keepalive-quiet-stream",
    title: "A keepalive PING survives a quiet gap a middlebox would otherwise reap",
    caption: "With server keepalive, a PING/ACK cycle holds the connection open across a quiet gap; without it, an idle middlebox can reap the connection before the next real event arrives.",
    notes: "Configure keepalive on every stream a caller might hold open longer than the shortest idle timeout anywhere in its network path, a number that's rarely visible to either endpoint, which is exactly why you set it explicitly rather than hoping." },
  { eyebrow: "APPX · STREAMING AT SCALE", file: "18-channel-reuse-before-after",
    title: "Channel-per-call pays a handshake every time; one reused channel pays it once",
    caption: "3 calls -> 3 handshakes on the left; N calls -> 1 handshake, multiplexed, on the right.",
    notes: "The one lever with no trade-off at all: there is no workload shape where opening a fresh channel per call beats building one and reusing it for the life of the process." },
  { eyebrow: "APPX · STREAMING AT SCALE", file: "18-compression-size-tradeoff",
    title: "Gzip wins decisively on a large payload, barely breaks even on a tiny one",
    caption: "A 5MB, highly repetitive ListRoutes payload compresses dramatically; a 40-byte GetQuote payload sees overhead roughly equal to the savings: CPU spent for nothing.",
    notes: "Gate compression per call rather than forcing it server-wide where a service's calls split cleanly between large/repetitive and small/scalar payload shapes." },

  // Section 9 — Security
  { eyebrow: "APPX · SECURITY", file: "19-tls-handshake-cert-chain",
    title: "One-way TLS: the client verifies the server; the server never asks back",
    caption: "ClientHello, ServerHello plus the server certificate, the client verifies the chain against a trusted CA, then sends the encrypted call: the client never presents a certificate of its own.",
    notes: "The baseline handshake every mTLS story builds on by adding the missing, second direction of verification." },
  { eyebrow: "APPX · SECURITY", file: "19-where-credentials-attach",
    title: "certgen feeds both servers and the host-side client from one shared root",
    caption: "A one-shot certgen container writes ca/server/client certs into a named volume for the servers, and a bind mount for the host-side grpcurl process: one shared CA, one set of SANs.",
    notes: "In production, let a tool built for the job, cert-manager on Kubernetes, a service mesh's own identity system, own issuance and rotation, never a hand-rolled script on a schedule measured in years." },
  { eyebrow: "APPX · SECURITY", file: "20-jwt-in-metadata-flow",
    title: "authorization rides in HEADERS, ahead of the message body",
    caption: "The interceptor reads the authorization metadata entry before the DATA frame carrying the request even arrives: never waiting on the body to decide whether the call is allowed to proceed.",
    notes: "The interceptor's whole advantage: it can reject an unauthenticated call before the server has spent any effort deserializing or routing the request body." },
  { eyebrow: "APPX · SECURITY", file: "20-per-method-authz-matrix",
    title: "One token, three different outcomes, because scope is per method, not per connection",
    caption: "The same authenticated token is allowed on GetQuote, denied on an admin-gated method, and reaches UNIMPLEMENTED on methods with no scope requirement at all.",
    notes: "Authorization is decided per method call, never once per connection, which is why a single long-lived channel can legitimately carry both successful and PERMISSION_DENIED calls over its lifetime." },

  // Section 10 — Observability, mesh & LB
  { eyebrow: "APPX · OBSERVABILITY", file: "21-observability-surfaces",
    title: "Three independent observability surfaces on one process",
    caption: "Traces pushed to Tempo, metrics pulled by Prometheus, and health answered synchronously over grpc.health.v1.Health: three separate mechanisms, none aware of the others.",
    notes: "Use grpc.health.v1.Health for liveness and readiness specifically, rather than reinventing the same protocol as a REST endpoint gRPC-aware infrastructure already speaks natively." },
  { eyebrow: "APPX · OBSERVABILITY", file: "21-trace-context-in-metadata",
    title: "traceparent rides as an HPACK header, ahead of the message",
    caption: "The W3C traceparent header crosses the wire on the HEADERS frame; the server extracts it and starts a child span with the same trace id, a new span id.",
    notes: "The mechanical detail behind zero-code trace propagation: traceparent is just another piece of gRPC metadata, which is why framework auto-instrumentation can inject and extract it without any handler-level code." },
  { eyebrow: "APPX · LOAD BALANCING", file: "22-l4-vs-l7-balancing",
    title: "L4 decides once per connection; L7 decides once per request",
    caption: "An L4 load balancer commits to a backend when the connection opens; an L7 load balancer, a mesh sidecar, re-decides for every request multiplexed over that same connection.",
    notes: "This is the structural reason a plain Kubernetes Service mis-balances gRPC: it operates at L4, deciding once per TCP connection, while gRPC multiplexes many RPCs onto that one connection." },

  // Section 11 — Browsers, transcoding & cross-protocol
  { eyebrow: "APPX · CROSS-PROTOCOL", file: "23-grpc-web-framing",
    title: "grpc-web packs trailers into the response body a browser can read",
    caption: "Native gRPC/HTTP2 uses a trailing HEADERS frame for the final status; grpc-web/HTTP1.1 packs a DATA frame and a TRAILER frame into one ordinary response body instead.",
    notes: "The precise mechanical reason a browser can't just dial native gRPC: fetch and XHR cannot read HTTP/2 trailers, so grpc-web repackages the framing into something an ordinary HTTP/1.1 response body can carry." },
  { eyebrow: "APPX · CROSS-PROTOCOL", file: "23-three-ways-to-reach-grpc",
    title: "A hand-written shim, JSON transcoding, or grpc-web: three real trade-offs",
    caption: "What each door needs, its URL and content-type shape, and who it's really meant for.",
    notes: "Reach for grpc-web specifically when the caller is a browser and nothing else will do; it's strictly more machinery than JSON transcoding for the same proxy to run, and buys nothing extra for a caller that isn't constrained to fetch()/XHR." },
  { eyebrow: "APPX · CROSS-PROTOCOL", file: "24-http3-crossprotocol",
    title: "One lost TCP segment stalls every HTTP/2 stream sharing it; QUIC isolates the loss",
    caption: "HTTP/2 over TCP: one lost segment stalls all three multiplexed streams. HTTP/3 over QUIC: a lost packet retransmits alone, with no cross-stream head-of-line blocking.",
    notes: "This is a transport-layer property, not yet a gRPC-API property; see the next figure for exactly where gRPC-over-HTTP/3 actually stands." },
  { eyebrow: "APPX · CROSS-PROTOCOL", file: "24-h2-everywhere-h3-where-it-stands",
    title: "Where gRPC and HTTP/3 actually stand today",
    caption: "Native gRPC over HTTP/2: available, this book's hard-gated default. HTTP/3 as a transport (not gRPC): available, capability-gated. gRPC directly over HTTP/3: not yet, on either reference implementation.",
    notes: "Checked against upstream as of this book's writing, worth re-verifying before repeating this claim, since both reference gRPC implementations' HTTP/3 support is actively evolving." },

  // Section 12 — Testing, debugging & Final Project
  { eyebrow: "APPX · TESTING", file: "25-reflection-probe-landscape",
    title: "One reflection service, four very different clients",
    caption: "grpcurl's list/describe path is CI-gated; grpcui, Insomnia, and Yaak are illustrative-only GUIs built on the identical reflection service.",
    notes: "Only the CLI path is deterministic enough to assert in CI: a human clicking through a GUI explores the same reflection data but isn't a repeatable, scriptable check." },
  { eyebrow: "APPX · DEBUGGING", file: "26-diagnosis-toolbox",
    title: "Reflection, channelz, and GRPC_TRACE: what each reveals, and where",
    caption: "Reflection needs no proto file; channelz exposes live connection and call-count data; GRPC_TRACE/GRPC_VERBOSITY are library-side environment variables, not server-side.",
    notes: "Reach for channelz when you need live connection and call data from a running service without redeploying it with new logging; reach for GRPC_TRACE only as a last resort, since the exact output lines aren't a stable contract across releases." },
  { eyebrow: "APPX · FINAL PROJECT", file: "27-booking-route-track-flow",
    title: "The asserted end-to-end sequence, numbered hop by hop",
    caption: "The unary GetQuote path threads one trace id through three hops; NegotiateRoute, WatchShipment, and ReportPositions are independently asserted alongside it.",
    notes: "This is the literal sequence verify.sh checks: a REST request, two gRPC hops, one trace id logged identically at each, plus the streaming and bidirectional calls exercised directly over gRPC, bypassing the REST front door entirely." },
  { eyebrow: "APPX · FINAL PROJECT", file: "27-three-tier-deploy",
    title: "One contract, three deployment tiers",
    caption: "A CI-gated Compose stack, a run-by-hand minikube load-balancing fix, and a run-by-hand OpenShift Local mesh canary, each anchored by its own traced call.",
    notes: "Splitting a system into a CI-gated tier and run-by-hand tiers is not a compromise: it keeps a fast, deterministic contract gate separate from a slower, environment-dependent proof against a real cluster and a real mesh." },

  // Explicit appendix figures from the outline
  { eyebrow: "APPX · LAB", file: "00-lab-topology",
    title: "The lab: one proto, two servers, reflection instead of a stub",
    caption: "A grpcurl or grpcui client calls GetQuote through server reflection against both a Quarkus and a Python container, generated from the same proto, with an opt-in LGTM stack.",
    notes: "This is the Compose topology every chapter example in the book runs on: no host-installed JDK or Python interpreter assumed, and observability off by default." },
  { eyebrow: "APPX · DOMAIN", file: "00-shipping-domain-model",
    title: "The domain nouns every proto and diagram reuses",
    caption: "Booking, Route, Leg, Location, and Money: the entity-relationship shape behind every service in this book.",
    notes: "Location and Money are shared value types with no identity of their own, referenced by both Booking and Route: the same shared-types discipline the Protobuf section's types.proto excerpt showed in code." },
  { eyebrow: "APPX · OPENSHIFT", file: "A-crc-incluster-build",
    title: "An in-cluster build: Maven runs on the host, the image builds inside OpenShift",
    caption: "A binary S2I BuildConfig based on ubi10-openjdk-25 produces an ImageStream the Helm-managed Deployment pulls: no container engine on the host at all.",
    notes: "OpenShift Local's build path for this book's examples, with no Dockerfile and no local container engine: the image never exists outside the cluster." },
  { eyebrow: "APPX · OPENSHIFT", file: "A-crc-grpc-routes",
    title: "h2c, edge, and passthrough Routes: which hop actually carries HTTP/2",
    caption: "A live-cluster finding: an edge-terminated Route cannot carry a native gRPC client's TLS handshake at all; passthrough is the termination type that actually works.",
    notes: "OpenShift's router makes TLS-termination choices a gRPC service doesn't get to override, only configure, and the edge-Route failure here was confirmed on a live cluster, not assumed from documentation." },
  { eyebrow: "APPX · OPENSHIFT", file: "A-ossm-strict-mtls-canary",
    title: "STRICT mesh-wide mTLS, plus a weighted canary",
    caption: "A meshed client's sidecar negotiates STRICT mTLS automatically; an unmeshed, plaintext caller is refused outright. A VirtualService splits traffic 90/10 across a v1/v2 canary.",
    notes: "Reach for mesh mTLS over application-level mTLS when every legitimate caller can reasonably run inside the mesh: certificate issuance and rotation become the mesh's problem instead of a per-service script." },
];

for (const fig of APPENDIX_FIGURES) {
  const s = S();
  addDiagramSlide(s, fig.eyebrow, fig.title, fig.file, fig.caption, { x: 1.80, y: 1.75, w: 9.74, h: 4.65 });
  addNotes(s, fig.notes);
}

/* --- appendix: full status-code reference table --- */
{
  const s = S();
  addContentTitle(s, "APPX · REFERENCE", "The full canonical status-code reference");
  addStatusTable(s, [
    { code: "OK (0)", name: "success", purpose: "The call completed as requested." },
    { code: "CANCELLED (1)", name: "client cancelled", purpose: "The caller cancelled the call, typically via context cancellation." },
    { code: "INVALID_ARGUMENT (3)", name: "malformed request", purpose: "Never retry: the same request fails the same way again." },
    { code: "DEADLINE_EXCEEDED (4)", name: "ran out of time", purpose: "Retry only if idempotent and budget remains." },
    { code: "NOT_FOUND (5)", name: "state of the world", purpose: "Never retry: describes a fact, not a glitch." },
    { code: "ALREADY_EXISTS (6)", name: "state of the world", purpose: "Never retry unchanged." },
    { code: "PERMISSION_DENIED (7)", name: "authenticated, not entitled", purpose: "Retry only after the grant changes." },
    { code: "RESOURCE_EXHAUSTED (8)", name: "self-imposed overload", purpose: "Retry with backoff: the server is shedding load." },
    { code: "FAILED_PRECONDITION (9)", name: "state of the world", purpose: "Never retry unchanged: something has to change first." },
    { code: "UNAUTHENTICATED (16)", name: "no / bad credential", purpose: "Retry only after fixing the credential." },
    { code: "UNAVAILABLE (14)", name: "transient", purpose: "Retry with backoff: the condition is often transient." },
    { code: "INTERNAL (13)", name: "last resort", purpose: "Never the default: collapsing to it erases the client's one actionable signal." },
  ], { colW: [3.10, 2.80, 6.19], rowH: 0.355, y: 1.55, fontSize: 13 });
  addCaption(s, "Full canonical gRPC status vocabulary: the retryable-vs-not table in the main body groups a subset of these by meaning, not the alphabet.", 6.15);
  addNotes(s, "The complete list of canonical gRPC status codes this book's error-handling chapter relies on, for reference. The main body's retryable-vs-not table groups the ones that come up constantly in the shipping domain's own examples; this table is the fuller picture, including CANCELLED (the caller gave up, not the server) and ALREADY_EXISTS, which behaves like NOT_FOUND's mirror image, both describe a fact about the world rather than a glitch reaching it.");
}

/* --- appendix: overflow proto listing --- */
{
  const s = S();
  addCodeSlide(s, "APPX · REFERENCE", "RoutingService: the full contract, for reference", "proto3",
    [
      "// contracts/proto/shipping/routing/v1/routing.proto (excerpt)",
      "service RoutingService {",
      "  rpc GetQuote(GetQuoteRequest) returns (GetQuoteResponse);",
      "  rpc FindOptimalRoute(FindOptimalRouteRequest) returns (FindOptimalRouteResponse);",
      "  rpc ListRoutes(ListRoutesRequest) returns (ListRoutesResponse);",
      "  rpc NegotiateRoute(stream NegotiateRouteRequest) returns (stream NegotiateRouteResponse);",
      "  rpc RecomputeRoutes(RecomputeRoutesRequest) returns (RecomputeRoutesResponse);",
      "}",
      "",
      "// A server-owned long-running-operation lookup, kept on its OWN service —",
      "// adding these RPCs here would be wire-compatible but not source-compatible,",
      "// since generated service interfaces are fully abstract per service.",
      "service OperationsService {",
      "  rpc GetOperation(GetOperationRequest) returns (shipping.type.v1.Operation);",
      "  rpc WatchOperation(WatchOperationRequest) returns (stream shipping.type.v1.Operation);",
      "  rpc CancelOperation(CancelOperationRequest) returns (shipping.type.v1.Operation);",
      "}",
    ],
    "One service per bounded concern: RoutingService owns routing/pricing; a dedicated OperationsService owns long-running-job lookup, mirroring google.longrunning.Operations.",
    { fontSize: 11.5 });
  addNotes(s, "The real service surface behind every RPC-shape example in this deck, for reference. Notice RoutingService alone already declares all four shapes: GetQuote and FindOptimalRoute unary, ListRoutes unary-with-pagination, NegotiateRoute bidirectional, RecomputeRoutes an async method returning a pollable Operation rather than blocking. OperationsService is split onto its own service rather than bolted onto RoutingService, a design choice, not an accident: quarkus-grpc generates a fully abstract interface per service, so adding three more RPCs directly to RoutingService would force every existing implementor to grow overrides it has no reason to implement, just because one new concern arrived. Splitting it out keeps the change source-compatible for every consumer that doesn't care about long-running operations.");
}

/* --- appendix: glossary --- */
{
  const s = S();
  addContentTitle(s, "APPX · GLOSSARY", "Terms used throughout this deck");
  addTwoColBullets(s,
    [
      { text: "Unary / streaming", options: { bold: true, bullet: false } },
      "Unary: one request, one response.",
      "Server-streaming: one request, a sequence of responses.",
      "Client-streaming: a sequence of requests, one response.",
      "Bidirectional: both directions stream independently.",
      { text: "Channel", options: { bold: true, bullet: false } },
      "A reusable HTTP/2 connection a stub calls methods through; built once per process, never per call.",
      { text: "Deadline", options: { bold: true, bullet: false } },
      "A per-call time budget the caller states up front; propagated and re-carved at every hop in a chain.",
    ],
    [
      { text: "Reflection", options: { bold: true, bullet: false } },
      "A well-known service a server exposes describing its own services and messages, so a CLI needs no local .proto copy.",
      { text: "Interceptor", options: { bold: true, bullet: false } },
      "A cross-cutting wrapper around every call on a service, logging, auth, tracing, applied uniformly, never keyed on which method is running.",
      { text: "google.rpc.Status", options: { bold: true, bullet: false } },
      "A canonical code plus typed detail messages (ErrorInfo, BadRequest, RetryInfo), riding in the gRPC trailers.",
      { text: "buf breaking", options: { bold: true, bullet: false } },
      "A gate that diffs a candidate proto against a baseline and rejects a reused, retyped, or removed field.",
    ],
    { fontSize: 13.5 });
  addNotes(s, "A quick-reference glossary for the vocabulary this deck leans on repeatedly. The RPC-shape terms and the channel/deadline/reflection/interceptor terms recur in almost every section; google.rpc.Status and buf breaking are the two mechanisms the reliability and evolution sections build their entire argument on. Keep this page open if a term from an earlier section comes up again later without being re-defined.");
}

/* ======================= CLOSING ======================= */
{
  const s = S();
  addContentTitle(s, "THANK YOU", "Q&A");
  addBullets(s, [
    "Questions on any pattern: the decision framework, RPC shapes, deadlines and errors, evolution, security, load balancing, or the Final Project?",
    "Stack-agnostic by design: when you want the how, the Quarkus and Python/grpcio implementation decks take it from here, against the same shipping contract.",
  ], { fontSize: 17 });
  addCaption(s, "Red Hat is the world's leading provider of enterprise open source software solutions: trusted by the Fortune 500 for award-winning support, training, and consulting.");
  addNotes(s, "Thank you. That's the whole 100-level arc: why gRPC fits next to REST and GraphQL, and a five-axis decision lens for choosing it with intent; Protobuf as the contract language, down to the wire bytes; contract-first development gated by Buf; HTTP/2 as the reason gRPC is fast; the four RPC shapes, each called live with grpcurl; deadlines and the rich error model that keep a call chain's failures visible; schema evolution and exactly what buf breaking does and doesn't excuse; streaming at scale and the performance levers that matter; TLS, mTLS, and JWT-based authorization; distributed tracing and the load-balancing fix a plain Kubernetes Service needs; reaching gRPC from a browser; and finally the test pyramid, debugging, and the Final Project that runs every one of these mechanisms at once. Everything here was the pattern and the reasoning: stack-agnostic by design. When you want the how, the two companion decks take it from here: one builds every one of these in Quarkus, the other in Python/grpcio, against the same shipping contract. I'm happy to take questions on any of it. And the standard Red Hat close: Red Hat is the world's leading provider of enterprise open source software solutions, trusted by the Fortune 500 for award-winning support, training, and consulting services.");
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

  addNotes(s, "This is the 100-level concepts deck, so the two codes point where the ideas live and where the whole series lives. On the left, the site: the chapters, the Protobuf contracts, and the runnable both-stack examples, all public. On the right, the Workshops and Tutorials hub: every workshop, tutorial, and deck in the series in one place, including the REST, GraphQL, and WebSockets siblings. Scan whichever is useful; both are on the Pattern Catalyst GitHub organization.");
}


pres.writeFile({ fileName: OUT })
  .then((p) => console.log("WROTE", p, "slides:", pageNum))
  .catch((e) => { console.error(e); process.exit(1); });
