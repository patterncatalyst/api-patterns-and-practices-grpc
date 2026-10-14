#!/usr/bin/env bash
# Final Project minikube subtree — tear down the demo.
#
# By default this removes only what run-demo.sh and bootstrap.sh created in
# the cluster (the final-project-demo namespace and its Jobs/Deployment/
# Services, plus the three Istio custom resources) and leaves the Istio
# control plane and the minikube profile itself running — important if
# MINIKUBE_PROFILE was overridden to the shared grpc-ch22 profile, since
# Chapter 22's own demo may still depend on that control plane. Pass --full
# to also uninstall Istio and delete the minikube profile entirely.
#
# Usage:
#   ./scripts/teardown.sh         # namespace + Istio CRs only
#   ./scripts/teardown.sh --full  # + istioctl uninstall + minikube delete
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXAMPLE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

MINIKUBE_PROFILE="${MINIKUBE_PROFILE:-grpc-ch27}"
NAMESPACE="final-project-demo"
MODE="${1:-}"

ISTIO_VERSION="${ISTIO_VERSION:-1.31.1}"
ISTIOCTL="$SCRIPT_DIR/.bin/istioctl-$ISTIO_VERSION"
[[ -x "$ISTIOCTL" ]] || ISTIOCTL="istioctl"

echo "==> deleting Istio custom resources (PeerAuthentication, DestinationRule, VirtualService)"
kubectl --context "$MINIKUBE_PROFILE" delete -f "$EXAMPLE_DIR/istio" --ignore-not-found

echo "==> deleting the demo namespace (Deployment, Services, any load-client Jobs)"
kubectl --context "$MINIKUBE_PROFILE" delete namespace "$NAMESPACE" --ignore-not-found --wait=true

if [[ "$MODE" == "--full" ]]; then
  echo "==> --full: uninstalling Istio"
  "$ISTIOCTL" uninstall --context="$MINIKUBE_PROFILE" --purge -y || true
  kubectl --context "$MINIKUBE_PROFILE" delete namespace istio-system --ignore-not-found --wait=true || true

  echo "==> --full: deleting minikube profile ${MINIKUBE_PROFILE}"
  minikube delete -p "$MINIKUBE_PROFILE"
else
  echo "    (Istio control plane and the minikube profile were left running —"
  echo "     pass --full to remove those too)"
fi

echo "teardown complete."
