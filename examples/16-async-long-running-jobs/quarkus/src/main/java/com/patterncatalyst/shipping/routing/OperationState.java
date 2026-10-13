package com.patterncatalyst.shipping.routing;

import shipping.type.v1.Types;

/**
 * One server-owned {@code Operation} record, mutated in place by the
 * background job thread and read by {@code GetOperation}/{@code
 * WatchOperation}, and terminated early by {@code CancelOperation}. All
 * mutation goes through the {@code synchronized} methods below so the
 * background job and a concurrent cancel can never both decide they own the
 * terminal transition.
 */
final class OperationState {

    final String id;
    final String kind;

    private volatile boolean done;
    private volatile int progressPct;
    private volatile String message;

    OperationState(String id, String kind) {
        this.id = id;
        this.kind = kind;
        this.message = "started";
    }

    /** Cheap, lock-free read the background job polls between steps. */
    boolean isDone() {
        return done;
    }

    /** Immutable point-in-time view handed back on every RPC. */
    synchronized Types.Operation snapshot() {
        return Types.Operation.newBuilder()
                .setId(id)
                .setKind(kind)
                .setDone(done)
                .setProgressPct(progressPct)
                .setMessage(message)
                .build();
    }

    /** Called by the background job between steps; a no-op once terminal. */
    synchronized void advance(int pct, String msg) {
        if (done) {
            return; // cancelled (or otherwise terminated) underneath the job; ignore the late update
        }
        this.progressPct = pct;
        this.message = msg;
    }

    /** Called by the background job on its last step; a no-op once terminal. */
    synchronized void complete(String msg) {
        if (done) {
            return;
        }
        this.done = true;
        this.progressPct = 100;
        this.message = msg;
    }

    /**
     * Called by {@code CancelOperation}. Returns {@code true} if this call is
     * the one that moved the operation to terminal; {@code false} if it was
     * already done (the cancel arrived too late, or twice).
     */
    synchronized boolean cancel() {
        if (done) {
            return false;
        }
        this.done = true;
        this.message = "operation cancelled by client request at " + progressPct + "% progress";
        return true;
    }
}
