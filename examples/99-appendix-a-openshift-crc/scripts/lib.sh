# shellcheck shell=bash
# lib.sh — shared helpers for this example's bootstrap/deploy/teardown
# scripts (sourced, not run). Scoped to examples/99-appendix-a-openshift-crc
# only; unrelated to examples/_lib/lib.sh, which the clusterless (compose)
# examples use.
#
# Every script talks to OpenShift Local through the "crc-admin" kubeconfig
# context `crc start` writes, so no password is ever typed, printed, or
# stored. Run `eval "$(crc oc-env)"` first if `oc` is not on PATH.

PROJECT="appendix-a-grpc"
NS="${PROJECT_NAMESPACE:-$PROJECT}"
RELEASE="${RELEASE:-getquote}"
OCP_CONTEXT="${OCP_CONTEXT:-crc-admin}"
SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXAMPLE_DIR="$(cd "$SCRIPTS_DIR/.." && pwd)"
REPO_ROOT="$(cd "$EXAMPLE_DIR/../.." && pwd)"
CHART_DIR="$EXAMPLE_DIR/helm"
MAVEN_DIR="$EXAMPLE_DIR/quarkus"
IMAGE_TAG="${IMAGE_TAG:-v1}"

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
ok()   { printf '    \xe2\x9c\x93 %s\n' "$1"; }
warn() { printf '    ! %s\n' "$1" >&2; }
fail() { printf '\n\xe2\x9c\x97 %s\n' "$1" >&2; exit 1; }

# require_crc: oc/crc/jq on PATH, the crc-admin context reachable, and the
# API server is OpenShift Local's. Fails fast instead of touching another
# cluster.
require_crc() {
    command -v oc >/dev/null 2>&1 || fail "oc not on PATH: run eval \"\$(crc oc-env)\""
    command -v crc >/dev/null 2>&1 || fail "crc not on PATH"
    command -v jq >/dev/null 2>&1 || fail "jq not on PATH"
    crc status 2>/dev/null | grep -q 'OpenShift:.*Running' || fail "OpenShift Local is not running: crc start"
    oc config use-context "$OCP_CONTEXT" >/dev/null 2>&1 \
        || fail "kubeconfig context $OCP_CONTEXT not found (crc start writes it)"
    local api
    api="$(oc whoami --show-server 2>/dev/null)" || fail "cannot reach the OpenShift API"
    [[ "$api" == *api.crc.testing* ]] || fail "context $OCP_CONTEXT points at $api, not OpenShift Local"
}

# wait_for <seconds> <description> <command...>: poll every 5s until the
# command succeeds.
wait_for() {
    local timeout="$1" what="$2"; shift 2
    local waited=0
    until "$@" >/dev/null 2>&1; do
        (( waited >= timeout )) && fail "timed out after ${timeout}s waiting for $what"
        sleep 5; waited=$(( waited + 5 ))
    done
    ok "$what"
}

# install_operator <manifest> <namespace> <package> <csv>
# Applies an OLM manifest (Namespace + OperatorGroup + Subscription) whose
# Subscription pins <csv> with installPlanApproval: Manual and startingCSV,
# approves only the InstallPlan that lists <csv>, and waits for the CSV to
# succeed. Idempotent.
install_operator() {
    local manifest="$1" ns="$2" pkg="$3" csv="$4"
    _csv_ok() { [[ "$(oc get csv "$csv" -n "$ns" -o jsonpath='{.status.phase}' 2>/dev/null)" == Succeeded ]]; }
    _plan() {
        oc get installplan -n "$ns" -o json 2>/dev/null | jq -r --arg c "$csv" \
            '.items[] | select(.spec.clusterServiceVersionNames | index($c)) | .metadata.name' | head -1
    }
    _plan_proposed() { [[ -n "$(_plan)" ]]; }
    if _csv_ok; then ok "$csv already Succeeded"; return 0; fi
    # redhat-operators can report READY before it serves packages, briefly,
    # right after crc start — wait for the package itself, not the catalog.
    wait_for 300 "OperatorHub serves $pkg" oc get packagemanifest "$pkg" -n openshift-marketplace
    oc apply -f "$manifest" >/dev/null || fail "apply $manifest"
    wait_for 300 "InstallPlan for $csv proposed" _plan_proposed
    oc patch installplan "$(_plan)" -n "$ns" --type merge -p '{"spec":{"approved":true}}' >/dev/null \
        || fail "approve InstallPlan for $csv"
    wait_for 600 "$csv Succeeded" _csv_ok
}
