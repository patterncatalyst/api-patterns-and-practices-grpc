#!/usr/bin/env bash
#
# bootstrap.sh — start OpenShift Local (CRC) and install the two operators
# this appendix needs: OpenShift Service Mesh 3 (Sail) and the Red Hat
# build of OpenTelemetry. Both are pinned with installPlanApproval: Manual
# and an exact startingCSV; only the InstallPlan naming that CSV is
# approved (scripts/lib.sh's install_operator).
#
#   ./scripts/bootstrap.sh
#
# Does NOT create the project/namespace or deploy anything — that is
# deploy.sh. CRC is sized for the platform tier (12 vCPU / 32 GiB); sizing
# only takes effect while CRC is stopped.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

command -v crc >/dev/null 2>&1 || fail "crc not on PATH"

step "1/3 CRC sizing and start"
cpu="$(crc config get cpus 2>/dev/null | awk '{print $NF}')"
mem="$(crc config get memory 2>/dev/null | awk '{print $NF}')"
if [[ "$cpu" =~ ^[0-9]+$ && "$mem" =~ ^[0-9]+$ ]] && (( cpu < 12 || mem < 32768 )); then
    fail "CRC is sized ${cpu} vCPU / ${mem} MiB; OSSM + OpenTelemetry need at least 12 / 32768: crc stop; crc config set cpus 12; crc config set memory 32768; crc start"
fi
if crc status 2>/dev/null | grep -q 'OpenShift:.*Running'; then
    ok "OpenShift Local already running"
else
    crc start || fail "crc start failed"
fi
eval "$(crc oc-env)"
require_crc
ok "API: $(oc whoami --show-server)"

step "2/3 OpenShift Service Mesh 3 (Sail)"
# Re-check before a real run: oc get packagemanifest servicemeshoperator3
# -n openshift-marketplace -o jsonpath='{range .status.channels[*]}{.name}
# {"  "}{.currentCSV}{"\n"}{end}'
install_operator "$EXAMPLE_DIR/mesh/subscriptions/servicemesh.yaml" openshift-operators \
    servicemeshoperator3 servicemeshoperator3.v3.4.3

step "3/3 Red Hat build of OpenTelemetry"
# Re-check before a real run: oc get packagemanifest opentelemetry-product
# -n openshift-marketplace -o jsonpath='{range .status.channels[*]}{.name}
# {"  "}{.currentCSV}{"\n"}{end}'
install_operator "$EXAMPLE_DIR/mesh/subscriptions/opentelemetry.yaml" openshift-opentelemetry-operator \
    opentelemetry-product opentelemetry-operator.v0.158.0-3

ok "bootstrap complete — run ./scripts/deploy.sh next"
