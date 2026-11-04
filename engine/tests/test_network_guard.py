"""Windows asyncio의 내부 socketpair만 허용하고 실제 네트워크 차단은 유지한다."""
import asyncio
import socket

import pytest


def test_event_loop_can_create_internal_socketpair():
    async def body():
        await asyncio.sleep(0)
        return "ok"

    assert asyncio.run(body()) == "ok"


def test_socketpair_does_not_leave_tcp_or_dns_allowed():
    a, b = socket.socketpair()
    try:
        a.send(b"x")
        assert b.recv(1) == b"x"
    finally:
        a.close()
        b.close()

    with socket.socket() as sock:
        for connect in (sock.connect, sock.connect_ex):
            with pytest.raises(RuntimeError, match="네트워크 금지"):
                connect(("127.0.0.1", 1))
    with pytest.raises(RuntimeError, match="네트워크 금지"):
        socket.getaddrinfo("example.com", 443)
