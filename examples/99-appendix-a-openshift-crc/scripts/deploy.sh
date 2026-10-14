#!/usr/bin/env bash
#
# deploy.sh — build the GetQuote image inside OpenShift Local, install the
# Helm chart (workload + h2c/edge/passthrough Routes), bring up the Istio
# control plane, turn on STRICT mTLS + the weighted canary, and wire up
# OpenTelemetry Java-agent injection. Idempotent; safe to re-run.
#
#   ./scripts/deploy.sh
#
# Requires bootstrap.sh to have already installed the two operators.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

# Newest UBI with the newest JDK, exact tag (re-check:
# skopeo list-tags docker://registry.access.redhat.com/ubi10/openjdk-25).
BASE_JVM_IMAGE="${BASE_JVM_IMAGE:-registry.access.redhat.com/ubi10/openjdk-25:1.24-15}"

require_crc
command -v mvn >/dev/null 2>&1 || fail "mvn not on PATH"
command -v helm >/dev/null 2>&1 || fail "helm not on PATH"

step "1/7 Project"
oc get project "$NS" >/dev/null 2>&1 || oc new-project "$NS" >/dev/null || fail "oc new-project $NS"
oc project "$NS" >/dev/null
ok "project $NS"

step "2/7 Proto files (contracts/proto is the single source of truth)"
mkdir -p "$MAVEN_DIR/src/main/proto/shipping/type/v1" "$MAVEN_DIR/src/main/proto/shipping/quote/v1"
cp "$REPO_ROOT/contracts/proto/shipping/type/v1/types.proto" "$MAVEN_DIR/src/main/proto/shipping/type/v1/types.proto"
cp "$REPO_ROOT/contracts/proto/shipping/quote/v1/quote.proto" "$MAVEN_DIR/src/main/proto/shipping/quote/v1/quote.proto"
ok "copied types.proto + quote.proto into src/main/proto/"

step "3/7 In-cluster image build (binary S2I via quarkus-openshift)"
( cd "$MAVEN_DIR" && mvn -B -q package -DskipTests -Popenshift \
    -Dquarkus.container-image.build=true \
    -Dquarkus.container-image.tag="$IMAGE_TAG" \
    -Dquarkus.openshift.version="$IMAGE_TAG" \
    -Dquarkus.openshift.base-jvm-image="$BASE_JVM_IMAGE" \
    -Dquarkus.openshift.namespace="$NS" \
    -Dquarkus.kubernetes.deploy=false ) \
    || fail "Maven/S2I build failed (oc get builds -n $NS; oc logs build/<name> -n $NS)"
ref="$(oc get istag "getquote:$IMAGE_TAG" -n "$NS" -o jsonpath='{.image.dockerImageReference}' 2>/dev/null)" \
    || fail "no ImageStream tag getquote:$IMAGE_TAG"
ok "getquote:$IMAGE_TAG ${ref##*@}"

step "4/7 helm upgrade --install (workload + Routes)"
helm upgrade --install "$RELEASE" "$CHART_DIR" \
    --namespace "$NS" --kube-context "$OCP_CONTEXT" --reset-then-reuse-values \
    --set image.tag="$IMAGE_TAG" >/dev/null || fail "helm upgrade --install failed"
oc rollout status "deployment/getquote" -n "$NS" --timeout=300s >/dev/null || fail "getquote did not roll out"
ok "getquote Ready"

step "5/7 Istio control plane (OpenShift Service Mesh 3)"
oc apply -f "$EXAMPLE_DIR/mesh/istio.yaml" >/dev/null || fail "apply Istio/IstioCNI"
oc wait istiocni/default --for=condition=Ready --timeout=300s >/dev/null || fail "IstioCNI not Ready"
ok "IstioCNI Ready"
oc wait istio/default --for=condition=Ready --timeout=600s >/dev/null || fail "Istio not Ready"
ok "Istio $(oc get istio default -o jsonpath='{.spec.version}') Ready (revision $(oc get istio default -o jsonpath='{.status.activeRevisionName}'))"

step "6/7 OpenTelemetry collector + Instrumentation"
oc apply -n "$NS" -f "$EXAMPLE_DIR/mesh/otel-collector.yaml" >/dev/null || fail "apply otel-collector.yaml"
wait_for 300 "otelcol-collector deployment created" oc get deployment otelcol-collector -n "$NS"
oc rollout status deployment/otelcol-collector -n "$NS" --timeout=300s >/dev/null || fail "otelcol-collector not Ready"
ok "otelcol-collector Ready"

step "7/7 Sidecars, STRICT mTLS, canary, Java agent"
helm upgrade --install "$RELEASE" "$CHART_DIR" \
    --namespace "$NS" --kube-context "$OCP_CONTEXT" --reset-then-reuse-values \
    --set mesh.enabled=true --set mesh.canary.enabled=true --set observability.enabled=true >/dev/null \
    || fail "helm upgrade with mesh/canary/observability failed"
for d in deployment/getquote deployment/getquote-v2; do
    oc rollout status "$d" -n "$NS" --timeout=600s >/dev/null || fail "$d did not roll out (oc get pods -n $NS)"
done
# Helm creates the Deployments before the Instrumentation webhook always has
# a chance to fire on the same rollout; restart whichever is missing the
# agent init container.
for d in deployment/getquote deployment/getquote-v2; do
    pod="$(oc get pod -n "$NS" -l "app.kubernetes.io/name=getquote" --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)"
    [[ -z "$pod" ]] && continue
    oc get pod "$pod" -n "$NS" -o jsonpath='{.spec.initContainers[*].name}' | grep -q opentelemetry-auto-instrumentation \
        || oc rollout restart "$d" -n "$NS" >/dev/null
done
for d in deployment/getquote deployment/getquote-v2; do
    oc rollout status "$d" -n "$NS" --timeout=600s >/dev/null || fail "$d did not roll out after restart"
done
ok "mesh + canary + Java agent applied"

oc get pods -n "$NS" -o custom-columns='POD:.metadata.name,READY:.status.containerStatuses[*].ready,SCC:.metadata.annotations.openshift\.io/scc,VERSION:.metadata.labels.version'
oc get routes -n "$NS" -o custom-columns='ROUTE:.metadata.name,HOST:.spec.host,TERMINATION:.spec.tls.termination'
