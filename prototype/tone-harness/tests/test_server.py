"""채팅 서버 흐름 테스트 (mock 모델). 입력 중 힌트가 보낸 사람에게만 가는지, 털어놓기가 받은 메시지에만 되는지 본다."""
import pytest
from fastapi.testclient import TestClient

from server.app import create_app


@pytest.fixture()
def client(tmp_path):
    app = create_app(db_path=tmp_path / "chat.db", store_path=tmp_path / "patterns.json", force_mock=True)
    with TestClient(app) as c:
        yield c


def test_hint_goes_only_to_sender_and_message_to_both(client):
    with client.websocket_connect("/ws/minsu") as minsu, client.websocket_connect("/ws/jieun") as jieun:
        jieun.send_json({"type": "send", "room_id": "minsu-jieun",
                         "text": "민수님 이번 주만 마감 하루 미뤄도 될까요? 집에 일이 생겨서요"})
        assert minsu.receive_json()["type"] == "message"
        assert jieun.receive_json()["type"] == "message"

        minsu.send_json({"type": "draft", "room_id": "minsu-jieun", "text": "안 돼요.", "seq": 1})
        hint = minsu.receive_json()
        assert hint["type"] == "hint" and hint["seq"] == 1
        assert hint["hint"]["title"] == "차갑게 느껴질 수도 있어요"

        minsu.send_json({"type": "send", "room_id": "minsu-jieun", "text": "안 돼요."})
        # 지은이 받는 첫 이벤트는 메시지여야 한다(힌트가 새면 안 됨)
        got = jieun.receive_json()
        assert got["type"] == "message" and got["message"]["text"] == "안 돼요."


def test_feedback_only_on_received_message(client):
    with client.websocket_connect("/ws/minsu") as minsu:
        minsu.send_json({"type": "send", "room_id": "minsu-jieun", "text": "안 돼요."})
        mid = minsu.receive_json()["message"]["id"]
    ok = client.post("/api/feedback", json={"room_id": "minsu-jieun", "user_id": "jieun", "message_id": mid,
                                           "text": "이유도 없이 끊어서 좀 차갑게 느껴졌어"})
    assert ok.status_code == 200 and "누가 남겼는지는 드러나지 않게" in ok.json()["ack"]
    assert "이유 없는 거절" in client.app.state.store.patterns_for("minsu-jieun")
    own = client.post("/api/feedback", json={"room_id": "minsu-jieun", "user_id": "minsu", "message_id": mid,
                                            "text": "내가 보낸 거"})
    assert own.status_code == 400


def test_detail_hides_internal_reason(client):
    with client.websocket_connect("/ws/jieun") as jieun:
        jieun.send_json({"type": "send", "room_id": "minsu-jieun", "text": "이번 주만 마감 하루 미뤄도 될까요? 집에 일이 생겨서요"})
        jieun.receive_json()
    r = client.post("/api/tone/detail", json={"room_id": "minsu-jieun", "user_id": "minsu", "text": "안 돼요."}).json()
    rep = r["report"]
    assert rep["alert"] and rep["options"] and "reason" not in rep
    assert client.get("/api/stats/minsu").json()["details"] == 1


def test_non_member_rejected(client):
    client.post("/api/users", json={"id": "stranger", "name": "외부인"})
    r = client.get("/api/rooms/minsu-jieun/messages", params={"user_id": "stranger"})
    assert r.status_code == 404
