#!/bin/bash
# examples/27-complete-project/certgen/gen-certs.sh
#
# Byte-for-byte the Ch19 tls-mtls certgen script (see that chapter's
# ../19-tls-mtls/certgen/gen-certs.sh for the full rationale) — this example
# reuses the identical CA/server/client identity shape rather than reinventing
# it, because mTLS is a supporting concern here, not the subject. Runs once
# per `docker compose up` and writes these files fresh into the shared named
# volume `certs`:
#
#   ca.crt / ca.key           the local CA both server and client certs chain to
#   server.crt / server.key   ONE server identity, shared by both the quarkus
#                             and python services (its SAN list covers both)
#   client.crt / client.key   the mTLS client identity grpcurl AND each
#                             stack's own internal (Booking->Routing,
#                             Routing->Quote) loopback gRPC clients present
#   ca-truststore.jks         ca.crt repackaged as a Java keystore (the
#                             Quarkus gRPC Java server's trust-store format)
#
# Nothing here is committed or baked into the certgen IMAGE layer — every
# `docker compose up`/`verify.sh` run mints a fresh CA and fresh leaf certs.
# ca.crt/client.crt/client.key are also copied to /host-out, a bind-mounted
# host directory (see compose.yaml), so verify.sh's host-side grpcurl and ghz
# can present them with plain -cacert/-cert/-key flags.
set -euo pipefail

CERTS_DIR=/certs
HOST_OUT_DIR=/host-out
mkdir -p "$CERTS_DIR" "$HOST_OUT_DIR"
cd "$CERTS_DIR"

NOT_BEFORE="$(date -u -d '-1 day' +%Y%m%d%H%M%SZ)"
NOT_AFTER="$(date -u -d '+3650 days' +%Y%m%d%H%M%SZ)"
echo "certgen: notBefore=$NOT_BEFORE notAfter=$NOT_AFTER (openssl $(openssl version))"

# --- CA: a self-signed root, local to this example only ---------------------
openssl genrsa -out ca.key 4096
openssl req -x509 -new -key ca.key -sha256 \
  -subj "/O=PatternCatalyst/CN=ch27-final-project example CA" \
  -not_before "$NOT_BEFORE" -not_after "$NOT_AFTER" \
  -out ca.crt

# --- server cert+key: ONE identity, shared by the quarkus and python services.
cat > server-ext.cnf <<'EOF'
subjectAltName = DNS:quarkus,DNS:python,DNS:localhost,IP:127.0.0.1
keyUsage = digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
EOF
openssl genrsa -out server.key 2048
openssl req -new -key server.key \
  -subj "/O=PatternCatalyst/CN=ch27-final-project server" \
  -out server.csr
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -sha256 -not_before "$NOT_BEFORE" -not_after "$NOT_AFTER" \
  -extfile server-ext.cnf \
  -out server.crt

# --- client cert+key: presented by grpcurl/ghz AND by each stack's own
# internal loopback gRPC clients (Booking->Routing, Routing->Quote) — one
# identity for every caller of this port, demo-simple on purpose.
cat > client-ext.cnf <<'EOF'
keyUsage = digitalSignature
extendedKeyUsage = clientAuth
EOF
openssl genrsa -out client.key 2048
openssl req -new -key client.key \
  -subj "/O=PatternCatalyst/CN=ch27-final-project client" \
  -out client.csr
openssl x509 -req -in client.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -sha256 -not_before "$NOT_BEFORE" -not_after "$NOT_AFTER" \
  -extfile client-ext.cnf \
  -out client.crt

# --- ca-truststore.jks: ca.crt repackaged for Quarkus's gRPC Java server ---
TRUSTSTORE_PASSWORD="changeit"
rm -f ca-truststore.jks
keytool -importcert -noprompt -alias ca -file ca.crt \
  -keystore ca-truststore.jks -storepass "$TRUSTSTORE_PASSWORD"

rm -f server.csr client.csr server-ext.cnf client-ext.cnf ca.srl

chmod 644 ca.key ca.crt server.key server.crt client.key client.crt ca-truststore.jks
chmod 755 "$CERTS_DIR"

cp ca.crt client.crt client.key "$HOST_OUT_DIR"/
chmod 644 "$HOST_OUT_DIR"/ca.crt "$HOST_OUT_DIR"/client.crt "$HOST_OUT_DIR"/client.key
chmod 755 "$HOST_OUT_DIR"

echo "certgen: wrote ca.{crt,key}, server.{crt,key}, client.{crt,key}, ca-truststore.jks to $CERTS_DIR"
echo "certgen: copied ca.crt, client.crt, client.key to $HOST_OUT_DIR for host-side grpcurl/ghz"
