# 톤챗 아키텍처 그림 (2026-11-01 기준)

기술 수준의 요약이다. 글로 된 설계와 결정은 [`ARCHITECTURE.md`](../ARCHITECTURE.md), 진행 상태는 [`AGENTS.md`](../AGENTS.md)에 있다. 모델·경로 값의 원본은 `engine/config/models.yaml`.

## 1. 전체 구성

```mermaid
flowchart LR
  APP["앱<br/>Expo · React Native · 웹 PWA"]
  HOST["EAS Hosting<br/>웹 정적 파일"]
  subgraph SB["Supabase"]
    AUTH["Auth"]
    PG[("Postgres + RLS")]
    RT["Realtime"]
    ST["Storage"]
  end
  ENG["AI 엔진<br/>FastAPI"]
  subgraph M["모델"]
    LLM["자체 호스팅 LLM (llama.cpp)<br/>Gemma 3 4B · Qwen3-30B-A3B<br/>HyperCLOVA X SEED Omni 8B"]
    CLF["KcELECTRA 판별기"]
    NV["NVIDIA API 모델"]
  end
  PUSH["Web Push"]

  HOST --> APP
  APP --> AUTH
  APP --> PG
  APP <--> RT
  APP --> ST
  APP -->|"힌트·상세 (HTTPS + JWT)"| ENG
  ENG -->|"토큰 검증"| AUTH
  ENG <--> PG
  PG -->|"DB 웹훅"| ENG
  ENG -->|"가린 문장만"| LLM
  ENG -->|"가린 문장만"| CLF
  ENG -->|"가린 문장만"| NV
  ENG --> PUSH
  PUSH --> APP
```

- 채팅은 엔진 없이 앱과 Supabase만으로 돈다. 엔진이 꺼져도 힌트만 사라진다.
- 앱은 모델을 직접 부르지 않는다.

## 2. 실시간 힌트 흐름 (1.5초 안)

```mermaid
sequenceDiagram
  participant A as 앱
  participant E as 엔진
  participant M as 실시간 모델 + 판별기
  A->>E: 보내기를 누른 문장 + JWT (타이핑 중 호출 없음)
  E->>E: 이름·개인정보 가리기
  E->>E: 문지기 (규칙 신호, 점수가 낮으면 종료)
  E->>M: 가린 문장
  M-->>E: 읽힘 점수 + 판별 점수
  E->>E: 집계 + 템플릿·금지어 검사
  E-->>A: 힌트 또는 없음 (1.5초 넘으면 버림)
  alt 1.5초 안에 경고
    A->>A: 수정하기 / 그대로 보내기 선택 (자동 전송 없음)
  else 경고 없음 / 실패 / 앱에서 1.5초 만료
    A->>A: Supabase에 전송 (늦은 분석 무시)
  end
```

## 3. 상세 보기 흐름

```mermaid
flowchart LR
  REQ["상세 요청"] --> MASK["가리기"]
  MASK --> EXP["전문가 병렬<br/>맥락 · 말투(Qwen3-30B · HyperCLOVA X · NVIDIA) · 판별기"]
  EXP --> J["심판"]
  J --> RW["고쳐 쓰기"]
  RW --> CHK["스키마·금지어 검사"]
  CHK --> OUT["이유 · 읽힘 · 후보"]
```

## 4. 개인정보 경계

| 데이터 | 어디까지 가나 | 어디에 남나 |
|---|---|---|
| 채팅 메시지·사진 | 앱 ↔ Supabase (RLS, 방 멤버만) | 메시지 표, 비공개 Storage |
| 힌트·상세용 문장 | 엔진 → 이름·개인정보를 가린 뒤 모델 | 남지 않음 (분석 기록에는 문장 없음) |
| 사진 | 모델로 보내지 않음 | Storage |
| 털어놓기 원문 | 엔진 메모리에서 가린 뒤 패턴만 추출 | 어디에도 저장 안 함, 패턴만 |
| 실제 대화 → Gemini | 보내지 않음 (합성 문장 평가 전용) | — |
| 비밀값 | 엔진 env, 개발자 로컬 파일 | 저장소·로그에 없음 |
