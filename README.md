# API Patterns and Practices: gRPC

Designing gRPC APIs well, with runnable examples in **Quarkus** and **Python** against one
Protocol Buffers contract — a chapter-based Jekyll site plus three companion decks, in the
`lgtm` house style.

Second of four per-style sites in the *API Patterns & Practices* series (REST →
[gRPC](https://github.com/patterncatalyst/api-patterns-and-practices-grpc) → GraphQL →
WebSockets, after [REST](https://github.com/patterncatalyst/api-patterns-and-practices-rest)).
The shipping/cargo domain is continuous across the series: here, gRPC is the internal,
latency-sensitive **routing and tracking** service that the REST booking service calls.

## What's here

- **28 chapters (Ch0–Ch27) + an OpenShift Local (CRC) appendix** — from the decision lens and
  Protocol Buffers through the four RPC shapes, deadlines/errors/interceptors, schema design and
  evolution under Buf, concurrency and long-running work, streaming at scale, performance, TLS/mTLS
  and token auth, observability/mesh/load-balancing, grpc-web and JSON transcoding, HTTP/3, testing
  and debugging, and a Final Project that ties the system together across three tiers.
- **Both stacks, first-class:** every hands-on chapter ships a Quarkus (`quarkus-grpc`, UBI 10,
  Java 25) **and** a Python (`grpcio`/`grpcio-tools`, Python 3.14, uv) example against the **same**
  `.proto`. Code tabs are built to admit Go and C++ later.
- **Contract-first:** Protocol Buffers under [Buf](https://buf.build) (`buf lint` + `buf breaking`)
  are the single source of truth; both stacks generate from the same contract.
- **Behavioral verification:** every example ships a `verify.sh` that calls the running service and
  asserts response *semantics* against the proto — not just a status code.
- **Three tiers:** Docker Compose → minikube (Kubernetes) → OpenShift Local (CRC).
- **Three decks:** a 100-level gRPC concepts deck plus 201 Quarkus and 201 Python implementation
  decks (`presentation/`).

## Domain

The canonical **shipping / cargo** domain used across patterncatalyst material: `Booking`,
`Cargo`, `Location` (UN/LOCODE), `Route`, `Operation`, and `Money` as a decimal string. gRPC is
the internal routing/tracking service the REST booking sibling calls — the same story, one tier down.

## Build locally

```bash
bundle install
bundle exec jekyll serve --baseurl ""
# → http://localhost:4000
```

Run an example's behavioral check (Docker Compose, both stacks):

```bash
bash examples/05-contract-first/verify.sh
```

## Layout

| Path | What |
|---|---|
| `_docs/` | The chapters + the CRC appendix (Markdown). |
| `contracts/` | The Protocol Buffers contract under Buf — the source of truth. |
| `examples/` | One runnable example per hands-on chapter, Quarkus + Python, each with `verify.sh`. |
| `presentation/` | The three `.pptx` deck builders (100 concepts, 201 Quarkus, 201 Python). |
| `_plans/` | Iteration plan, coverage matrix, domain glossary. |
| `scripts/` | Static validation, diagram generation, word-count gate. |

## License

MIT — prose and code.
