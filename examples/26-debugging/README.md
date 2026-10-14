# Ch26 — Debugging gRPC

`shipping.routing.v1.RoutingService.GetQuote` again, reused as the anchor for
four real failure modes and a three-tool diagnosis pass — not a new RPC, a
new way of looking at the ones already here.

- `contracts/proto/shipping/routing/v1/routing.proto` — the `RoutingService`
  and its five RPCs. `GetQuote` is implemented (with one addition — see
  below); `FindOptimalRoute`, `ListRoutes`, `NegotiateRoute`, and
  `RecomputeRoutes` still return `UNIMPLEMENTED`, exactly as every prior
  chapter left them.
- `contracts/proto/shipping/type/v1/types.proto` — the shared `Money`,
  `Location`, `Cargo`, `Route`, `Leg` messages.

Quarkus (`quarkus/`, host port **9260**) and Python (`python/`, host port
**9261**) each implement the identical RPC, with one chapter-specific
addition: `GetQuote` now waits `QUOTE_DELAY_MS` (default 2000ms,
`compose.yaml`) before responding, on both stacks. That delay exists for
exactly one reason — so a client deadline has something real to race
against — and nothing else about the formula changes: the same single
cargo item (1200.5kg) still prices at `3001.25`.

## The four failure modes, reproduced and asserted

`verify.sh` reproduces each of these against **both** stacks and fails loud
if any assertion doesn't hold:

1. **UNIMPLEMENTED.** `FindOptimalRoute` is declared in the contract and
   never implemented — a `grpcurl` call against it fails `UNIMPLEMENTED` on
   both stacks. Quarkus returns a custom message
   (`"FindOptimalRoute lands in a later chapter"`); Python returns the
   generated service base class's default (`"Method not implemented!"`) —
   same code, different message, because one chapter wrote an explicit
   `Status.UNIMPLEMENTED` and the other relies on the stub's built-in
   default for any method a subclass doesn't override.
2. **DEADLINE_EXCEEDED.** A 1-second client deadline (`grpcurl -max-time 1`)
   against the artificially-delayed `GetQuote` fails `DEADLINE_EXCEEDED` on
   both stacks; a 5-second deadline succeeds with the normal quote.
3. **UNAVAILABLE on a cold/closed channel.** `python/app/unavailable_probe.py`
   — run from the already-built Python image via `docker compose run
   --entrypoint python` — builds a `grpc.aio` channel against each service's
   own in-network address at port **9999**, a port neither container ever
   listens on, and calls `GetQuote` on it. The call fails with
   `grpc.StatusCode.UNAVAILABLE`. `grpcurl` cannot make this same
   assertion: against a closed port it reports a raw dial failure
   (`Failed to dial target host ...: connection refused`) with no gRPC
   status `Code:` line at all, because `grpcurl`'s blocking dial never gets
   far enough to produce one. `grpc.aio`'s lazy channel does — see
   `unavailable_probe.py`'s docstring for the full explanation.
4. **TLS handshake failure.** `grpcurl` defaults to TLS unless `-plaintext`
   is passed. Both servers in this chapter are plaintext-only (same as every
   chapter before Ch19), so a `grpcurl` call without `-plaintext` fails at
   the handshake before a gRPC status ever exists:
   `Failed to dial target host "...": tls: first record does not look like
   a TLS handshake`. `verify.sh` asserts this with a local
   `assert_tls_rejected` helper — the same pattern Ch19's `verify.sh` uses
   for the same shape of failure, copied here rather than shared through
   `_lib/lib.sh` since it is specific to this kind of transport-layer check.

## The diagnosis toolbox

1. **Server reflection** — on by default on both stacks (unchanged since
   Ch7). `grpcurl list` and `grpcurl describe shipping.routing.v1.RoutingService`
   are asserted on both. One asymmetry worth knowing: `grpc-java`'s
   reflection implementation (Quarkus) resolves a method's full name
   directly (`describe shipping.routing.v1.RoutingService.GetQuote`
   succeeds), but `grpcio-reflection` (Python) only resolves service and
   message symbols — the identical `describe Service.Method` call against
   the Python stack fails with `Symbol not found`, confirmed while writing
   this chapter. `verify.sh` asserts the service-level form, which works
   identically on both.
2. **channelz — Python only.** This chapter's Python server additionally
   registers `grpc.channelz.v1.Channelz` on the same port (see `main.py`).
   `grpcurl -d '{}' localhost:9261 grpc.channelz.v1.Channelz/GetServers`
   returns live server data — socket name, calls started/succeeded/failed —
   without touching the business logic at all. **Quarkus has no equivalent
   in this book's pinned `quarkus-grpc` 3.40.x:** channelz does not appear
   anywhere in the `quarkus-grpc` reference guide or the service
   implementation guide (confirmed by searching both before writing this
   chapter). `verify.sh` asserts channelz only against the Python stack; the
   Quarkus diagnosis path instead relies on reflection and structured logs,
   the same two tools every stack has.
3. **GRPC_TRACE / GRPC_VERBOSITY — illustrative, grpc-python/C-core only.**
   `python/app/trace_probe.py` makes one `GetQuote` call;
   `verify.sh` runs it with `GRPC_TRACE=api,call_error,connectivity_state`
   and `GRPC_VERBOSITY=DEBUG` set in the container environment and asserts
   only that *some* trace output appeared — the exact lines vary across
   `grpcio` releases, so this is a demonstration of the mechanism, not a
   fixed-text check. **`grpcurl` cannot demonstrate this at all**: it is
   built on `grpc-go`, a from-scratch Go implementation that does not read
   either variable — the Go equivalents are
   `GRPC_GO_LOG_VERBOSITY_LEVEL`/`GRPC_GO_LOG_SEVERITY_LEVEL`. Both
   `GRPC_TRACE` and `GRPC_VERBOSITY` work identically against **either**
   stack's server, because they configure the *calling* library (here,
   `trace_probe.py`'s `grpc.aio` channel), not the server being called.

## Run it

```bash
cd examples/26-debugging
./verify.sh
```

This brings both services up with `docker compose`, confirms the baseline
`GetQuote` still works on both, reproduces and asserts all four failure
modes above on both stacks, then runs the three-part diagnosis pass, and
tears the stack down again. Prints `PASS` only if every assertion holds.

To poke at it by hand instead:

```bash
docker compose up --build

# 1. UNIMPLEMENTED
grpcurl -plaintext -d '{"origin":{"unLocode":"USNYC"},"destination":{"unLocode":"NLRTM"},"preferSpeed":false}' \
  localhost:9260 shipping.routing.v1.RoutingService/FindOptimalRoute

# 2. DEADLINE_EXCEEDED (tight deadline) vs success (generous deadline)
grpcurl -plaintext -max-time 1 -d '{"origin":{"unLocode":"USNYC"},"destination":{"unLocode":"NLRTM"},"cargo":[{"weightKg":1200.5}]}' \
  localhost:9260 shipping.routing.v1.RoutingService/GetQuote
grpcurl -plaintext -max-time 5 -d '{"origin":{"unLocode":"USNYC"},"destination":{"unLocode":"NLRTM"},"cargo":[{"weightKg":1200.5}]}' \
  localhost:9260 shipping.routing.v1.RoutingService/GetQuote

# 3. UNAVAILABLE on a cold/closed channel (in-network, port 9999 unused)
docker compose run --rm --entrypoint python python -m app.unavailable_probe quarkus:9999
docker compose run --rm --entrypoint python python -m app.unavailable_probe python:9999

# 4. TLS handshake failure (no -plaintext, against a plaintext server)
grpcurl -d '{}' localhost:9260 shipping.routing.v1.RoutingService/GetQuote

# Diagnosis: reflection
grpcurl -plaintext localhost:9260 list
grpcurl -plaintext localhost:9260 describe shipping.routing.v1.RoutingService

# Diagnosis: channelz (Python only)
grpcurl -plaintext -d '{}' localhost:9261 grpc.channelz.v1.Channelz/GetServers

# Diagnosis: GRPC_TRACE/GRPC_VERBOSITY (grpc-python caller only)
docker compose run --rm -e GRPC_TRACE=api,call_error,connectivity_state -e GRPC_VERBOSITY=DEBUG \
  --entrypoint python python -m app.trace_probe quarkus:9000

docker compose down -v
```

The Grafana LGTM observability stack is opt-in and off by default, same as
every prior chapter:

```bash
docker compose --profile observability up --build
```

## Proto code generation: `contracts/` is the only source of truth

Neither module commits generated or copied `.proto`/stub files. Each
`Containerfile` builds with the **repo root** as its Docker build context
(see `compose.yaml`) so it can `COPY` the two proto files this service needs
straight from `contracts/proto/` at build time — unchanged from every prior
chapter.

## On the wire

Real output from an authoring-machine run, one line per failure mode:

```bash
grpcurl -plaintext -d '{"origin":{"unLocode":"USNYC"},"destination":{"unLocode":"NLRTM"},"preferSpeed":false}' \
  localhost:9260 shipping.routing.v1.RoutingService/FindOptimalRoute
# ERROR:
#   Code: Unimplemented
#   Message: FindOptimalRoute lands in a later chapter

grpcurl -plaintext -max-time 1 -d '{...}' localhost:9260 shipping.routing.v1.RoutingService/GetQuote
# ERROR:
#   Code: DeadlineExceeded
#   Message: context deadline exceeded

docker compose run --rm --entrypoint python python -m app.unavailable_probe quarkus:9999
# unavailable_probe: target=quarkus:9999 code=StatusCode.UNAVAILABLE
#   details='failed to connect to all addresses; last error: UNKNOWN:
#   ipv4:172.19.0.3:9999: Failed to connect to remote host: Connection refused'

grpcurl -d '{}' localhost:9260 shipping.routing.v1.RoutingService/GetQuote
# Failed to dial target host "localhost:9260": tls: first record does not look like a TLS handshake
```

## Diagram

See the chapter (`_docs/26-debugging-grpc.md`) for the two figures —
`26-debug-failure-modes` (symptom → cause → fix for each of the four modes
above) and `26-diagnosis-toolbox` (what reflection, channelz, and
GRPC_TRACE/GRPC_VERBOSITY each reveal, with the note on where channelz
does and doesn't apply) —
under `assets/diagrams/`.

## Verification status

`verify.sh` was run end to end on the authoring machine, both stacks,
repeatedly green: the baseline `GetQuote` correctness check, all four
failure-mode repros, and the three-part diagnosis pass (reflection on both,
channelz on Python, GRPC_TRACE/GRPC_VERBOSITY on both) all passed. The
highest-risk things a reader's own run should reconfirm: that `grpcio`,
`grpcio-reflection`, and `grpcio-channelz` continue to resolve to matching
versions from the open `>=1.75,<2` range (they are released in lockstep
upstream, but pip resolves each independently); that quarkus-grpc 3.40.x
still has no channelz support (re-check the `quarkus-grpc` reference guide
before relying on this chapter's absence claim against a newer release);
and that the exact TLS-handshake-failure wording
(`tls: first record does not look like a TLS handshake`) is produced by the
installed `grpcurl` version — the three different wordings Ch19 documents
for this family of failure are all valid, and `assert_tls_rejected` matches
on the whole family rather than one exact string.
