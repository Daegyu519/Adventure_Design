# P-14 마지막 점검 — 기존 모델 보존·원인 진단

기존 실험 모델은 변경하지 않았다. 실제 재학습은 하지 않았으며, 수정된 입력 버전의 말투 분류 성능은 아직 측정하지 않았다. 전체 결과는 `docs/handoff/P-14-final-hour.md`와 별도 안전한 수치 증거 ZIP을 참고한다.

## 확인한 구현 문제와 수정

실제 저장 tokenizer는 ByteLevel BPE `PreTrainedTokenizerFast`, post_processor=null이다. 기존 일반 `prepare_for_model()` 경로는 `[CLS]`·`[SEP]`를 삽입하지 않았다. 원래 Electra 분류 헤드는 첫 번째 위치를 사용하므로 의도한 분류 입력 전제에 어긋난다. 이 문제가 F1=0에 기여한 정도는 검증하지 않았다.

새 학습용 `context-pair-v2`는 명시적으로 `[CLS] context [SEP] draft [SEP]`를 만들고 3토큰을 예약한다. segment 0/1과 attention mask도 명시한다. 내용·최근 맥락 중복·뒤쪽 맥락 보존 정책은 그대로 두어 다른 변경과 섞지 않았다.

**기존 모델에 v2를 강제로 적용하지 않는다.** 저장 metadata의 입력 형식으로 학습·추론·재로드·내보내기·진단을 일관되게 선택한다. 기존 descriptive-v1 metadata와 legacy-v1 기본값을 지원한다. 모르는 입력 형식은 오류다. 실제 기존 234행의 v1 입력 배열이 수정 전과 완전히 같음을 확인했다.

`--epoch-metrics`는 매 epoch 훈련·검증의 양성 예측 수, 혼동행렬, 양 클래스 recall, F1, 클래스별 점수 범위를 `epoch_metrics.jsonl`에 기록한다. 임계값·체크포인트를 선택하지 않는다. 과거 실험의 epoch별 점수는 기록되지 않아 복원할 수 없다.

## 재실행 가능한 읽기 전용 진단

학교 서버의 기존 ML 환경을 사용하고 저장소 루트에서 실행한다. 출력은 새 폴더만 허용한다.

```bash
PY=/root/p14-work/source/ml/.venv-demo/bin/python
OLD=/root/p14-work/cold-20261101-run
AUDIT=/root/p14-work/final-hour-NEW

$PY -m ml.final_diagnose --checkpoint "$OLD/training/model" --data "$OLD/data" \
  --source-root /root/p14-data --output "$AUDIT/diagnosis" \
  --queue-dir "$AUDIT/private-review-queue" --device cpu

$PY -m ml.context_ablation --checkpoint "$OLD/training/model" \
  --data "$OLD/data/validation.jsonl" --output "$AUDIT/context-ablation.json" --device cpu

$PY -m pytest ml/tests -q -W error
scripts/check
```

`private-review-queue`에만 실제 원문이 있다. 이 디렉터리는 학교 서버 안에 보관하고 복사·Git 커밋하지 않는다. 650 train + 74 validation 후보의 label은 전부 uncertain, review_status=pending, is_training_data=false다. 어휘 일치는 인용·부정·공감 설명일 수도 있으므로 고위험 정답이 아니다. 실제 학습 검증기는 이 후보를 거부한다.

그 밖의 진단 출력은 해시 ID·실제 weak/alert 레이블·점수·예측·집계만 담고 원문은 담지 않는다. 상대 발화 단서와 원본 답장/학습 답장 단서를 분리한다. 어휘 태그는 중복 가능하며 사람의 의미 분류가 아니다. insufficient_metadata도 필드 누락 검사일 뿐 의미적 충분성을 판정하지 않는다.

PR 격자는 훈련·약지도 검증에서만 진단용으로 계산한다. 기존 대조 16행에서는 임계값을 탐색하지 않으며 `alert`와 coldness 목표가 다름을 표시한다. 모든 실제 예측 임계값은 0.5다.

맥락 제거는 `context=[]`와 `last_them=""`를 모두 적용하고 relation은 유지한다. 교환은 같은 약지도 그룹의 다른 원본 맥락으로 바꾸되 답장은 유지한다. 새 조합의 레이블이 없으면 unknown으로 남긴다. 이 조작은 분포 밖 입력일 수 있으므로 점수 변화 자체가 올바른 맥락 이해의 증거는 아니다.

## 이후 재학습 조건이 충족됐을 때만 실행할 명령

아래 명령은 이번에 실행하지 않았다. 먼저 기존 2개보다 유의미하게 큰 **새 독립 검증 그룹**과 검수된 다양한 레이블을 확보해야 한다. 기존 대조 8쌍은 학습·튜닝에 사용하지 않는다.

```bash
# 소유자가 승인한 GPU만 지정. gpu.off·운영 모델 서버는 변경하지 않는다.
export CUDA_DEVICE_ORDER=PCI_BUS_ID CUDA_VISIBLE_DEVICES=6
$PY -m ml.train --train NEW_DATA/train.jsonl --validation NEW_DATA/validation.jsonl \
  --output /root/p14-work/cold-NEW-run/training --device cuda --label-mode cold-weak \
  --epochs 4 --max-steps 512 --batch-size 2 --accumulation 4 --learning-rate 2e-5 \
  --input-format context-pair-v2 --epoch-metrics
```

`NEW_DATA`는 현재 cold-weak 스키마·출처·완전한 대조 그룹 검증을 통과하는 데이터여야 한다. 다른 레이블 생성 규칙을 도입하면 validator도 그 출처와 그룹 구조를 검증하도록 별도 확장해야 한다. 미검수 queue를 그대로 넣지 않는다. `ml.phase1` 기본 실행은 기존 legacy 재현 경로이므로 v2 검증에는 위 명시적 학습 명령을 쓴다.

입력 직렬화 수정 효과와 데이터 개선 효과는 향후 고정 데이터·동일 학습 조건으로 나눠 비교한다. v2 tiny 모델 테스트 결과를 KcELECTRA 말투 성능으로 인용하지 않는다. 신규 모델이 충분히 평가될 때까지 ClassifierExpert는 실제 경고에 참여하지 않는다.
