#!/usr/bin/env bash
# Final Project minikube subtree — one-time (and idempotent) cluster
# bootstrap: start minikube, install Istio's control plane, and prepare the
# demo namespace. Run once per session; scripts/run-demo.sh does everything
# that changes between phases of the actual demo.
#
# This subtree is CLUSTER-TIER and minikube-only — it is never run in CI
# (the top-level ../verify.sh is the CI-gated Compose tier; this one isn't
# named verify.sh anywhere in this directory, by design). See ../README.md
# and _docs/27-complete-project.md.
#
# Defaults to its OWN minikube profile (grpc-ch27), distinct from Chapter
# 22's grpc-ch22, since both chapters' clusters can coexist (a reader may
# still have Chapter 22 up) and this subtree deploys into its own namespace
# (final-project-demo, see ../k8s/namespace.yaml) regardless. Set
# MINIKUBE_PROFILE=grpc-ch22 to reuse Chapter 22's cluster + Istio control
# plane instead, if one is already running.
#
# Usage:
#   ./scripts/bootstrap.sh
#
# Env overrides:
#   MINIKUBE_PROFILE   minikube profile name (default: grpc-ch27)
#   K8S_VERSION        Kubernetes version for the node (default: v1.34.0)
#   ISTIO_VERSION      pinned upstream Istio release (default: 1.31.1)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="${ISTIOCTL_BIN_DIR:-$SCRIPT_DIR/.bin}"

MINIKUBE_PROFILE="${MINIKUBE_PROFILE:-grpc-ch27}"
K8S_VERSION="${K8S_VERSION:-v1.34.0}"
ISTIO_VERSION="${ISTIO_VERSION:-1.31.1}"
NAMESPACE="final-project-demo"

# Same self-contained-binary philosophy as examples/_lib/lib.sh's
# ensure_grpcurl, implemented locally here (that file is shared across every
# chapter and stays untouched) — a pre-installed `istioctl` on PATH is often
# a different version than the one this subtree pins.
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
# Idempotent: re-running against an already-installed revision (e.g. because
# Chapter 22 installed it first on this same profile) reconciles in place.
"$ISTIOCTL_BIN" install --context="$MINIKUBE_PROFILE" -y --set profile=demo

echo "==> [3/4] demo namespace: create + label for sidecar injection"
kubectl --context "$MINIKUBE_PROFILE" create namespace "$NAMESPACE" \
  --dry-run=client -o yaml | kubectl --context "$MINIKUBE_PROFILE" apply -f -
kubectl --context "$MINIKUBE_PROFILE" label namespace "$NAMESPACE" \
  istio-injection=enabled --overwrite

echo "==> [4/4] recording installed versions (copy these into expected-output.md)"
echo "# Final Project minikube subtree — bootstrap record, $(date -u +%FT%TZ)"
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
