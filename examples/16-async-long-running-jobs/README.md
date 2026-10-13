# Ch16 — Async/long-running jobs: the Operation lifecycle on RoutingService

The reference both-stack implementation of the server-owned `Operation` pattern
on `shipping.routing.v1.RoutingService`:

- `contracts/proto/shipping/routing/v1/routing.proto` — `RecomputeRoutes`
  (starts the job, returns an `Operation`), and the three Ch16 lookup RPCs
  added to the contract this iteration: `GetOperation` (poll),
  `WatchOperation` (server-stream), `CancelOperation` (server-owned cancel) —
  all three return `shipping.type.v1.Operation` directly, under the two scoped
  `buf:lint:ignore` exceptions visible above each declaration.
- `contracts/proto/shipping/type/v1/types.proto` — `Operation` itself (`id`,
  `kind`, `done`, `progress_pct`, `message`).

Quarkus (`quarkus/`, host port 9160) and Python (`python/`, host port 9161)
each independently implement an in-memory `Operation` registry and the same
bounded, fast job schedule, so the identical sequence of calls against either
stack produces the identical shape of answers. `verify.sh` drives both stacks
through all six claims this chapter makes.

## Run it

```bash
cd examples/16-async-long-running-jobs
./verify.sh
```

This brings both services up with `docker compose`, waits for each gRPC
server to answer reflection's `list`, then against **each** of
`localhost:9160` (Quarkus) and `localhost:9161` (Python):

1. **Start** — `RecomputeRoutes{reason:"reconcile"}` returns an `Operation`
   with a non-empty `op_`-prefixed id and `done` not yet `true`.
2. **Poll** — a bounded `GetOperation` loop (25 tries x 0.2s = 5s, well over
   this example's ~1s normal job) converges on `done=true`,
   `progress_pct=100`.
3. **Watch** — a *fresh* operation, watched immediately via `WatchOperation`,
   yields at least two `Operation` snapshots; the last one is terminal
   (`done=true`, `progress_pct=100`).
4. **Cancel** — the `"slow"` variant (`reason` containing `slow`) runs for
   several seconds; `CancelOperation` sent 0.3s after starting it lands well
   before natural completion. The follow-up `GetOperation` shows `done=true`,
   a `message` containing "cancelled" (case-insensitive), and
   `progress_pct < 100` — the server-owned job actually stopped, not merely a
   client that stopped asking.
5. **Rerunnable reconcile** — two sequential `RecomputeRoutes{reason:"reconcile"}`
   calls each produce their own operation id and each independently converge
   on `done=true`/`progress_pct=100`.
6. **Still-unimplemented RPC** — `GetQuote` (declared on `RoutingService` for
   other chapters, not this one) still answers `UNIMPLEMENTED`.

Prints `PASS` only if every assertion holds for **both** stacks.

To poke at it by hand instead, see the chapter's "On the wire" section for the
exact `grpcurl` commands (start, poll, watch, cancel) against port 9160 or
9161.

The Grafana LGTM observability stack is opt-in and off by default (both
services start and serve `RecomputeRoutes` fine without a collector; export
failures are async and never block a call):

```bash
docker compose --profile observability up --build
```

## The Operation registry

Both stacks keep an in-memory map from an `op_`-prefixed id to a mutable
record (`OperationRegistry`/`OperationState` on both sides). A production
service would back this with a durable store so an operation survives a
restart; the client-visible contract — create, poll, watch, cancel by id — is
identical either way.

| Field | Meaning |
|---|---|
| `id` | opaque, server-generated, `op_`-prefixed |
| `kind` | what the operation is doing (`"recompute_routes"` here) |
| `done` | the single terminal signal; proto3 omits it from JSON while `false` |
| `progress_pct` | best-effort 0–100; proto3 omits it from JSON while `0` |
| `message` | human-readable status, or the reason a cancelled job stopped |

**`RecomputeRoutes`** creates the record and hands the actual work to a
background executor — `Infrastructure.getDefaultExecutor()` (Mutiny's worker
pool) on Quarkus, `asyncio.create_task(...)` on Python — then returns the
fresh, non-terminal snapshot immediately, without waiting on that work.

**The job** advances in a few fixed, bounded steps (5 steps x ~200ms for the
ordinary `reason`, 20 steps x ~200ms for the `"slow"` variant), checking
whether the record has already gone terminal before each step and bailing out
early if a `CancelOperation` beat it there.

**`WatchOperation`** streams by polling the same record the job mutates —
`Multi.createFrom().emitter(...)` on Quarkus, an `async def` generator on
Python — emitting a fresh snapshot on a short interval and completing the
stream (half-close) the moment a snapshot comes back `done`.

**`GetOperation`** and **`CancelOperation`** are single synchronous reads or
writes against the same record. An unknown `operation_id` on any of the three
lookup RPCs returns `NOT_FOUND`.

## Proto code generation: `contracts/` is the only source of truth

Neither module commits generated or copied `.proto`/stub files. Each
`Containerfile` builds with the **repo root** as its Docker build context so
it can `COPY` the two proto files this service needs (`types.proto`,
`routing.proto`) straight from `contracts/proto/` at build time:

```bash
# Quarkus
mkdir -p quarkus/src/main/proto/shipping/{type,routing}/v1
cp ../../contracts/proto/shipping/type/v1/types.proto       quarkus/src/main/proto/shipping/type/v1/
cp ../../contracts/proto/shipping/routing/v1/routing.proto  quarkus/src/main/proto/shipping/routing/v1/

# Python
mkdir -p python/proto/shipping/{type,routing}/v1 python/generated
cp ../../contracts/proto/shipping/type/v1/types.proto       python/proto/shipping/type/v1/
cp ../../contracts/proto/shipping/routing/v1/routing.proto  python/proto/shipping/routing/v1/
cd python && uv sync --group dev && \
  .venv/bin/python -m grpc_tools.protoc -I proto --python_out=generated --grpc_python_out=generated \
    proto/shipping/type/v1/types.proto proto/shipping/routing/v1/routing.proto
```

Both copy destinations (`quarkus/src/main/proto/`, `python/proto/`,
`python/generated/`) are gitignored (see `./.gitignore`) — build-time-only,
never committed.

## On the wire

Server reflection is enabled on both stacks:

```bash
grpcurl -plaintext localhost:9160 list
# grpc.reflection.v1alpha.ServerReflection
# shipping.routing.v1.RoutingService
```

See `_docs/16-async-long-running-jobs.md`'s "On the wire" box for the full
start -> poll -> watch -> cancel sequence with sample JSON.

## Diagrams

`16-operation-lifecycle.svg`, `16-poll-vs-watch.svg`, and
`16-cancel-and-rerun.svg` (plus their `.excalidraw` sources, all under
`assets/diagrams/`) show, respectively: the Operation record outliving the
call that created it; polling versus watching; and server-owned cancellation
versus closing a watch stream, plus the rerunnable reconcile. All three are
embedded in the chapter.

## Verification status

**Verified** by an actual run of `./verify.sh` against both stacks, built and
executed in this iteration — see the chapter's "Build, run, observe" section.
All six assertion groups above passed on both `localhost:9160` (Quarkus) and
`localhost:9161` (Python).
