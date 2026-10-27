import socket

import pytest


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    """테스트는 mock 공급자만 쓴다. 실제 연결·DNS를 시도하면 바로 실패한다(OSError가 아니라 폴백으로 묻히지 않음)."""
    def deny(*_a, **_k):
        raise RuntimeError("테스트에서 네트워크 금지")

    monkeypatch.setattr(socket.socket, "connect", deny)
    monkeypatch.setattr(socket.socket, "connect_ex", deny)
    monkeypatch.setattr(socket, "getaddrinfo", deny)
