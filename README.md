# API Patterns and Practices: gRPC

Designing gRPC APIs well, with runnable examples in **Quarkus** and **Python** against one
Protocol Buffers contract.

Second of four per-style sites in the *API Patterns & Practices* series (after
[REST](https://github.com/patterncatalyst/api-patterns-and-practices-rest)). The shipping/cargo
domain is continuous across the series: here, gRPC is the internal, latency-sensitive **routing
and tracking** service that the REST booking service calls.

- **Contract-first:** Protocol Buffers under [Buf](https://buf.build) (`buf lint` + `buf breaking`)
  are the single source of truth; both stacks generate from the same `.proto`.
- **Both stacks, first-class:** Quarkus (`quarkus-grpc`, UBI 10, Java 25) and Python
  (`grpcio`/`grpcio-tools`, Python 3.14, uv). Code tabs are built to admit Go and C++ later.
- **Behavioral verification:** every example ships a `verify.sh` that calls the running service
  and asserts response semantics against the proto — not just a status.
- **Runs on three tiers:** Docker Compose → minikube → OpenShift Local (CRC).

See [`_plans/iteration-plan.md`](_plans/iteration-plan.md) for the full build plan.

## Build locally

```bash
bundle install
bundle exec jekyll serve --baseurl ""
# → http://localhost:4000
```

## License

MIT — see [LICENSE](LICENSE).
