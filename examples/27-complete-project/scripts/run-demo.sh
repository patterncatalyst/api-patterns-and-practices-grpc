#!/usr/bin/env bash
# Final Project minikube subtree — build the mesh server image, deploy it,
# and run the three-phase load-balancing demo: plain ClusterIP (the pin),
# headless + client round_robin (fix #1), Istio DestinationRule (fix #2) —
# the Chapter 22 shape, reused against this chapter's richer RoutingService
# (GetQuote calling downstream QuoteService) plus a fourth step that fires one
# NegotiateRoute and one WatchShipment call through the mesh and greps the
# propagated trace id out of the pods' own logs — "a traced call," without
# needing a Tempo instance inside this minikube cluster.
#
# Idempotent: every `kubectl apply` is safe to repeat, each load-client Job
# is deleted before being recreated, and a transient Istio hiccup in phase 3
# can be cleared by re-running this script from the top — phases 1 and 2 do
# not depend on Istio at all and re-run in a few seconds.
#
# Usage:
#   ./scripts/run-demo.sh                 # all four phases
#   ./scripts/run-demo.sh plain            # one phase only (plain|headless|istio|traced)
#
# Env overrides:
#   MINIKUBE_PROFILE   must match bootstrap.sh (default: grpc-ch27)
#   CALLS              GetQuote calls per phase, over one channel (default: 30)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXAMPLE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$EXAMPLE_DIR/../.." && pwd)"

MINIKUBE_PROFILE="${MINIKUBE_PROFILE:-grpc-ch27}"
NAMESPACE="final-project-demo"
CALLS="${CALLS:-30}"
IMAGE="ch27-final-project-mesh:dev"
PHASE_ARG="${1:-all}"

KC=(kubectl --context "$MINIKUBE_PROFILE" -n "$NAMESPACE")

# Self-contained grpcurl, same philosophy as examples/_lib/lib.sh's
# ensure_grpcurl, duplicated locally (that file is shared and stays
# untouched) — used only by the "traced" phase below.
GRPCURL_VERSION="${GRPCURL_VERSION:-1.9.3}"
ensure_grpcurl() {
  if command -v grpcurl >/dev/null 2>&1; then
    return 0
  fi
  local bin_dir="$SCRIPT_DIR/.bin"
  local bin="$bin_dir/grpcurl"
  if [[ -x "$bin" ]]; then
    export PATH="$bin_dir:$PATH"
    return 0
  fi
  local os arch
  os="$(uname -s)"; arch="$(uname -m)"
  case "$arch" in x86_64|amd64) arch="x86_64" ;; aarch64|arm64) arch="arm64" ;; esac
  mkdir -p "$bin_dir"
  curl -fsSL "https://github.com/fullstorydev/grpcurl/releases/download/v${GRPCURL_VERSION}/grpcurl_${GRPCURL_VERSION}_${os}_${arch}.tar.gz" \
    -o "$bin_dir/grpcurl.tar.gz"
  tar -xzf "$bin_dir/grpcurl.tar.gz" -C "$bin_dir" grpcurl
  chmod +x "$bin"
  rm -f "$bin_dir/grpcurl.tar.gz"
  export PATH="$bin_dir:$PATH"
}

echo "==> building ${IMAGE} (context: repo root, so the Containerfile can COPY contracts/proto/)"
docker build -f "$EXAMPLE_DIR/loadclient/Containerfile" -t "$IMAGE" "$REPO_ROOT"

echo "==> loading ${IMAGE} into minikube profile ${MINIKUBE_PROFILE} (no registry, no push)"
minikube -p "$MINIKUBE_PROFILE" image load "$IMAGE"

echo "==> applying k8s/ (namespace, Deployment x3, plain + headless Services)"
kubectl --context "$MINIKUBE_PROFILE" apply -k "$EXAMPLE_DIR/k8s"

echo "==> waiting for the Deployment to roll out"
"${KC[@]}" rollout status deployment/finalproject --timeout=180s

# ---------------------------------------------------------------------------
# run_phase NAME TARGET LB_POLICY MESHED
# ---------------------------------------------------------------------------
run_phase() {
  local name="$1" target="$2" lb_policy="$3" meshed="$4"
  local job="loadclient-${name}"

  echo
  echo "=== phase: ${name} (target=${target} lb_policy=${lb_policy:-pick_first} meshed=${meshed}) ==="

  "${KC[@]}" delete job "$job" --ignore-not-found --wait=true >/dev/null

  cat <<EOF | "${KC[@]}" apply -f -
apiVersion: batch/v1
kind: Job
metadata:
  name: ${job}
  labels:
    app: loadclient
    phase: ${name}
spec:
  backoffLimit: 0
  ttlSecondsAfterFinished: 600
  template:
    metadata:
      labels:
        app: loadclient
        phase: ${name}
      annotations:
        sidecar.istio.io/inject: "${meshed}"
    spec:
      restartPolicy: Never
      containers:
        - name: loadclient
          image: ${IMAGE}
          imagePullPolicy: Never
          command: ["python", "-m", "app.loadclient"]
          env:
            - name: TARGET
              value: "${target}"
            - name: LB_POLICY
              value: "${lb_policy}"
            - name: CALLS
              value: "${CALLS}"
            - name: PHASE_LABEL
              value: "${name}"
EOF

  if ! "${KC[@]}" wait --for=condition=complete "job/${job}" --timeout=120s 2>/dev/null; then
    echo "    job ${job} did not reach Complete within the timeout — current state:"
    "${KC[@]}" get "job/${job}" -o wide || true
    "${KC[@]}" logs "job/${job}" --all-containers=true --ignore-errors=true || true
    echo "    re-run ./scripts/run-demo.sh to retry (idempotent — safe from the top)"
    return 1
  fi

  "${KC[@]}" logs "job/${job}" -c loadclient
}

run_plain_phase() {
  run_phase "phase1-plain-pin" \
    "finalproject-plain.${NAMESPACE}.svc.cluster.local:9000" \
    "" \
    "false"
}

run_headless_phase() {
  run_phase "phase2-headless-round-robin" \
    "dns:///finalproject-headless.${NAMESPACE}.svc.cluster.local:9000" \
    "round_robin" \
    "false"
}

run_istio_phase() {
  echo
  echo "=== switching the Deployment into the mesh (sidecar.istio.io/inject=true) ==="
  "${KC[@]}" patch deployment finalproject --type=json \
    -p='[{"op":"replace","path":"/spec/template/metadata/annotations/sidecar.istio.io~1inject","value":"true"}]'
  "${KC[@]}" rollout restart deployment/finalproject
  "${KC[@]}" rollout status deployment/finalproject --timeout=180s
  echo "    pod readiness (expect 2/2 — app + istio-proxy):"
  "${KC[@]}" get pods -l app=finalproject

  echo
  echo "=== applying istio/ (PeerAuthentication STRICT, DestinationRule ROUND_ROBIN, VirtualService retries/timeouts) ==="
  "${KC[@]}" apply -f "$EXAMPLE_DIR/istio"
  echo "    giving Envoy a few seconds to pick up the new config"
  sleep 5

  run_phase "phase3-istio-l7" \
    "finalproject-plain.${NAMESPACE}.svc.cluster.local:9000" \
    "" \
    "true"
}

# phase 4: fire ONE NegotiateRoute (bidi) and ONE WatchShipment (server
# stream) call through a port-forward to the plain Service, then grep the
# propagated trace id out of the pods' own stdout — "a traced call," entirely
# from kubectl logs, no Tempo instance needed inside this cluster.
run_traced_call_phase() {
  ensure_grpcurl
  echo
  echo "=== phase: traced-call (NegotiateRoute + WatchShipment through the mesh) ==="

  local pf_port=19270
  kubectl --context "$MINIKUBE_PROFILE" -n "$NAMESPACE" port-forward svc/finalproject-plain "${pf_port}:9000" \
    >/tmp/ch27-finalproject-pf.log 2>&1 &
  local pf_pid=$!
  trap '[[ -n "${pf_pid:-}" ]] && kill "$pf_pid" 2>/dev/null || true' RETURN

  sleep 3

  echo "--- GetQuote (establishes a trace id both handlers log) ---"
  grpcurl -plaintext -d '{"origin":{"unLocode":"USNYC","name":"New York"},"destination":{"unLocode":"NLRTM","name":"Rotterdam"},"cargo":[{"weightKg":1000}]}' \
    "localhost:${pf_port}" shipping.routing.v1.RoutingService/GetQuote

  echo "--- NegotiateRoute (bidirectional: two proposals, one accepted, one countered) ---"
  printf '%s\n%s\n' \
    '{"proposal":{"id":"rte_demo-accept","price":{"currency":"USD","amount":"2500.00"}}}' \
    '{"proposal":{"id":"rte_demo-counter","price":{"currency":"USD","amount":"9000.00"}}}' \
    | grpcurl -plaintext -d @ "localhost:${pf_port}" shipping.routing.v1.RoutingService/NegotiateRoute

  echo "--- WatchShipment (server streaming: the four-event sequence) ---"
  grpcurl -plaintext -d '{"bookingId":"bkg_demo_mesh"}' \
    "localhost:${pf_port}" shipping.tracking.v1.TrackingService/WatchShipment

  kill "$pf_pid" 2>/dev/null || true
  wait "$pf_pid" 2>/dev/null || true
  pf_pid=""

  echo
  echo "--- propagated trace id, logged by BOTH RoutingService and QuoteService (grep across all 3 pods) ---"
  "${KC[@]}" logs -l app=finalproject --all-containers=true --tail=500 | grep -E 'trace_id=' | tail -10
}

case "$PHASE_ARG" in
  plain) run_plain_phase ;;
  headless) run_headless_phase ;;
  istio) run_istio_phase ;;
  traced) run_traced_call_phase ;;
  all)
    run_plain_phase
    run_headless_phase
    run_istio_phase
    run_traced_call_phase
    ;;
  *)
    echo "usage: $0 [plain|headless|istio|traced|all]" >&2
    exit 2
    ;;
esac

echo
echo "done. finalproject pods for this run:"
"${KC[@]}" get pods -l app=finalproject -o wide
