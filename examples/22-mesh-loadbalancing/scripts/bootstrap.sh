#!/usr/bin/env bash
# Ch22 mesh-loadbalancing — one-time (and idempotent) cluster bootstrap:
# start minikube, install Istio's control plane, and prepare the demo
# namespace. Run once per session; scripts/run-demo.sh does everything that
# changes between phases of the actual demo.
#
# This example is CLUSTER-TIER and minikube-only — it is never run in CI.
# See ../README.md and _docs/22-load-balancing-service-mesh.md.
#
# Usage:
#   ./scripts/bootstrap.sh
#
# Env overrides:
#   MINIKUBE_PROFILE   minikube profile name (default: grpc-ch22)
#   K8S_VERSION        Kubernetes version for the node (default: v1.34.0 —
#                       inside Istio 1.31's officially supported 1.32-1.36
#                       range; re-check both matrices before bumping either)
#   ISTIO_VERSION       pinned upstream Istio release (default: 1.31.1)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="${ISTIOCTL_BIN_DIR:-$SCRIPT_DIR/.bin}"

MINIKUBE_PROFILE="${MINIKUBE_PROFILE:-grpc-ch22}"
K8S_VERSION="${K8S_VERSION:-v1.34.0}"
ISTIO_VERSION="${ISTIO_VERSION:-1.31.1}"
NAMESPACE="mesh-lb-demo"

# This example pins istioctl 1.31.1. A pre-installed `istioctl` on PATH is
# often a different version (whatever a prior project last downloaded), and
# `istioctl install` installs the control plane version EMBEDDED IN THE
# istioctl BINARY itself, not a version chosen by a --set flag — so the
# wrong binary silently installs the wrong Istio. Same self-contained-binary
# philosophy as examples/_lib/lib.sh's `ensure_grpcurl`, implemented locally
# here because that file is shared across every chapter and stays untouched.
ensure_istioctl() {
  if command -v istioctl >/dev/null 2>&1; then
    local on_path_version
    on_path_version="$(istioctl version --remote=false --short 2>/dev/null || true)"
    if [[ "$on_path_version" == "$ISTIO_VERSION" ]]; then
      echo "istioctl"
      return 0
    fi
    echo "    istioctl on PATH is ${on_path_version:-unknown}, not pinned ${ISTIO_VERSION} — downloading the pinned release" >&2
  fi

  local cached="$BIN_DIR/istioctl-$ISTIO_VERSION"
  if [[ -x "$cached" ]]; then
    echo "$cached"
    return 0
  fi

  mkdir -p "$BIN_DIR"
  local tmp
  tmp="$(mktemp -d)"
  curl -sSL -o "$tmp/istio.tar.gz" \
    "https://github.com/istio/istio/releases/download/${ISTIO_VERSION}/istio-${ISTIO_VERSION}-linux-amd64.tar.gz"
  tar -xzf "$tmp/istio.tar.gz" -C "$tmp"
  install -m 0755 "$tmp/istio-${ISTIO_VERSION}/bin/istioctl" "$cached"
  rm -rf "$tmp"
  echo "$cached"
}

ISTIOCTL_BIN="$(ensure_istioctl)"
echo "==> using istioctl: $("$ISTIOCTL_BIN" version --remote=false --short)"

echo "==> [1/4] minikube start (profile=${MINIKUBE_PROFILE}, kubernetes=${K8S_VERSION})"
if minikube -p "$MINIKUBE_PROFILE" status >/dev/null 2>&1; then
  echo "    profile ${MINIKUBE_PROFILE} is already running — skipping start (idempotent)"
else
  minikube start -p "$MINIKUBE_PROFILE" \
    --driver=docker \
    --container-runtime=containerd \
    --kubernetes-version="$K8S_VERSION" \
    --cpus=4 \
    --memory=6g
fi

echo "==> [2/4] istioctl install (context=${MINIKUBE_PROFILE}, pinned ${ISTIO_VERSION}, profile=demo)"
# The 'demo' Istio configuration profile (distinct from the minikube
# profile above) turns on access logging and a broader feature set than
# 'default' or 'minimal' — meant for exactly this kind of lab, never
# production. `istioctl install` is itself idempotent: re-running it
# against an already-installed revision reconciles in place, which is what
# makes this script safe to re-run after a transient failure.
"$ISTIOCTL_BIN" install --context="$MINIKUBE_PROFILE" -y --set profile=demo

echo "==> [3/4] demo namespace: create + label for sidecar injection"
kubectl --context "$MINIKUBE_PROFILE" create namespace "$NAMESPACE" \
  --dry-run=client -o yaml | kubectl --context "$MINIKUBE_PROFILE" apply -f -
# The label enables injection mesh-wide for this namespace; whether a given
# pod actually GETS a sidecar is still controlled per-pod by the
# sidecar.istio.io/inject annotation on its own template — see
# k8s/deployment.yaml and run-demo.sh's Istio phase.
kubectl --context "$MINIKUBE_PROFILE" label namespace "$NAMESPACE" \
  istio-injection=enabled --overwrite

echo "==> [4/4] recording installed versions (copy these into expected-output.md)"
echo "# Ch22 mesh-loadbalancing — bootstrap record, $(date -u +%FT%TZ)"
echo "minikube profile: ${MINIKUBE_PROFILE}"
minikube version
echo
echo "kubectl client/server:"
kubectl --context "$MINIKUBE_PROFILE" version
echo
echo "istioctl:"
"$ISTIOCTL_BIN" version --context="$MINIKUBE_PROFILE"

echo
echo "bootstrap complete. Next: ./scripts/run-demo.sh"
