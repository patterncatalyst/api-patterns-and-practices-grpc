# Ch13 — Schema design ANCHOR: pagination + FieldMask on `RoutingService.ListRoutes`

The reference both-stack implementation of `shipping.routing.v1.RoutingService.ListRoutes`
over a fixed 5-route in-memory catalog — the chapter's proof that `page_size`/
`page_token` pagination and `google.protobuf.FieldMask` projection are the
same contract and the same client-visible behavior on two independently
built servers. The contract — not either codebase — is the source of truth:

- `contracts/proto/shipping/routing/v1/routing.proto` — the `RoutingService`
  and its five RPCs (only `ListRoutes` is implemented here; the rest return
  `UNIMPLEMENTED`, same discipline as every prior chapter's example).
- `contracts/proto/shipping/type/v1/types.proto` — the shared `Route`,
  `Leg`, `Location`, `Money` messages `ListRoutes` returns.

Quarkus (`quarkus/`, host port 9130) and Python (`python/`, host port 9131)
independently implement the identical RPC, generated from the **same**
`.proto` files. `verify.sh` calls `ListRoutes` on **both** stacks via
`grpcurl` and asserts page 1's exact contents, page 2's continuation with no
overlap and an empty terminal token, and a `field_mask` projection's exact
shape — not just an `OK` status.

## Run it

```bash
cd examples/13-schema-design
./verify.sh
```

This brings both services up with `docker compose`, waits for each gRPC
server to answer reflection's `list`, calls `ListRoutes` four ways against
`localhost:9130` (Quarkus) and `localhost:9131` (Python), asserts every
response shape below, and tears the stack down again. Prints `PASS` only if
every assertion holds for **both** stacks.

To poke at it by hand instead:

```bash
docker compose up --build

grpcurl -plaintext -d '{"pageSize":3}' \
  localhost:9130 shipping.routing.v1.RoutingService/ListRoutes
# 3 routes (rte_001..rte_003), next_page_token="3"

grpcurl -plaintext -d '{"pageSize":3,"pageToken":"3"}' \
  localhost:9130 shipping.routing.v1.RoutingService/ListRoutes
# 2 routes (rte_004, rte_005), no next_page_token field (empty -> omitted)

grpcurl -plaintext -d '{"pageSize":3,"fieldMask":{"paths":["id","price"]}}' \
  localhost:9130 shipping.routing.v1.RoutingService/ListRoutes
# each route carries only id + price; legs is absent

docker compose down -v
```

Swap `9130` for `9131` to hit the Python stack instead — same inputs, same
page contents, same projected shape.

The Grafana LGTM observability stack is opt-in and off by default (both
services start and serve `ListRoutes` fine without a collector; export
failures are async and never block the response):

```bash
docker compose --profile observability up --build
```

## The catalog

Both stacks build the identical five `Route`s, in the identical order, as a
plain in-memory list (`RouteCatalog.java` / `app/catalog.py`) — a real
routing engine would page over a database query ordered by a stable key, but
the catalog's job here is only to give pagination and field-mask projection
deterministic data to walk:

| Index | `id` | carrier | origin -> destination | `price` |
|---|---|---|---|---|
| 0 | `rte_001` | MAERSK | USNYC -> NLRTM | `1200.00 USD` |
| 1 | `rte_002` | MSC | USLAX -> CNSHA | `2400.00 USD` |
| 2 | `rte_003` | HMM | DEHAM -> SGSIN | `1800.50 USD` |
| 3 | `rte_004` | MAERSK | NLRTM -> USNYC | `1150.75 USD` |
| 4 | `rte_005` | COSCO | CNSHA -> USLAX | `2600.25 USD` |

## Pagination: `page_size` + `page_token`

`page_size` and `page_token` together page through the catalog above:

- `page_size <= 0` -> `DEFAULT_PAGE_SIZE` (3).
- `page_size > MAX_PAGE_SIZE` (5) -> clamped to `MAX_PAGE_SIZE`.
- `page_token == ""` -> start at index 0 (the first page).
- `page_token == "<n>"` -> start at index `n`. In this demo the token is
  just the next offset rendered as a string — opaque to the client (it never
  parses or constructs one itself), kept simple here for this README. A
  production catalog would encode a stable cursor (a last-seen key,
  not a raw offset) so the token survives inserts/deletes between calls; see
  the chapter's "Pagination" section for why.
- An invalid or out-of-range token returns `INVALID_ARGUMENT` with a
  `BadRequest` naming `page_token` — the same rich-error shape Ch11
  established.

| Call | `page_size` | `page_token` | Returns | `next_page_token` |
|---|---|---|---|---|
| 1 | 3 | `""` | `rte_001`, `rte_002`, `rte_003` | `"3"` |
| 2 | 3 | `"3"` | `rte_004`, `rte_005` | `""` (catalog exhausted) |

`verify.sh` asserts call 1's exact three IDs and non-empty token, then feeds
that token into call 2 and asserts the remaining two IDs (no overlap with
call 1) and an empty terminal token.

## FieldMask: projecting the response

`field_mask.paths` names which top-level `Route` fields the response should
populate; every field not named stays at its zero value, which proto3's JSON
mapping and wire format both omit, so "not requested" and "absent from the
response" are the same observable signal:

| `field_mask.paths` | Response shape |
|---|---|
| unset / empty (no mask sent) | the full `Route`: `id`, `legs[]`, `price` |
| `["id", "price"]` | only `id` and `price` populated; `legs` absent |

Both stacks implement this with the **same well-known-type library each
stack already ships**, not hand-rolled field clearing:

- **Quarkus**: `com.google.protobuf.util.FieldMaskUtil` (from
  `protobuf-java-util`, version-managed by the Quarkus BOM) — `isValid`
  rejects a path `Route` doesn't have, `normalize` sorts/de-duplicates the
  paths, and `merge(mask, source, destination)` copies only the named paths
  from `source` into a **fresh, empty** `destination` builder, which is what
  turns "merge" into "project."
- **Python**: `google.protobuf.field_mask_pb2.FieldMask`'s own
  `IsValidForDescriptor` and `MergeMessage` methods do the identical two
  steps — reject an unknown path, then merge into a fresh `Route()`.

`verify.sh` asserts the masked response's `routes[0].id` and
`routes[0].price.currency` are present and that the string `"legs"` never
appears in the masked response body at all — not just that the call
succeeded.

## The other four RPCs

Only `ListRoutes` has a real implementation; the rest return `UNIMPLEMENTED`,
same as every prior chapter — see `RoutingServiceImpl.java` / the generated
`RoutingServiceServicer` base class's default behavior in `app/routing_service.py`.

## Proto code generation: `contracts/` is the only source of truth

Neither module commits generated or copied `.proto`/stub files — same
discipline as every prior anchor. Each `Containerfile` builds with the
**repo root** as its Docker build context (see `compose.yaml`) so it can
`COPY` the two proto files this service needs straight from
`contracts/proto/` at build time. For a local, non-container `mvn`/`uv` run,
copy the same two files by hand first:

```bash
# Quarkus
mkdir -p quarkus/src/main/proto/shipping/{type,routing}/v1
cp ../../contracts/proto/shipping/type/v1/types.proto    quarkus/src/main/proto/shipping/type/v1/
cp ../../contracts/proto/shipping/routing/v1/routing.proto quarkus/src/main/proto/shipping/routing/v1/

# Python
mkdir -p python/proto/shipping/{type,routing}/v1 python/generated
cp ../../contracts/proto/shipping/type/v1/types.proto      python/proto/shipping/type/v1/
cp ../../contracts/proto/shipping/routing/v1/routing.proto python/proto/shipping/routing/v1/
cd python && uv sync --group dev && \
  .venv/bin/python -m grpc_tools.protoc -I proto --python_out=generated --grpc_python_out=generated \
    proto/shipping/type/v1/types.proto proto/shipping/routing/v1/routing.proto
```

Both copy destinations are gitignored (see `.gitignore`) — build-time-only,
never committed.

## On the wire

Server reflection is enabled on both stacks, so `grpcurl` needs no local
`.proto` copy:

```bash
grpcurl -plaintext localhost:9130 list
# grpc.reflection.v1alpha.ServerReflection
# shipping.routing.v1.RoutingService
```

`FieldMask` is one of the handful of protobuf well-known types with a special
JSON mapping: a statically compiled client marshals it as a single comma-
joined string of camelCase paths (`"id,price"`), not as `{"paths":[...]}`.
`grpcurl` doesn't get that special case automatically, because server reflection
hands it a *dynamic* descriptor rather than a compiled-in Go type, and its
JSON unmarshaler only applies the well-known-type shortcuts it recognizes
statically — so a `grpcurl` request has to spell `field_mask` out as the
message it actually is, `{"paths":["id","price"]}`, which works regardless
of whether the request key is written `fieldMask` or `field_mask`. The
response side has the mirror asymmetry: `grpcurl`'s own JSON output renders
every field by its **proto name** (`next_page_token`, `un_locode`), not the
lowerCamelCase a browser `fetch()` calling the same service over grpc-web
would see. Both are `grpcurl` rendering choices, not protocol differences —
the bytes on the wire are identical either way. `verify.sh` sends the object
form and reads the proto-name response fields for exactly this reason.

`verify.sh` asserts, per stack:

| Check | Expected |
|---|---|
| page 1 route count | 3 |
| page 1 route IDs | `rte_001`, `rte_002`, `rte_003` (in order) |
| page 1 `next_page_token` | non-empty |
| page 2 route count | 2 |
| page 2 route IDs | `rte_004`, `rte_005` (no overlap with page 1) |
| page 2 `next_page_token` | empty (catalog exhausted) |
| masked response | `routes[0].id` and `routes[0].price.currency` present |
| masked response | the literal string `"legs"` never appears |
| unmasked response | `"legs"` and a carrier name (`MAERSK`) both present |

## Diagrams

Three paired figures in `assets/diagrams/` (generated with
`scripts/generate_diagram.py`) back this chapter: `13-message-granularity`
(nest vs. reference by id), `13-pagination-page-tokens` (the two call/response
pairs that walk the catalog across a page boundary), and
`13-fieldmask-projection` (the request/full-object/projected-object chain
`FieldMaskUtil.merge` (Java) and `FieldMask.MergeMessage` (Python) both perform).
