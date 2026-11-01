# ToneChat P-14 실행 결과

2026-11-01 한국 시간. **실제 KcELECTRA 학습→저장→재로드→추론→평가→TorchScript 내보내기를 완료했다. 모델 성능은 부족하여 실험용으로만 인계한다.**

## A. 구현 완료 현황

| 항목 | 상태 | 실제 확인 |
|---|---|---|
| 데이터 생성 | 완료 | AI-Hub 원본 28,638대화 파싱, cold 약지도 234행 |
| 모델 학습 | 완료 | P100 GPU 6, 실제 optimizer update 116회 |
| 체크포인트 저장 | 완료 | safetensors·tokenizer·pipeline 메타데이터 저장 |
| 모델 재로드 | 완료 | 저장 전후 최대 점수 차이 0; 별도 CLI·평가 실행 |
| 추론 | 완료 | 단일·배치 및 원본 체크포인트 없는 TorchScript CLI |
| 평가 | 완료 | 자동 validation 6행과 고정 기존 대조 16행 분리 보고 |
| 내보내기 | 완료 | TorchScript, 새 프로세스 batch 1/2/6 점수 오차 0 |
| 엔진 전문가 등록 | 완료 | 별도 ColdSignal·선택 Registry.classifiers·mock 테스트, 기본 미활성 |
| 테스트 | 일부 완료 | ML 33·엔진 533 통과; 기존 Postgres 26건·FakeRepo 잠금 1건 건너뜀 |
| 실제 사용자 경고 적용 | 미완료 | 성능 부족으로 미연결, 후속 독립 평가·통합 필요 |

기존 V1/V2·서비스·gpu.off를 수정하거나 삭제하지 않았다. 승인받은 GPU 6만 사용했고 작업 후 해당 GPU는 8MiB·사용률 0%로 확인했다.
GitHub main은 시작 시 기준 커밋 `09c6cb1627afeae8cfb30ed3819f3fef3c0d2577`과 동일했다.
기존 로컬 `4421a97`의 ML 코드를 재사용하여 새 `p14-context` worktree에서 작업했다.
GitHub 브랜치 생성은 연결 계정의 쓰기 권한 부족(403 Resource not accessible by integration)으로 실패했다. 원격 main 병합·배포는 하지 않았다.

## B. 학습 데이터

데이터 출처는 기존 학교 서버 `/root/p14-data`의 AI-Hub 공감형 대화 046 한 종류다.
원본 28,638대화 중 train 25,456·validation 3,182, listener 후보는 각각 181,802·22,554개다.
원본이나 실제 학습 문장을 GitHub·소스 ZIP·결과 증거에 포함하지 않았다.

| 분할 | 학습용 행 | label 0 | label 1 | 대조 그룹 | 사용 원본 대화 |
|---|---:|---:|---:|---:|---:|
| train | 228 | 152 | 76 | 76 | 152 |
| validation | 6 | 4 | 2 | 2 | 4 |
| 합계 | 234 | 156 | 78 | 78 | 156 |

규칙 버전은 `extractive-ack-context-v1`이다. 원본 답장에 있는 확인 표현만 추출한다.
동일 관계·동일 확인 표현으로 다음 3행을 묶었다: 사실 확인 질문+짧은 확인 응답=weak 0,
상세 감정 표현+같은 확인 응답만 남김=weak 1, 같은 감정 맥락+조건을 통과한 원래 공감 응답=weak 0.
짧은 응답을 무조건 양성으로 붙이지 않고 사실 확인의 짧은 음성 예문을 포함했다.
원래 답장도 공감·주제 일치 조건을 만족할 때만 음성으로 사용했다.
애도·응급·사과·축하 등의 높은 맥락 의존성은 사실 확인 규칙에서 제외했다.

규칙 미충족 유보 후보는 203,798개다. 규칙 통과 558후보 중 매칭·중복 제한을 거쳐 156후보를 사용했다.
원본 대화·대조 그룹·전체 입력이 분할 사이에 겹치지 않도록 검사했다. 관계 정보는 원본 값이며 만들어 넣지 않았다.
모든 행에 sample_id/source_conversation_id/contrast_group_id/relation/context/draft/label/label_source/split과 생성 이력을 보존했다.
사람 검수는 0개다. ChatGPT·Claude 작성 문장이나 건별 레이블을 실제 학습에 사용하지 않았다.
234행은 목표 2,000~4,000보다 적지만, 개수를 위해 불확실한 규칙을 완화하지 않았다.

이 약지도 정의도 틀릴 수 있다. 감정 표현 뒤의 확인 응답도 적절할 수 있고, 공감 답장도 부적절할 수 있다.
정당한 거절 등의 hard negative는 충분히 확보하지 못했다. 인간 정답·보편적인 차가움 판단으로 제시하지 않는다.

## C. 모델 결과

- 모델: `beomi/KcELECTRA-base`, 실제 revision `681201a097b8120e6dd2a2e63a3e13d338736f88`.
- 학교 서버 체크포인트: `/root/p14-work/cold-20261101-run/training/model`.
- TorchScript: `/root/p14-work/cold-20261101-run/export/model.ts`.
- 로컬 전달 모델: `P14-trained-model.zip` 안의 `training/model/` 및 `export/`.
- 장비: Tesla P100-PCIE-16GB GPU 6, PyTorch 2.5.1+cu121·Transformers 4.49.0·Python 3.10.12.
- 설정: FP32, seed14, max_length256, batch2×accumulation4, lr2e-5, 4epochs.
- 계획·실제 업데이트 116회. max_steps512는 상한이고 epoch 고갈로 종료했다.
- encoder 최대 가중치 변화 0.00119305, head 0.00159754, 재로드 점수 차이 0.

| 평가 자료 | 표본 | Precision | Recall | F1 | 혼동행렬 | 예측 0/1 |
|---|---:|---:|---:|---:|---|---|
| 자동 약지도 validation | 6행 | 0 | 0 | 0 | `[[4,0],[2,0]]` | 6 / 0 |
| 기존 ToneChat 대조 세트 | 16행·8쌍 | 0 | 0 | 0 | `[[8,0],[8,0]]` | 16 / 0 |

혼동행렬의 행은 실제 0/1, 열은 예측 0/1이다. 양성 예측이 없어 Precision은 zero-division 규칙상 0으로 보고한다.
기존 대조의 임계값 분리는 0/8, B>A 점수 순위는 2/8이었다.
임계값은 0.5로 고정했고 기존 대조 세트로 튜닝하지 않았다.
기존 `alert` 레이블은 `coldness`와 같지 않아 예비 대리 평가다.
검증 표본도 매우 작다. 별도 인간 평가나 확률 보정은 없으며, 현재 모델은 실제 경고기로 사용하기 어렵다.

**지연:** 사전 로딩·batch1·190토큰인 한 validation 입력, 워밍업10회·측정100회,
토크나이징+전송+forward+softmax 포함·CUDA 동기화·로딩 제외 조건에서 p50 **12.8045ms**, p95 **13.8038ms**.
모델 로딩은 4922ms, 첫 추론은 621ms였다. 이 입력 조건에서만 50ms/30ms 목표를 만족했다.
길이와 동시 부하 전체에 대한 운영 SLA는 검증하지 않았다.

TorchScript CPU 새 프로세스에서 batch1/2/6·길이190/230의 최대 점수 오차는 0이었다.
GPU 단일/배치 최대 차이는 1.49e-7이었다. 별도 TorchScript CLI도 원래 체크포인트 없이 cold_score를 반환했다.
모델 파일별 SHA256과 실측 JSON은 함께 제공한 `evidence/`에 있다.

기존 V1의 81.25%를 이번 성능으로 인용하지 않았다.
이번에 별도로 먼저 실행한 topic-swap 2,048/256행 모델은 384업데이트·저장 뒤 ablation 후처리 인자 오류로 실패했다.
해당 모델은 `/root/p14-work/context-20261101-run/training/model`에 보존했지만 완료 모델로 취급하지 않았다.
수정 후 새로 실행한 위 cold 모델의 실제 수치만 본 표에 썼다.

## D. 실행 방법과 검증

기존 저장소의 새 작업 브랜치에 `P14-changes.patch`를 적용하거나 소스 ZIP을 반영하고 저장소 루트에서 실행한다. ZIP 자체에는 `.git`이 없으므로 `scripts/check`는 Git 작업 트리에서 실행해야 한다. 기존 경로를 덮어쓰지 말고 새 run 경로를 지정한다.

```bash
PY=/root/p14-work/source/ml/.venv-demo/bin/python
export CUDA_DEVICE_ORDER=PCI_BUS_ID CUDA_VISIBLE_DEVICES=6
export OMP_NUM_THREADS=2 TOKENIZERS_PARALLELISM=false
RUN=/root/p14-work/cold-NEW-run

# 전체 재현: 데이터→학습→독립 CLI→평가→대조 평가→내보내기
$PY -m ml.phase1 --gpu 6 --root /root/p14-data --workdir "$RUN"

# 개별 단계
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

# 검증
$PY -m pytest ml/tests -q -W error
(cd engine && uv run --locked pytest -q -W error)
scripts/check
```

전체 명령과 개별 단계는 같은 출력 폴더에 연속해서 중복 실행하지 않는다.
입력 JSON은 `last_them`, `draft`, 선택 `relation`, 선택 `context=[{role,text}]`로 구성한다.
새 환경 설치·클래스 계약은 소스의 `ml/P14-phase1.md`를 참고한다. 모델 revision은 재현용으로 고정했다.

최신 엔진 `533 passed, 27 skipped`, 서버 ML `33 passed`, `scripts/check` 통과를 실제 확인했다.
앱 Jest 717개·62 suites, Supabase PGlite 25개, 타입·lint·대비 검사가 통과했다.
건너뜀 27개는 Postgres 실행 파일 미설정 26개와 FakeRepo 잠금 테스트 1개다.
mock 평가 precision0.5·recall0.12는 기존 baseline과 같으며 배관 점검일 뿐 성능 수치가 아니다.
독립 리뷰에서 동시 호출 잠금 경쟁·누락 optional checkpoint·출처 위조 가능성을 수정하고 재검토 받았다.

## E. 기존 ToneChat 연결 상태

`ClassifierExpert`는 가려진 ExpertRequest를 받고 ColdSignal(cold_score, model_id, latency_ms)을 반환한다.
기존 ExpertResult/ToneReading과 분리하여 confidence나 5범주 분포를 만들어내지 않는다.
선택 설정으로 `Registry.classifiers`에 등록되며 기본 설정은 비활성이다.
모델·선택 ML 의존성·선택 경로가 없거나 로드에 실패하면 제외되고, mock 모드에서 실모델을 로드하지 않는다.
빈 입력·추론 오류·deadline 초과·동시 중복은 None을 반환하며 원문을 로그에 남기지 않는다.

현재 hint·detail·L3 집계는 분류기를 호출하거나 점수를 반영하지 않는다. 기존 Gemma3와 실시간 경고 결과를 유지했다.
실제 경고에 연결하려면 인간 평가를 확보하고 cold_score·negative·risk의 차이를 반영한 별도 집계 정책을 검증해야 한다.
엔진 배포 이미지에 ML 의존성을 추가하지 않았으므로 연구 호출에는 저장소 루트 PYTHONPATH와 ML 환경이 필요하다.

## F. 이후 개선할 문제

1. **데이터·레이블 품질:** 확인/감정 맥락 규칙의 오분류와 답장 자르기의 인위성을 검증하고, 독립 인간 평가·정당한 거절 등 hard negative를 확보한다.
2. **모델 성능:** 현재 저위험 클래스 집중을 먼저 해결한다. 데이터 균형·약지도 품질·검증 규모를 개선하고 별도 검증에서 재평가한다. 이번 대조 세트에 임계값을 맞추지 않는다.
3. **앙상블 통합:** 별도 cold 신호와 기존 5범주 negative·risk의 의미를 구분한 통합 정책을 검증한 뒤 활성화한다.

원본 데이터·실제 학습 예문·비밀번호는 전달 ZIP이나 코드 패치에 없다. 모델 ZIP은 가중치·토크나이저·실험용 안내·파일 해시만 포함한다.
