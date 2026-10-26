# tone-harness

1:1 채팅 앱과, 그 안에서 도는 말투 알림 멀티 레이어 LLM 하네스의 뼈대다. 구조 설명은 `ARCHITECTURE.md`에 있다.

```
L0 거르기(규칙) → L1 맥락 + L2 말투 (병렬) → L3 판단(계산식, 갈리면 심판) → 힌트
                                         ↘ 상세: 두 번째 의견 + 고쳐 쓰기 + 세 가지 확인
상대 하소연 → L4 피드백 → 패턴 저장(원문 삭제) → L0·L3에 반영
```

## 실행

```bash
pip install -r requirements.txt

# 채팅 앱 데모 (API 키 없으면 mock 모델)
uvicorn server.app:app --reload
# 브라우저 두 개: http://localhost:8000/?user=minsu  /  http://localhost:8000/?user=jieun

python demo.py --mock              # 하네스만 따로 시연
python -m eval.run_eval --mock     # 대조 세트 평가 (실시간 경로)
python -m eval.run_eval --mock --detail
python -m pytest -q                # 하네스 + 채팅 서버 테스트
```

키를 넣으면 설정 순서대로 실제 모델을 쓴다. 키가 없거나 실패하면 다음 모델, 마지막엔 mock으로 넘어간다.

```bash
export NVIDIA_API_KEY=nvapi-...    # build.nvidia.com 로그인 → API Key
export GEMINI_API_KEY=...          # aistudio.google.com → Get API key
export GITHUB_TOKEN=...            # GitHub 설정 → Personal access token (models:read)
python demo.py
python -m eval.run_eval
```

## 로컬 HyperCLOVA X (L2)

`USE_LOCAL_MODEL=1`일 때만 로컬 서버를 쓴다.

| 장비 | 모델 | 방법 |
|---|---|---|
| 8GB M2 Mac | SEED Text Instruct 1.5B | Ollama나 LM Studio에 GGUF 양자화 버전을 올리고 `local.base_url`을 `http://localhost:11434/v1`로 |
| Colab T4 | SEED Text Instruct 1.5B, Think 14B(4bit) | `vllm serve naver-hyperclovax/HyperCLOVAX-SEED-Text-Instruct-1.5B` 후 ngrok 등으로 연결 |
| 학교 GPU 서버 | SEED Think 14B / 32B | `vllm serve ...` |

모델 이름은 `config/models.yaml`의 `roles`에서 바꾼다. 서버에 올린 이름과 같아야 한다.

## 파일

| 경로 | 내용 |
|---|---|
| `server/app.py` | 채팅 서버 (WebSocket 메시지·힌트, REST 살펴보기·털어놓기·이벤트) |
| `server/db.py` | SQLite 표 (users, rooms, messages, tone_events, feedback_log) |
| `server/static/index.html` | 웹 채팅 앱 (입력 중 힌트, 살펴보기 시트, 털어놓기 시트) |
| `config/models.yaml` | 공급자, 역할별 모델 순서, 시간 제한, 판단 가중치 |
| `harness/router.py` | 폴백, 한도(토큰 버킷), 차단기, 캐시, 호출 기록 |
| `harness/providers.py` | OpenAI 호환 공급자(NVIDIA, Gemini, GitHub, 로컬) + mock |
| `harness/pipeline.py` | 실시간·상세·피드백 세 경로 |
| `harness/schemas.py` | 레이어 사이 데이터 형태 (pydantic) |
| `harness/korean.py` | 한국어 겉 신호 규칙 |
| `harness/store.py` | 관계 패턴, 전체 패턴, 내 기준선 (원문 없음) |
| `harness/pii.py` | 외부 API 전송 전 개인정보 가리기 |
| `layers/gate.py` | L0 거르기 |
| `layers/context.py` | L1 맥락 |
| `layers/tone.py` | L2 말투 |
| `layers/judge.py` | L3 판단(앙상블 계산식, 심판) |
| `layers/rewrite.py` | 고쳐 쓰기 + 세 가지 확인 |
| `layers/feedback.py` | L4 피드백 |
| `layers/hint.py` | 확정하지 않는 문구, 금지어 검사 |
| `prompts/*.md` | 레이어별 프롬프트 (짧은 예시 포함, 생각 과정은 쓰지 않게) |
| `eval/contrast_set.jsonl` | 같은 문장, 다른 맥락 8쌍. 30쌍까지 늘릴 것 |

## mock 평가 결과를 읽는 법

mock은 규칙으로 흉내만 내서 정확도 숫자에 의미가 없다. 대신 어디서 막히는지는 보인다. 지금 규칙만으로는 합격 소식에 "네 수고하세요", 생일 초대에 "지금 좀 바빠", 부고에 "ㅋㅋ" 같은 경우를 놓치고, 보안 규정을 묻는 말에 "안 돼요."라고 답한 괜찮은 경우에는 알림을 띄운다. 겉 신호로는 안 잡히고 맥락을 읽어야 하는 경우라서, 여기가 실제 LLM 레이어가 해야 할 일이다. 키를 넣고 같은 평가를 돌려서 규칙만 썼을 때와 비교하면 발표 자료가 된다.

## 구조 그래프 (graphify)

`graphify-out/`에 코드와 설계 문서를 엮은 지식 그래프가 있다.

| 파일 | 내용 |
|---|---|
| `graph_offline.html` | 브라우저로 여는 그래프. 인터넷 없이 열림 |
| `GRAPH_REPORT.md` | 묶음(커뮤니티), 중심 노드, 흐름 묶음 요약 |
| `graph.json` | 원본 그래프 |

코드를 고친 뒤 다시 만들려면:

```bash
pip install graphifyy
graphify update .                    # 코드만 다시 읽음 (API 키 필요 없음)
graphify affected "Router"           # Router를 바꾸면 영향받는 곳
graphify path "ingest()" "render_hint()"
```
