package com.patterncatalyst.shipping.routing;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * Ch15 backend-io-concurrency ANCHOR — the ~400ms simulated blocking DB+file
 * I/O step every {@code FindOptimalRoute} call performs identically, in
 * every execution model. Only WHERE this runs (the default gRPC worker
 * pool, the Vert.x event loop, or a virtual thread — see
 * {@link RoutingServiceImpl}) changes between this chapter's three modes;
 * the work itself never does.
 */
final class PricingCache {

    private PricingCache() {
    }

    /** A matched row from the bundled cache file. */
    record Entry(String routeId, String carrier, String originCode, String destCode, String priceAmount) {
    }

    private static final int DB_DELAY_MS = 200;
    private static final int STORAGE_DELAY_MS = 200;
    private static final String RESOURCE_PATH = "/pricing-cache.txt";

    /**
     * Looks up {@code originCode -> destCode} by doing the blocking work
     * this chapter measures: a {@link #sleep} standing in for a database
     * round trip, then a real blocking read of the bundled cache file
     * ({@link #readEntries}), padded with a second {@link #sleep} standing
     * in for a slow, network-attached store. The two sleeps are what make
     * the total land near 400ms on any machine; the file read itself
     * typically finishes in microseconds from a local classpath resource —
     * naming both delays explicitly, rather than hiding them in one
     * {@code sleep(400)}, keeps the "DB hop" and "storage hop" shapes this
     * chapter's prose refers to visible in the code, matching how a real
     * two-dependency lookup would actually be structured. Falls back to the
     * cache's first row when no exact origin/destination match exists — a
     * simplification: this demo's subject is WHERE the blocking work runs,
     * not route-matching logic.
     */
    static Entry lookup(String originCode, String destCode) {
        sleep(DB_DELAY_MS);
        List<Entry> entries = readEntries();
        sleep(STORAGE_DELAY_MS);
        return entries.stream()
                .filter(e -> e.originCode().equals(originCode) && e.destCode().equals(destCode))
                .findFirst()
                .orElse(entries.get(0));
    }

    private static List<Entry> readEntries() {
        List<Entry> entries = new ArrayList<>();
        try (InputStream in = PricingCache.class.getResourceAsStream(RESOURCE_PATH)) {
            if (in == null) {
                throw new IllegalStateException("pricing cache resource not found: " + RESOURCE_PATH);
            }
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    line = line.strip();
                    if (line.isEmpty() || line.startsWith("#")) {
                        continue;
                    }
                    String[] parts = line.split(",");
                    entries.add(new Entry(parts[0], parts[1], parts[2], parts[3], parts[4]));
                }
            }
        } catch (IOException e) {
            throw new UncheckedIOException("failed reading pricing cache: " + RESOURCE_PATH, e);
        }
        return entries;
    }

    private static void sleep(int millis) {
        try {
            Thread.sleep(millis);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("interrupted while simulating blocking I/O", e);
        }
    }
}
