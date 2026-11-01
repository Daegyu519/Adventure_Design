# 톤챗 아키텍처 그림 (2026-11-01 기준)

글로 된 설계와 결정은 [`ARCHITECTURE.md`](../ARCHITECTURE.md), 진행 상태는 [`AGENTS.md`](../AGENTS.md)에 있다. 이 문서는 **지금 실제로 돌고 있는 모습**을 그림으로 보여 준다. 모델·경로·값이 바뀌면 이 그림도 같이 고친다(값의 원본은 `engine/config/models.yaml`, `deploy/school-gpu/up.sh`).

목차
1. [전체 구성](#1-전체-구성)
2. [실시간 힌트](#2-실시간-힌트-입력-중-15초-안)
3. [상세 보기 (살펴보기·고쳐 쓰기)](#3-상세-보기-살펴보기고쳐-쓰기)
4. [메시지·웹훅·푸시](#4-메시지웹훅푸시)
5. [털어놓기와 거울](#5-털어놓기와-거울)
6. [데이터 모델](#6-데이터-모델)
7. [학교 GPU 서버 배치](#7-학교-gpu-서버-배치)
8. [배포·운영 흐름](#8-배포운영-흐름)
9. [개인정보 경계](#9-개인정보-경계)

---

## 1. 전체 구성

```mermaid
flowchart LR
  subgraph Devices["사용자 기기"]
    IOS["아이폰 Safari / 홈 화면 앱(PWA)"]
    AND["안드로이드 Chrome (APK는 보류)"]
  end

  subgraph Hosting["EAS Hosting"]
    WEB["웹 앱 정적 파일<br/>tone-chat.expo.app<br/>(Expo web export, 서비스 워커 sw.js)"]
  end

  subgraph SB["Supabase pilot (서울)"]
    AUTH["Auth<br/>이메일 코드 로그인<br/>(Brevo SMTP)"]
    PG[("Postgres + RLS<br/>public · tone 스키마")]
    RT["Realtime<br/>messages · reactions · room_members"]
    ST["Storage<br/>chat-images (비공개)"]
    HOOK["DB 웹훅 트리거<br/>tone.notify_engine_message (pg_net)"]
  end

  subgraph School["학교 GPU 서버 (도커 컨테이너)"]
    TS["tailscaled + Funnel<br/>공개 HTTPS"]
    ENG["AI 엔진 FastAPI<br/>127.0.0.1:8000"]
    GEM["Gemma-3-4B<br/>실시간 말투 :11435"]
    QWEN["Qwen3-30B-A3B<br/>상세·거울 말투 :11436"]
    CLF["KcELECTRA 판별기 tone-clf<br/>cold_score :11481 (선택)"]
  end

  NV["NVIDIA API 카탈로그<br/>laguna-xs-2.1 · nemotron-3.5-bolt"]
  PUSH["Web Push (VAPID) / Expo Push"]

  IOS --> WEB
  AND --> WEB
  WEB -->|"로그인·메시지·사진<br/>(publishable key + JWT, RLS)"| AUTH
  WEB --> PG
  WEB <-->|"웹소켓"| RT
  WEB --> ST
  WEB -->|"힌트·상세·털어놓기·거울<br/>HTTPS + JWT"| TS
  TS --> ENG
  ENG -->|"JWKS로 토큰 검증"| AUTH
  ENG <-->|"asyncpg (session pooler)"| PG
  PG --> HOOK
  HOOK -->|"POST /hooks/message<br/>X-Hook-Secret"| TS
  ENG -->|"가린 문장만"| GEM
  ENG -->|"가린 문장만"| QWEN
  ENG -->|"가린 문장만 · 150ms"| CLF
  ENG -->|"가린 문장만"| NV
  ENG --> PUSH
  PUSH --> IOS
  PUSH --> AND
```

- **채팅은 엔진 없이 돈다.** 메시지·사진·읽음·공감은 앱 ↔ Supabase만으로 오간다. 엔진이 꺼져도 채팅은 그대로고 힌트만 사라진다(규칙 11).
- 엔진은 서버 컨테이너의 127.0.0.1에만 열리고, 바깥에서는 Tailscale Funnel 주소(`https://tone-chat.<tailnet>.ts.net`)로만 들어온다.
- 모델 서버(llama.cpp `llama-server`)도 127.0.0.1에만 열린다. 앱은 모델을 직접 부르지 않는다.

---

## 2. 실시간 힌트 (입력 중, 1.5초 안)

```mermaid
sequenceDiagram
  autonumber
  participant U as 사용자(입력 중)
  participant A as 앱
  participant E as 엔진 /v1/hint
  participant D as Postgres
  participant G as Gemma-3-4B (:11435)
  participant K as tone-clf KcELECTRA (:11481)

  U->>A: 문장 입력
  A->>A: 0.5초 멈추면 요청(디바운스)
  A->>E: POST /v1/hint {room_id, text, reply_to?} + JWT
  E->>E: JWT 검증(JWKS) · 사용자별 분당 한도(429)
  E->>D: 방 멤버 확인 · 최근 대화 8개 · 관계 · 패턴
  E->>E: Masker로 이름·개인정보 가림(규칙 16)
  E->>E: 문지기(규칙 신호: 짧은 답·이유 없는 거절·마침표·<br/>감정적인 상대 말 등). 점수 < 0.1이면 끝(gated)
  par 같은 마감(1.35초) 안에서 동시에
    E->>G: tone_fast 프롬프트(짧은 답 r[5]·c)
    G-->>E: 다섯 읽힘(차갑게·성의없게·화나게·무난하게·따뜻하게)
  and
    E->>K: POST /score 가린 문장만 · 150ms 제한
    K-->>E: cold_score (실패·시간 초과면 항 생략)
  end
  E->>E: 집계(문지기 점수+부정 읽힘+털어놓기 패턴+clf 항, 있을 때만) → 위험도 ≥ 0.6이면 알림
  E->>E: 힌트 문구는 템플릿·금지어 검사 통과분만(규칙 4)
  E->>D: 분석 기록(tone.analysis_traces, 문장 없음)
  E-->>A: hint 또는 없음
  A->>U: 입력창 위 한 줄 힌트 (전송은 막지 않음, 규칙 6)
```

- 전체 1.5초를 넘기면 결과를 버린다(규칙 8). 학교 GPU가 꺼져 있으면 실시간 힌트만 조용히 기권한다(NVIDIA로 넘기지 않음).
- 테스트 중에는 서버 env로 기준을 낮출 수 있다: `HINT_GATE_THRESHOLD`·`HINT_ALERT_THRESHOLD`·`HINT_MIN_CONFIDENCE`(P-21).

---

## 3. 상세 보기 (살펴보기·고쳐 쓰기)

```mermaid
flowchart TB
  REQ["POST /v1/detail<br/>(힌트를 누르거나 살펴보기)"] --> MASK["Masker: 이름·개인정보 가림"]
  MASK --> PAR

  subgraph PAR["전문가 병렬 실행 (8초 예산)"]
    direction LR
    C["맥락 ctx_deep<br/>NVIDIA nemotron"]
    T1["말투 tone_ds<br/>NVIDIA laguna"]
    T2["말투 tone_kimi<br/>NVIDIA nemotron"]
    T3["말투 tone_hcx<br/>로컬 Qwen3-30B"]
    T4["판별기 clf_cold<br/>로컬 KcELECTRA (선택)"]
  end

  PAR --> AGG["집계: 의견 차이·확신·패턴·clf 항"]
  AGG --> J["심판 judge<br/>NVIDIA nemotron"]
  J --> RW["고쳐 쓰기 rewrite<br/>NVIDIA laguna"]
  RW --> GUARD["금지어·템플릿 검사(규칙 4)"]
  GUARD --> RESTORE["Masker.restore<br/>(후보 문장의 자리표시만 되돌림)"]
  RESTORE --> OUT["이유 · 읽힘 · 고쳐 쓰기 후보"]
```

- 모든 LLM 출력은 pydantic 스키마를 통과해야 쓴다. 실패하면 폴백 사슬, 모두 실패하면 기권(규칙 3).
- 폴백: NVIDIA 두 모델은 서로를 폴백으로 쓴다. 로컬 Qwen이 없으면(GPU 꺼짐) 그 전문가만 빠진다.

---

## 4. 메시지·웹훅·푸시

```mermaid
sequenceDiagram
  autonumber
  participant S as 보낸 사람 앱
  participant P as Postgres (RLS)
  participant R as Realtime
  participant O as 받는 사람 앱
  participant H as pg_net 트리거
  participant E as 엔진 /hooks/message
  participant Q as 엔진 작업 큐
  participant W as Web Push / Expo Push

  S->>P: insert messages (본인·멤버만, RLS)
  P-->>R: 변경 알림
  R-->>O: 열려 있으면 바로 표시(웹소켓)
  P->>H: AFTER INSERT 트리거
  H->>E: POST /hooks/message + X-Hook-Secret
  E-->>H: 202 (바로 응답)
  E->>Q: 푸시 작업 · 기준선(평소 문장 길이) 갱신
  Q->>W: 알림 안 끈 멤버에게 푸시
  W-->>O: 닫혀 있어도 알림
```

- 웹훅 비밀값(`HOOK_SECRET`)은 엔진 env와 트리거 함수에만 있다(`scripts/pilot-webhook`로 만든다).
- 아이폰 웹 푸시는 "홈 화면에 추가"한 앱에서만 온다(iOS 16.4+).

---

## 5. 털어놓기와 거울

```mermaid
flowchart LR
  subgraph Vent["털어놓기 (AI에게만)"]
    V1["받은 메시지 길게 누르기<br/>→ AI에게만 털어놓기"] --> V2["POST /v1/feedback"]
    V2 --> V3["Masker로 가림<br/>(원문은 어디에도 저장 안 함, 규칙 5)"]
    V3 --> V4["큐 → feedback 전문가<br/>NVIDIA nemotron"]
    V4 --> V5["패턴만 남김<br/>예: 짧은 답이 무심하게 느껴짐"]
    V5 --> V6[("tone.global_patterns<br/>tone.sender_patterns<br/>(1:1 포함, 남긴 즉시)")]
  end

  subgraph Mirror["거울"]
    M1["POST /v1/mirror/today"] --> M2["카드: 역할극 1 + 되돌려 받기 1 + 예측 1<br/>(내가 보낸 문장 + 앞선 말 context)"]
    M2 --> M3["POST /v1/mirror/answer<br/>(답장·점수·예측)"]
    M3 --> M4["말투 전문가가 앞선 말과 함께 판정<br/>(가린 뒤)"]
    M4 --> M5["읽힘 · 속마음 · 고쳐 쓰기 · 예측과의 차이"]
  end

  V6 -. "다른 사람의 힌트에 반영<br/>(서로 다른 신고자 수, 전체 기준 5명, 규칙 7)" .-> HINT["실시간·상세 힌트"]
```

---

## 6. 데이터 모델

```mermaid
erDiagram
  profiles ||--o{ room_members : "참여"
  rooms ||--o{ room_members : "멤버"
  rooms ||--o{ messages : "대화"
  profiles ||--o{ messages : "보냄"
  messages ||--o{ reactions : "공감"
  messages |o--o{ messages : "답장"
  rooms ||--o{ invites : "초대"
  profiles ||--o{ push_tokens : "기기"
  profiles ||--o{ tone_events : "힌트 반응"
  profiles ||--o{ mirror_attempts : "거울 기록"

  profiles {
    uuid id PK
    text name
  }
  rooms {
    uuid id PK
    text kind
    text relation
  }
  room_members {
    uuid room_id FK
    uuid user_id FK
    timestamptz last_read_at
    bool muted
  }
  messages {
    bigint id PK
    uuid room_id FK
    uuid sender_id FK
    text text
    text image_path
    bigint reply_to FK
    timestamptz created_at
  }
  reactions {
    bigint message_id FK
    uuid user_id FK
    text emoji
  }
  invites {
    text code PK
    uuid room_id FK
  }
  push_tokens {
    uuid user_id FK
    text token
    text platform
  }
  tone_events {
    uuid user_id FK
    uuid room_id FK
    text kind
  }
  mirror_attempts {
    uuid user_id FK
    text kind
    text card_ref
  }
  analysis_traces {
    uuid trace_id PK
    text path
    uuid user_id
    jsonb experts
    real risk
    bool alert
    int latency_ms
  }
  sender_patterns {
    uuid sender_id
    text relation
    text trigger
    int count
    timestamptz active_from
  }
  sender_pattern_reporters {
    uuid sender_id
    text trigger
    uuid reporter_id
  }
  global_patterns {
    text trigger PK
    int count
  }
  pattern_reporters {
    text trigger
    uuid reporter_id
  }
  feedback_log {
    uuid reporter_id
    bigint message_id
  }
  baselines {
    uuid user_id PK
  }
```

- 위의 9개(`profiles`~`mirror_attempts`)는 `public` 스키마로, 앱이 RLS를 거쳐 읽고 쓴다. 아래 7개(`analysis_traces`~`baselines`)는 `tone` 스키마로 **앱에서 접근 불가**(API 비공개), 엔진만 서비스 연결로 쓴다(규칙 10).
- `tone` 표 어디에도 대화 문장·하소연 원문이 없다. 분석 기록에는 경로·위험도·지연·전문가 결과 요약만 남는다.
- 열은 관계를 이해하는 데 필요한 것만 적었다. 정확한 정의는 `supabase/migrations/*.sql`.

---

## 7. 학교 GPU 서버 배치

```mermaid
flowchart TB
  subgraph Host["학교 GPU 호스트 (P100 16GB × 8, 다른 사람과 공유)"]
    subgraph C["우리 컨테이너 (Ubuntu 22.04, 자기 네트워크)"]
      direction TB
      T1["tmux tone-engine<br/>uvicorn --workers 1 :8000<br/>죽으면 5초 뒤 다시 뜸"]
      T2["tmux tone-ts<br/>tailscaled userspace + Funnel 443 → :8000"]
      T3["tmux tone-llm-fast<br/>Gemma-3-4B Q4 :11435"]
      T4["tmux tone-llm-detail<br/>Qwen3-30B-A3B IQ3_XXS :11436<br/>(여유 14GB 이상 카드만)"]
      T6["tmux tone-clf<br/>KcELECTRA TorchScript :11481<br/>(여유 1.5GB 이상 카드, 없으면 cpu)"]
      SW{{"gpu.off 스위치<br/>있으면 모델 서버를 안 띄움"}}
    end
    G7["GPU 7: Gemma (바빠지면 relocate-fast)"]
    G6["GPU 6: Qwen3-30B 약 13.5GB"]
    G2["가장 한가한 카드: tone-clf 약 1.5GB"]
    GX["나머지 GPU: 다른 사람 작업"]
  end
  T3 --- G7
  T4 --- G6
  T6 --- G2
  SW -. "gpu-off / gpu-on" .-> T3
  SW -.-> T4
  SW -.-> T6
```

- GPU 번호는 띄울 때 가장 한가한 카드를 고르므로 바뀔 수 있다(지금 배치는 2026-11-01 기준).
- 모델 서버는 기본 로그 수준이라 요청 문장을 남기지 않는다(`-v` 금지).
- 사용자가 학습에 GPU를 써야 하면 `ssh tone-gpu 'bash -s -- gpu-off' < deploy/school-gpu/up.sh`. 그동안 엔진은 로컬 모델 없이 돈다(실시간 힌트 기권, 상세는 NVIDIA만).
- 컨테이너가 다시 시작되면 `scripts/deploy-school`로 전부 다시 띄운다.

---

## 8. 배포·운영 흐름

```mermaid
flowchart LR
  DEV["개발 컴퓨터<br/>worktree 작업 → scripts/land<br/>(테스트·평가 게이트)"] -->|"git push"| GH["GitHub main"]
  DEV -->|"scripts/deploy-school<br/>git archive → app.new → uv sync → up.sh all<br/>(엔진 실패 시 이전 버전으로 되돌림)"| SRV["학교 GPU 서버"]
  DEV -->|"expo export -p web → eas deploy --prod"| EAS["EAS Hosting<br/>tone-chat.expo.app"]
  DEV -->|"supabase db push · scripts/pilot-webhook"| SBP["Supabase pilot"]
  DEV -.->|"scripts/gpu up/down<br/>개발 때만 SSH 터널"| SRV
```

- 앱 공개값(Supabase URL·publishable key·엔진 URL·VAPID 공개키)은 EAS env와 빌드 때 셸 env로 넣는다.
- 비밀값은 저장소에 없다: 루트 `.env`(dev), `.env.pilot`·`.env.pilot.engine`(pilot), 서버 `/root/tone-chat-deploy/engine.env`(권한 600).
- push 전에는 비밀값 패턴 검사를 한다(`AGENTS.md` 7장).

---

## 9. 개인정보 경계

| 데이터 | 어디까지 가나 | 어디에 남나 |
|---|---|---|
| 채팅 메시지·사진 | 앱 ↔ Supabase(RLS, 방 멤버만) | `public.messages`, `chat-images`(비공개) |
| 힌트·상세용 문장(초안·최근 대화) | 엔진 → **이름·개인정보 가린 뒤** 모델(로컬 Gemma·Qwen, NVIDIA) | 남지 않음(분석 기록은 문장 없이) |
| 사진 | 모델로 보내지 않음(규칙 12) | Storage |
| 털어놓기 원문 | 엔진 메모리에서 가린 뒤 패턴만 추출 | **어디에도 저장 안 함**(규칙 5), 패턴만 `tone.*` |
| 실제 대화 → Gemini | **보내지 않음**(규칙 9·13). Gemini는 합성 문장 평가 전용 | — |
| 비밀값(키·DB 비밀번호) | 엔진 env, EAS env(공개값만), 개발자 로컬 파일 | 저장소·로그에 없음 |
