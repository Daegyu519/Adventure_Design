# P-14 맥락 기반 이진 분류기 — 실행·인계

2026-11-01, GitHub main 기준 `09c6cb1627afeae8cfb30ed3819f3fef3c0d2577`.
기존 로컬 P-14 `4421a97`의 파서·학습·저장 코드를 재사용했다.

**실제 KcELECTRA 학습·저장·새 프로세스 재로드·추론·평가·TorchScript 내보내기를 실행했다. 현재 모델은 실험용이다. 검증 6개와 기존 대조 16개 모두 고정 임계값에서 양성을 예측하지 못했다. 운영 경고에 연결하지 않는다.**

## 재현

학교 서버의 기존 환경 `/root/p14-work/source/ml/.venv-demo/bin/python`은 Python 3.10.12,
PyTorch 2.5.1+cu121, Transformers 4.49.0이다. 엔진은 별도 `uv.lock` 환경을 사용한다.
새 ML 환경은 `python3 -m venv .venv-ml` 후 `ml/requirements.txt`를 설치하고,
P100에서는 CUDA 12.1용 PyTorch 2.5.1을 사용한다. 시스템·운영 환경을 바꾸지 않는다.

```bash
# 저장소 루트에서 실행. GPU 번호는 소유자가 승인한 번호로 지정한다.
PY=/root/p14-work/source/ml/.venv-demo/bin/python
$PY -m ml.phase1 --gpu 6 --root /root/p14-data --workdir /root/p14-work/cold-NEW-run
```

`phase1`은 새 출력 폴더만 허용하고 데이터→학습→별도 CLI→검증→대조 평가→내보내기를 실행한다.
실패 시 `failure.json`에 실패 단계만 남기며 저장한 모델은 보존한다.
학교 서버 원본의 이용 권한은 기존 소유자의 승인 범위에 따른다. 원본·파생 문장은 학교 서버에 둔다.
새로운 외부 데이터나 교사 모델은 사용하지 않았다. 원문을 외부 API에 보내지 않았다.

실제 실행한 개별 명령(새 출력 폴더를 사용한다):

```bash
export CUDA_DEVICE_ORDER=PCI_BUS_ID CUDA_VISIBLE_DEVICES=6
export OMP_NUM_THREADS=2 TOKENIZERS_PARALLELISM=false
PY=/root/p14-work/source/ml/.venv-demo/bin/python
RUN=/root/p14-work/cold-20261101-run
$PY -m ml.cold_data --root /root/p14-data --output "$RUN/data"
$PY -m ml.train --train "$RUN/data/train.jsonl" --validation "$RUN/data/validation.jsonl" \
  --output "$RUN/training" --device cuda --label-mode cold-weak \
  --epochs 4 --max-steps 512 --batch-size 2 --accumulation 4
$PY -m ml.evaluate --checkpoint "$RUN/training/model" --data "$RUN/data/validation.jsonl" \
  --label-mode cold-weak --device cuda --output "$RUN/reevaluation.json"
$PY -m ml.infer --checkpoint "$RUN/training/model" --input-json "$RUN/inference-input.json" \
  --device cuda --warmup 10 --runs 100 --output "$RUN/latency.json"
$PY -m ml.contrast --checkpoint "$RUN/training/model" --device cuda --output "$RUN/contrast.json"
$PY -m ml.export --checkpoint "$RUN/training/model" --output "$RUN/export" \
  --inputs "$RUN/data/validation.jsonl" --device cpu
$PY -m ml.torchscript_infer --export "$RUN/export" --input-json "$RUN/inference-input.json"
```

`inference-input.json`은 `last_them`, `draft`, 선택 `relation`, 선택 `context`를 가진 객체다.
context는 `[{"role":"me" 또는 "them", "text":"..."}]` 형식이다.
빈 답장·빈 상대 발화는 명시적 오류로 거부한다. 관계를 제공하지 않으면 빈 값이며 만들어 넣지 않는다.
최신 8턴과 답장을 두 세그먼트로 직렬화하며 답장 앞부분과 최신 맥락을 우선 보존한다.
단일·배치 PyTorch 추론은 `ml.model.Predictor.predict`와 `predict_batch`를 사용한다.
TorchScript는 `ml.torchscript_infer.ScriptPredictor`로 원래 PyTorch 체크포인트 없이 로드할 수 있다.

## 실제 모델과 데이터

- 학습 모델: `beomi/KcELECTRA-base`, resolved revision `681201a097b8120e6dd2a2e63a3e13d338736f88`.
  후속 재현의 기본 revision은 이 값으로 고정했다.
- 체크포인트: `/root/p14-work/cold-20261101-run/training/model`.
- 내보내기: `/root/p14-work/cold-20261101-run/export/model.ts`.
- 소스 실행본: `/root/p14-work/cold-20261101-source`.
- 데이터·로그: `/root/p14-work/cold-20261101-run`, 원본 `/root/p14-data`.
- AI-Hub 공감형 046의 28,638개 원본 대화(25,456 train / 3,182 validation), 후보 응답 204,356개를 읽었다.
- 최종 234행: train 228(0=152, 1=76), validation 6(0=4, 1=2).
  train 76그룹·152원본 대화, validation 2그룹·4원본 대화.
- 규칙 미충족 유보 후보 203,798개. 규칙 통과 558후보 중 매칭·원본 중복 제한 등을 거쳐 156후보를 사용했다.
  사람 검수 0개. 목표 개수보다 명확한 규칙을 우선해 소규모로 끝냈다.
- 동일 원본 대화·대조 그룹·동일 전체 입력은 train/validation 사이에 겹치지 않는다.
  실제 원본 분할을 유지했다. `eval/contrast_set.jsonl`은 학습·임계값 조정에 사용하지 않았다.

규칙은 `extractive-ack-context-v1`이다. 원본에 있는 확인 표현만 연속 부분 문자열로 추출한다.
명시적 사실 확인 질문에는 짧은 확인 응답을 weak 0으로, 상세한 어려움 표현에는 같은 확인 응답만 남긴 것을 weak 1로 둔다.
후자의 원래 답장도 기존의 공감·주제 일치 조건을 통과할 때만 weak 0으로 보존한다.
동일 관계·동일 확인 표현으로 묶고, 원본 대화마다 한 그룹에만 사용한다.
애도·응급·사과·축하 등의 높은 맥락 의존성은 사실 확인 음성 규칙에서 제외한다.
`그렇구나`처럼 공감으로도 읽히는 확인 표현도 단답 변형 규칙에서 제외했다.

모든 행에 `sample_id`, `source_conversation_id`, 전체 donor/target 출처 ID,
`contrast_group_id`, relation/context/draft, label/label_source/split,
rule_version/labeling_rule, `human_approved=false`를 남긴다.
LLM 작성 문장이나 건별 LLM 판단은 실제 학습 데이터에 없다. 테스트 fixture는 배관 시험 전용이다.

이 규칙 역시 오류가 있다. 감정 표현 뒤의 확인 응답도 적절할 수 있고, 확인 질문에도 관계에 따른 기대가 있다.
원본 공감 응답도 냉담할 수 있다. 사람의 확정 정답으로 해석하지 않는다.
정당한 거절 등의 hard negative는 이 데이터로 충분히 확보하지 못했다.

## 실제 결과

P100 GPU 6, FP32, seed 14, max_length 256, lr 2e-5, batch 2 × accumulation 4, 4epochs.
계획·실제 optimizer update 모두 116이다. 512는 상한이며 epochs_exhausted로 종료했다.
encoder 최대 가중치 변화 0.00119305, head 0.00159754, 저장·재로드 점수 차이 0.

| 평가 | n | Precision | Recall | F1 | 혼동행렬 | 예측 0/1 |
|---|---:|---:|---:|---:|---|---|
| 자동 규칙 validation | 6 | 0 | 0 | 0 | `[[4,0],[2,0]]` | 6 / 0 |
| 기존 경고 대조 세트 | 16 (8쌍) | 0 | 0 | 0 | `[[8,0],[8,0]]` | 16 / 0 |

혼동행렬은 행=실제0/1, 열=예측0/1이다. 임계값 0.5를 고정했고 튜닝하지 않았다.
기존 대조의 A<0.5≤B 구분은 0/8, 단순 B>A 순위는 2/8이다.
기존 `alert` 레이블은 coldness와 동일하지 않으므로 예비 대리 평가다.
검증 6행은 특히 작다. 별도 인간 평가·보정 결과는 없다.

지연은 모델 사전 로딩, batch1, 한 validation 입력 190토큰, 워밍업10회·측정100회,
토크나이징·장치 전송·forward·softmax 포함, CUDA 동기화 조건이다.
p50 **12.8045ms**, p95 **13.8038ms**, 로딩 4922ms, 첫 추론 621ms.
이 입력 조건에서 p95 50ms/30ms를 모두 만족했다. 길이·부하 전체에 대한 서비스 SLA는 검증하지 않았다.

TorchScript는 CPU 새 프로세스에서 배치1/2/6, 길이190/230토큰으로 재로드했다.
PyTorch 대비 최대 오차 0, GPU 단일/배치 최대 오차 1.49e-7이었다.
모델·토크나이저 SHA256은 `artifact-manifest.json`에 보존한다.

## 엔진 연결

`ClassifierExpert`는 기존의 가려진 `ExpertRequest`를 받고 `ColdSignal(cold_score, model_id, latency_ms)`을 반환한다.
`ToneReading`이나 confidence를 생성하지 않는다. 동시 호출은 한 번만 처리하며 초과·오류·빈 입력은 None이다.
timeout 이후 native forward가 끝날 때까지 중복 forward를 예약하지 않는다.

선택 설정은 `engine/config/classifiers.example.yaml`을 참고한다.
실험용 설정 복사본에 최상위 `classifiers`를 추가하면 `Registry.classifiers`에서 찾을 수 있다.
기본 enabled=false이며, 모델·선택 의존성·잘못된 선택 checkpoint가 없으면 제외된다.
`force_mock`에서는 실제 분류기를 로드하지 않는다. 필수(optional=false)일 때는 고정 오류로 실패한다.

엔진에서 이 연구 backend를 로드할 때는 저장소 루트를 PYTHONPATH에 추가하고 ML 의존성이 있는 환경을 사용한다.
운영 이미지에는 ML 의존성을 추가하지 않았다. 실제 hint·detail·집계기는 이 목록을 호출하지 않는다.
기존 Gemma3·5범주·서비스·gpu.off는 유지했다. 연결 후속 작업은 별도 cold 신호 집계 정책과 인간 평가다.

## 검증 명령

```bash
# 엔진 전체 회귀(별도 uv.lock 환경)
cd engine && uv run --locked pytest -q -W error
# 저장소 루트에서
scripts/check
/root/p14-work/source/ml/.venv-demo/bin/python -m pytest ml/tests -q -W error
```

최종 실제 테스트 집계와 미실행·건너뜀 항목은 `docs/handoff/P-14-result.md`에 기록한다.
독립 리뷰의 동시 호출·선택 경로 오류·출처 ID 검사 지적을 수정하고 재검토 받았다.
데이터·가중치·체크포인트는 Git에 포함하지 않는다. source ZIP은 코드만 포함한다.

## 이전 실행과의 구분

기존 V1의 81.25%는 이전 주제 불일치 대리 레이블 결과다. 위 cold 모델 성능과 혼동하지 않는다.
이번에도 기존 topic-swap 파이프라인을 별도 2048/256행·384업데이트로 먼저 실행했고 모델을 저장했다.
해당 실행은 ablation 진단의 함수 인자 불일치로 학습 후처리에 실패했다.
그 체크포인트(`/root/p14-work/context-20261101-run/training/model`)는 보존했으나 완료로 보고하지 않는다.
수정된 코드로 별도 cold 실행을 새로 수행했고 위 결과는 그 실행에서만 가져왔다.

Git Bash 실행이 Windows sandbox의 MSYS IPC 제한으로 실패했고, 이전 P-14 claim도 남아 있어
새 claim을 덮어쓰지 않았다. 기존 4421a97에서 `p14-context` worktree를 만들어 이어갔다.
main 직접 병합·배포는 하지 않는다.
