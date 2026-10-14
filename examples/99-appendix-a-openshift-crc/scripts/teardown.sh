#!/usr/bin/env bash
#
# teardown.sh — return OpenShift Local to a clean state, then stop it.
#
# This CRC is dedicated to appendix-a-grpc while it runs. Teardown removes,
# in order (custom resources go while their operator still runs, so no
# finalizer is left waiting on an operator that is already gone):
#   1. the Helm release (workload, Routes, STRICT mTLS, canary) and the
#      OpenTelemetryCollector/Instrumentation, while the OTel operator can
#      still clear their finalizers;
#   2. the appendix-a-grpc project (takes the Build/BuildConfig/ImageStream
#      and the in-cluster image with it);
#   3. the Istio/IstioCNI control plane;
#   4. both operators: Subscription, CSV, InstallPlans, and the CRDs each
#      CSV owns;
#   5. leftover CRDs no CSV owns (Istio's, created by the Sail operator);
#   6. the two operator namespaces (istio-system, istio-cni,
#      openshift-opentelemetry-operator).
#
#   ./scripts/teardown.sh                 # clean up, then crc stop
#   ./scripts/teardown.sh --keep-running  # clean up, leave CRC running
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

KEEP_RUNNING=false
[[ "${1:-}" == "--keep-running" ]] && KEEP_RUNNING=true

require_crc
gone() { ! oc get "$@" >/dev/null 2>&1; }
has_crd() { oc get crd "$1" >/dev/null 2>&1; }

OPERATORS=(
    "openshift-opentelemetry-operator opentelemetry-product"
    "openshift-operators servicemeshoperator3"
)
OPERATOR_NAMESPACES=(openshift-opentelemetry-operator istio-system istio-cni)
PLATFORM_CRDS='\.(istio\.io|sailoperator\.io|opentelemetry\.io)$'

step "1/6 Workload and OpenTelemetry CRs"
if has_crd opentelemetrycollectors.opentelemetry.io && oc get project "$NS" >/dev/null 2>&1; then
    oc delete opentelemetrycollector,instrumentation --all -n "$NS" --wait=true --timeout=120s >/dev/null 2>&1
fi
if helm status "$RELEASE" -n "$NS" --kube-context "$OCP_CONTEXT" >/dev/null 2>&1; then
    helm uninstall "$RELEASE" -n "$NS" --kube-context "$OCP_CONTEXT" --wait >/dev/null || fail "helm uninstall"
    ok "release $RELEASE uninstalled"
else
    ok "no release"
fi

step "2/6 Project $NS"
if oc get project "$NS" >/dev/null 2>&1; then
    oc delete project "$NS" --wait=false >/dev/null || fail "delete project"
    wait_for 600 "project $NS deleted" gone namespace "$NS"
else
    ok "no project"
fi

step "3/6 Istio control plane"
has_crd istios.sailoperator.io && oc delete istio --all --wait=true --timeout=300s >/dev/null 2>&1
has_crd istiocnis.sailoperator.io && oc delete istiocni --all --wait=true --timeout=300s >/dev/null 2>&1
ok "Istio and IstioCNI removed"

step "4/6 Operators"
for entry in "${OPERATORS[@]}"; do
    read -r ns sub <<<"$entry"
    csv="$(oc get subscriptions.operators.coreos.com "$sub" -n "$ns" -o jsonpath='{.status.installedCSV}' 2>/dev/null)"
    oc delete subscriptions.operators.coreos.com "$sub" -n "$ns" --ignore-not-found >/dev/null
    if [[ -z "$csv" ]]; then
        ok "$sub: no Subscription"
        continue
    fi
    owned="$(oc get csv "$csv" -n "$ns" -o jsonpath='{range .spec.customresourcedefinitions.owned[*]}{.name}{"\n"}{end}' 2>/dev/null)"
    oc delete csv "$csv" -n "$ns" --wait=true >/dev/null 2>&1
    for ip in $(oc get installplan -n "$ns" -o json 2>/dev/null | jq -r --arg c "$csv" '.items[] | select(.spec.clusterServiceVersionNames | index($c)) | .metadata.name'); do
        oc delete installplan "$ip" -n "$ns" >/dev/null 2>&1
    done
    # shellcheck disable=SC2086
    [[ -n "$owned" ]] && oc delete crd $owned --ignore-not-found --wait=true >/dev/null 2>&1
    ok "$csv removed with $(wc -w <<<"$owned") CRD(s)"
done

step "5/6 Remaining CRDs"
crds="$(oc get crd -o name | grep -E "$PLATFORM_CRDS")"
# shellcheck disable=SC2086
[[ -n "$crds" ]] && oc delete $crds --wait=true >/dev/null 2>&1
ok "no appendix-a platform CRDs left"

step "6/6 Operator namespaces"
for ns in "${OPERATOR_NAMESPACES[@]}"; do
    if oc get namespace "$ns" >/dev/null 2>&1; then
        oc delete namespace "$ns" --wait=false >/dev/null
        wait_for 300 "namespace $ns deleted" gone namespace "$ns"
    fi
done

leftover="$(
    oc get subscriptions.operators.coreos.com -A --no-headers 2>/dev/null | grep -E 'servicemeshoperator3|opentelemetry-product'
    oc get ns --no-headers -o name 2>/dev/null | grep -E '^namespace/(appendix-a-grpc|istio-system|istio-cni|openshift-opentelemetry-operator)$'
    oc get crd -o name 2>/dev/null | grep -E "$PLATFORM_CRDS"
)"
if [[ -z "$leftover" ]]; then
    ok "appendix-a-grpc is clean"
else
    printf '    note: still present:\n%s\n' "$leftover"
fi

if [[ "$KEEP_RUNNING" == false ]]; then
    step "crc stop"
    crc stop >/dev/null 2>&1 && ok "OpenShift Local stopped" || fail "crc stop"
fi
