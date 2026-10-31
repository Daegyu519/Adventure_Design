from zoneinfo import ZoneInfo


def test_asia_seoul_loads_without_os_tzdb() -> None:
    # OS tz 데이터베이스가 없는 서버 이미지에서도 tzdata 패키지로 로드되어야 한다
    assert ZoneInfo("Asia/Seoul").key == "Asia/Seoul"
