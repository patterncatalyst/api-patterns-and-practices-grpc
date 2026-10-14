#!/usr/bin/env bash
# Ch22 mesh-loadbalancing — build the server image, deploy it, and run the
# three-phase demo: plain ClusterIP (the pin), headless + client round_robin
# (fix #1), Istio DestinationRule (fix #2). Run ./scripts/bootstrap.sh first.
#
# Idempotent: every `kubectl apply` is safe to repeat, the load-client Job
# is deleted before each (re)run, and a transient Istio hiccup in phase 3
# can be cleared by re-running this script from the top — phases 1 and 2
# do not depend on Istio at all and re-run in a few seconds.
#
# Usage:
#   ./scripts/run-demo.sh                 # all three phases
#   ./scripts/run-demo.sh plain            # one phase only (plain|headless|istio)
#
# Env overrides:
#   MINIKUBE_PROFILE   must match bootstrap.sh (default: grpc-ch22)
#   CALLS              GetQuote calls per phase, over one channel (default: 30)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXAMPLE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$EXAMPLE_DIR/../.." && pwd)"

MINIKUBE_PROFILE="${MINIKUBE_PROFILE:-grpc-ch22}"
NAMESPACE="mesh-lb-demo"
CALLS="${CALLS:-30}"
IMAGE="ch22-routing-python:dev"
PHASE_ARG="${1:-all}"

KC=(kubectl --context "$MINIKUBE_PROFILE" -n "$NAMESPACE")

echo "==> building ${IMAGE} (context: repo root, so the Containerfile can COPY contracts/proto/)"
docker build -f "$EXAMPLE_DIR/python/Containerfile" -t "$IMAGE" "$REPO_ROOT"

echo "==> loading ${IMAGE} into minikube profile ${MINIKUBE_PROFILE} (no registry, no push)"
minikube -p "$MINIKUBE_PROFILE" image load "$IMAGE"

echo "==> applying k8s/ (namespace, Deployment x3, plain + headless Services)"
kubectl --context "$MINIKUBE_PROFILE" apply -k "$EXAMPLE_DIR/k8s"

echo "==> waiting for the Deployment to roll out"
"${KC[@]}" rollout status deployment/quote --timeout=180s

# ---------------------------------------------------------------------------
# run_phase NAME TARGET LB_POLICY MESHED
#   NAME       short label used for the Job name and the printed banner
#   TARGET     grpc dial target the loadclient's TARGET env var gets
#   LB_POLICY  grpc.lb_policy_name value, or "" for the grpc-core default
#              (pick_first)
#   MESHED     "true" to set sidecar.istio.io/inject on the Job's pod,
#              "false" to keep it out of the mesh
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

  # Native sidecars (Istio 1.29+) run as initContainers with
  # restartPolicy: Always, which is the Kubernetes "sidecar containers"
  # mechanism — they terminate automatically once every regular container
  # in the pod has exited, so a meshed Job completes normally instead of
  # hanging at 1/2 the way it did on older Istio releases.
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
    "quote-plain.${NAMESPACE}.svc.cluster.local:9000" \
    "" \
    "false"
}

run_headless_phase() {
  run_phase "phase2-headless-round-robin" \
    "dns:///quote-headless.${NAMESPACE}.svc.cluster.local:9000" \
    "round_robin" \
    "false"
}

run_istio_phase() {
  echo
  echo "=== switching the Deployment into the mesh (sidecar.istio.io/inject=true) ==="
  "${KC[@]}" patch deployment quote --type=json \
    -p='[{"op":"replace","path":"/spec/template/metadata/annotations/sidecar.istio.io~1inject","value":"true"}]'
  "${KC[@]}" rollout restart deployment/quote
  "${KC[@]}" rollout status deployment/quote --timeout=180s
  echo "    pod readiness (expect 2/2 — app + istio-proxy):"
  "${KC[@]}" get pods -l app=quote

  echo
  echo "=== applying istio/ (PeerAuthentication STRICT, DestinationRule ROUND_ROBIN, VirtualService retries/timeouts) ==="
  "${KC[@]}" apply -f "$EXAMPLE_DIR/istio"
  echo "    giving Envoy a few seconds to pick up the new config"
  sleep 5

  run_phase "phase3-istio-l7" \
    "quote-plain.${NAMESPACE}.svc.cluster.local:9000" \
    "" \
    "true"
}

case "$PHASE_ARG" in
  plain) run_plain_phase ;;
  headless) run_headless_phase ;;
  istio) run_istio_phase ;;
  all)
    run_plain_phase
    run_headless_phase
    run_istio_phase
    ;;
  *)
    echo "usage: $0 [plain|headless|istio|all]" >&2
    exit 2
    ;;
esac

echo
echo "done. GetQuote pods for this run:"
"${KC[@]}" get pods -l app=quote -o wide
