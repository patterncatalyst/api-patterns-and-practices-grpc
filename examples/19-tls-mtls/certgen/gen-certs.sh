#!/bin/bash
# examples/19-tls-mtls/certgen/gen-certs.sh
#
# Runs once per `docker compose up` (see compose.yaml's `certgen` service and
# its `depends_on: condition: service_completed_successfully` on both
# servers) and writes these files fresh into the shared named volume `certs`:
#
#   ca.crt / ca.key           the local CA both server and client certs chain to
#   server.crt / server.key   ONE server identity, shared by both the quarkus
#                             and python services (its SAN list covers both)
#   client.crt / client.key   the mTLS client identity grpcurl presents
#   ca-truststore.jks         ca.crt repackaged as a Java keystore — see below
#
# Nothing here is committed or baked into the certgen IMAGE layer — this
# script only runs at container-run time, so every `docker compose up`
# mints a fresh CA and fresh leaf certs. ca.crt/client.crt/client.key are
# also copied to /host-out, a bind-mounted host directory (see
# compose.yaml), so verify.sh's host-side grpcurl process — the same
# self-contained binary examples/_lib/lib.sh downloads for every other
# chapter — can present them with plain `-cacert`/`-cert`/`-key` flags
# without needing root access to Docker's internal volume storage.
#
# ca-truststore.jks exists for one reason, confirmed empirically rather than
# assumed: the gRPC Java (separate-server) mode's SSL loader accepts a PEM
# file directly for `quarkus.grpc.server.ssl.certificate`/`.key`, but its
# `.trust-store` property always loads through Vert.x's KeyStoreHelper,
# which requires an actual Java keystore — handing it ca.crt fails with
# "Invalid keystore format". A PKCS12 trust-store built with openssl
# (`pkcs12 -export -nokeys`) doesn't work either: Java's PKIX validator
# loads it with ZERO trust anchors ("the trustAnchors parameter must be
# non-empty"), because that certificate-only PKCS12 entry isn't tagged the
# way Java's own PKCS12 KeyStore provider expects for a trusted-certificate
# entry. `keytool -importcert` (hence this image's java-21-openjdk-headless
# package, for keytool only — nothing else in this example touches Java on
# the Python side) builds a keystore Java actually recognizes.
# grpc.aio's `ssl_server_credentials` on the Python side has no such
# restriction and reads ca.crt directly.
set -euo pipefail

CERTS_DIR=/certs
HOST_OUT_DIR=/host-out
mkdir -p "$CERTS_DIR" "$HOST_OUT_DIR"
cd "$CERTS_DIR"

# Long validity (10 years) plus a ~1-day backdated notBefore absorbs clock
# skew between this container, the two server containers, and the host
# running grpcurl — none of them need to be perfectly synchronized for the
# chain to validate.
NOT_BEFORE="$(date -u -d '-1 day' +%Y%m%d%H%M%SZ)"
NOT_AFTER="$(date -u -d '+3650 days' +%Y%m%d%H%M%SZ)"
echo "certgen: notBefore=$NOT_BEFORE notAfter=$NOT_AFTER (openssl $(openssl version))"

# --- CA: a self-signed root, local to this example only ---------------------
openssl genrsa -out ca.key 4096
openssl req -x509 -new -key ca.key -sha256 \
  -subj "/O=PatternCatalyst/CN=ch19-tls-mtls example CA" \
  -not_before "$NOT_BEFORE" -not_after "$NOT_AFTER" \
  -out ca.crt

# --- server cert+key: ONE identity, shared by the quarkus and python services.
# SAN covers both in-container service names (so either server is a valid
# chain target when a client dials "quarkus" or "python" inside the compose
# network) plus localhost/127.0.0.1 (so grpcurl -servername can also present
# a host-published-port call as either name, since -servername is what's
# checked against this SAN list, not the socket address it actually dialed).
cat > server-ext.cnf <<'EOF'
subjectAltName = DNS:quarkus,DNS:python,DNS:localhost,IP:127.0.0.1
keyUsage = digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
EOF
openssl genrsa -out server.key 2048
openssl req -new -key server.key \
  -subj "/O=PatternCatalyst/CN=ch19-tls-mtls server" \
  -out server.csr
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -sha256 -not_before "$NOT_BEFORE" -not_after "$NOT_AFTER" \
  -extfile server-ext.cnf \
  -out server.crt

# --- client cert+key: the mTLS identity grpcurl presents with -cert/-key ----
cat > client-ext.cnf <<'EOF'
keyUsage = digitalSignature
extendedKeyUsage = clientAuth
EOF
openssl genrsa -out client.key 2048
openssl req -new -key client.key \
  -subj "/O=PatternCatalyst/CN=ch19-tls-mtls client" \
  -out client.csr
openssl x509 -req -in client.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -sha256 -not_before "$NOT_BEFORE" -not_after "$NOT_AFTER" \
  -extfile client-ext.cnf \
  -out client.crt

# --- ca-truststore.jks: ca.crt repackaged for Quarkus's gRPC Java server ---
# TRUSTSTORE_PASSWORD is not a secret; it exists only because a Java
# keystore always requires one to unlock the archive.
TRUSTSTORE_PASSWORD="changeit"
rm -f ca-truststore.jks
keytool -importcert -noprompt -alias ca -file ca.crt \
  -keystore ca-truststore.jks -storepass "$TRUSTSTORE_PASSWORD"

rm -f server.csr client.csr server-ext.cnf client-ext.cnf ca.srl

# World-readable: both server containers run as a non-root UID that needs to
# read these from the named volume, and the host user running verify.sh
# needs to read the /host-out copies below.
chmod 644 ca.key ca.crt server.key server.crt client.key client.crt ca-truststore.jks
chmod 755 "$CERTS_DIR"

cp ca.crt client.crt client.key "$HOST_OUT_DIR"/
chmod 644 "$HOST_OUT_DIR"/ca.crt "$HOST_OUT_DIR"/client.crt "$HOST_OUT_DIR"/client.key
chmod 755 "$HOST_OUT_DIR"

echo "certgen: wrote ca.{crt,key}, server.{crt,key}, client.{crt,key}, ca-truststore.jks to $CERTS_DIR"
echo "certgen: copied ca.crt, client.crt, client.key to $HOST_OUT_DIR for host-side grpcurl"
