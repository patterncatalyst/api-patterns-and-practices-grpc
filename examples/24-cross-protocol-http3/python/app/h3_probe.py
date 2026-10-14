"""Ch24 cross-protocol-http3 — a deterministic HTTP/3-over-QUIC transport
probe, using aioquic.

This proves HTTP/3 the transport. It does not prove gRPC-over-HTTP/3 — there
is no gRPC call anywhere in this module. It connects to the `caddy` service
in this chapter's compose stack (a plain static-file server, see
../caddy/Caddyfile), completes a real QUIC handshake negotiating the `h3`
ALPN, issues one HTTP/3 GET for a small JSON document, and checks for a
completed handshake plus an HTTP 200. grpc-java and grpcio have no
gRPC-over-HTTP/3 transport to exercise as of this writing (see the chapter
prose) — this script exists to show the transport itself working, completely
independent of either `RoutingService` server in this stack.

Certificate verification is disabled (`verify_mode=ssl.CERT_NONE`): Caddy's
`tls internal` directive mints a fresh, container-local self-signed CA on
every start, and distributing that CA to this probe adds machinery that
teaches nothing new — Ch19/Ch20 already cover TLS trust chains and mutual
authentication in depth. This script is a transport probe, not a security
demo.

Usage:
    python -m app.h3_probe <host> <port> [--path /transport.json] [--timeout 10]

Prints one line to stdout — PROBE_OK or PROBE_FAIL — after a diagnostic line
on stderr, and exits 0 on success, 1 on any failure (a dropped handshake, a
timeout, a non-200 status). verify.sh treats a non-zero exit from this script
as a SKIP, not a build failure — see the chapter prose and verify.sh's
run_h3_probe for exactly how.
"""
from __future__ import annotations

import argparse
import asyncio
import ssl
import sys
from typing import cast

from aioquic.asyncio import connect
from aioquic.asyncio.protocol import QuicConnectionProtocol
from aioquic.h3.connection import H3_ALPN, H3Connection
from aioquic.h3.events import DataReceived, H3Event, HeadersReceived
from aioquic.quic.configuration import QuicConfiguration
from aioquic.quic.events import HandshakeCompleted, QuicEvent


class H3ProbeProtocol(QuicConnectionProtocol):
    """Drives exactly one HTTP/3 GET request over an aioquic connection and
    records whether the QUIC handshake completed and what came back."""

    def __init__(self, *args: object, **kwargs: object) -> None:
        super().__init__(*args, **kwargs)  # type: ignore[arg-type]
        self._http = H3Connection(self._quic)
        self._response_done = asyncio.Event()
        self.handshake_completed = False
        self.status: int | None = None
        self.body = bytearray()

    def quic_event_received(self, event: QuicEvent) -> None:
        if isinstance(event, HandshakeCompleted):
            self.handshake_completed = True
        for http_event in self._http.handle_event(event):
            self._h3_event_received(http_event)

    def _h3_event_received(self, event: H3Event) -> None:
        if isinstance(event, HeadersReceived):
            for name, value in event.headers:
                if name == b":status":
                    self.status = int(value)
        elif isinstance(event, DataReceived):
            self.body.extend(event.data)
        if isinstance(event, (HeadersReceived, DataReceived)) and event.stream_ended:
            self._response_done.set()

    async def get(self, authority: str, path: str, timeout: float) -> None:
        stream_id = self._quic.get_next_available_stream_id()
        self._http.send_headers(
            stream_id=stream_id,
            headers=[
                (b":method", b"GET"),
                (b":scheme", b"https"),
                (b":authority", authority.encode()),
                (b":path", path.encode()),
            ],
            end_stream=True,
        )
        self.transmit()
        await asyncio.wait_for(self._response_done.wait(), timeout=timeout)


async def probe(host: str, port: int, path: str, timeout: float) -> int:
    configuration = QuicConfiguration(alpn_protocols=H3_ALPN, is_client=True)
    # Demo-only: see the module docstring for why verification is off here.
    configuration.verify_mode = ssl.CERT_NONE

    try:
        async with connect(
            host, port, configuration=configuration, create_protocol=H3ProbeProtocol
        ) as protocol:
            probe_protocol = cast(H3ProbeProtocol, protocol)
            await probe_protocol.get(f"{host}:{port}", path, timeout)
    except (OSError, asyncio.TimeoutError, ConnectionError) as exc:
        print(f"h3_probe: FAIL — could not complete an HTTP/3 request to {host}:{port}: {exc}", file=sys.stderr)
        print("PROBE_FAIL")
        return 1

    handshake_ok = probe_protocol.handshake_completed
    status = probe_protocol.status
    body = bytes(probe_protocol.body).decode("utf-8", errors="replace")
    print(
        f"h3_probe: QUIC handshake_completed={handshake_ok} alpn=h3 "
        f"status={status} body={body!r}",
        file=sys.stderr,
    )
    if handshake_ok and status == 200:
        print(
            "h3_probe: HTTP/3 transport confirmed over QUIC — this is the transport, "
            "not gRPC-over-HTTP/3 (no gRPC call was made)",
            file=sys.stderr,
        )
        print("PROBE_OK")
        return 0

    print("h3_probe: FAIL — handshake or status check did not pass", file=sys.stderr)
    print("PROBE_FAIL")
    return 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("host")
    parser.add_argument("port", type=int)
    parser.add_argument("--path", default="/transport.json")
    parser.add_argument("--timeout", type=float, default=10.0)
    args = parser.parse_args()
    return asyncio.run(probe(args.host, args.port, args.path, args.timeout))


if __name__ == "__main__":
    sys.exit(main())
