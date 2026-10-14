package com.patterncatalyst.appendixa.getquote;

/**
 * The pod-identity convention from examples/22-mesh-loadbalancing: Kubernetes
 * sets HOSTNAME to the pod's own name for every container by default, so no
 * Downward API plumbing is needed to read it.
 */
final class PodIdentity {
    static final String NAME = System.getenv().getOrDefault("HOSTNAME", "unknown");

    private PodIdentity() {
    }
}
