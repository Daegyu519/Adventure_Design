# P-14 독립 말투 분류 파이프라인

2026-11-03(화) 시연 목표: AI-Hub 046 ZIP 읽기 → 검수한 이진 라벨 데이터 →
KcELECTRA GPU 가중치 업데이트 → 저장·재로드 → 새 입력 점수·지연 출력.
앱·엔진·배포는 사용하지 않는다. 이 문서의 서버 명령은 운영 폴더 밖 별도 체크아웃에서 실행한다.
이 구현 과정에서는 실제 GPU 서버에 접속하지 않았다.

## 수작업 없는 11월 3일 데모 (추가)

**사람 검수 데이터가 없는 시연은 아래 `weak-demo` 경로를 사용한다.** 기존 `finalize`의
사람 승인 조건은 유지되며 약한 레이블을 `approved`로 위장해 넣을 수 없다.
이 경로에서는 사용자에게 CSV나 Excel 편집을 요구하지 않는다.

서버 `/root/p14-work/source`에 새 소스 ZIP의 `ml/`을 반영한 뒤 다음 **한 명령**으로 실행한다.
N을 이미 사용 허가받은 GPU 번호(0~7 중 하나)로 바꾼다. 스크립트가 사용 허가를 판단하거나
빈 GPU를 임의로 선택하지 않는다. 번호를 생략하면 대화형 터미널에서 한 번 입력받고,
비대화형 실행에서는 오류로 종료한다.

```bash
cd /root/p14-work/source
python3 -m ml.bootstrap --gpu N
```

`bootstrap`은 확인된 uv를 이용해 **소스 폴더 안 `ml/.venv-demo`만** 생성하고
Python 3.10 / torch 2.5.1+cu121 / requirements를 설치한다. 시스템 Python 패키지와
기존 환경·운영 서비스는 수정하지 않는다. 최초 설치와 모델 다운로드에는 네트워크·디스크가 필요하다.
이미 독립 환경을 준비했다면 그 환경의 Python으로 직접 실행해 설치 단계를 생략할 수 있다:

```bash
# 실제 존재하는 독립 환경의 Python 경로를 사용한다.
ml/.venv/bin/python -m ml.demo --gpu N
```

기본 순서: 의존성 준비 → 테스트 → 원본 ZIP 전체 읽기/누수 감사 → 약한 레이블 선별 →
실제 KcELECTRA CUDA Fine-tuning → safetensors 저장 → 재로드 검증 →
held-out 실제 입력의 CLI 추론·지연 측정 → 별도 프로세스 재평가 → summary.json.
GPU 미검출·손실/gradient 비정상·가중치 미변경·누수·예제 부족이면 성공을 꾸미지 않고 실패한다.
모델 실패 시 mock·CPU·무작위 라벨로 대체하지 않는다.

기본값: 새 `/root/p14-work/auto-<UTC시각>/`, train 최대 1,024행 / validation 최대 256행,
FP32·길이256·배치2·누적8·2 epochs·최대64 optimizer steps. 데이터가 적으면 실제 step 수는
더 작을 수 있다. 1 GPU만 보이도록 **torch import 전** CUDA_DEVICE_ORDER=PCI_BUS_ID와
CUDA_VISIBLE_DEVICES를 설정한다.
P100에서 BF16/TF32/Flash Attention/분산 학습을 요청하지 않는다.
`--workdir`, `--train-size`, `--validation-size`, `--epochs`, `--max-steps`, `--batch-size`,
`--revision` 옵션으로 새 run의 설정을 조정할 수 있다. 행 수는 4의 배수여야 한다.
RAM·VRAM 부족 시 기존 run을 덮어쓰지 말고 새 경로에 `--batch-size 1`로 재시도한다.

### 약한 레이블 규칙과 한계

`weak.py`는 원본 listener 응답을 다음 조건으로만 선별한다:

1. 과거 speaker 발화에 어려움/걱정 등의 문자열 신호가 있고,
2. listener 응답에 공감/응원 계열 문자열 신호와 명시적 주제 단서가 있으며,
3. 응답의 인식된 주제 집합이 기존 맥락의 주제 집합 안에 있음.

이 조건에 해당하는 원본 응답만 weak 0 후보다. 원본 전체를 0으로 처리하지 않는다.
같은 관계의 다른 원본 대화에서 **최근 맥락의 주제 집합이 완전히 분리된** 후보를 찾는다.
두 후보의 답장을 대칭 교환해 주제 불일치 weak 1을 만든다. 무작위 대화 답변이나
짧다는 이유로 1을 만들지 않는다. 답장은 원문 전체 또는 공감·주제 단서를 포함하는
원문 문장 한 개의 **연속 부분 문자열**이다. 새로운 답장 문장을 작성·합성하지 않는다.
외부 LLM, ChatGPT/Claude/Codex의 문장·건별 판단을 데이터로 사용하지 않는다.
Python의 고정 정규식·문장 추출·대조 조합만 실행한다.

각 대조 묶음은 (맥락 A, 답 A,0), (맥락 B, 답 A,1), (맥락 B, 답 B,0), (맥락 A, 답 B,1)이다.
즉 **같은 답장도 같은 맥락도 각 레이블에 같은 횟수**로 들어간다. 문장 추출 변형도 양쪽에
가능한 경우에만 4행 단위로 보존한다. 따라서 답장 길이·특정 공감 키워드·관계·맥락 하나만
이용하는 분류기는 이 데이터에서 우연 수준 이상의 정확도를 얻을 수 없어야 한다.

이는 주제 적합성 대리 과제다. 현실의 주제 전환이 항상 차갑지는 않으며 공감 표현이 있어도
차갑게 읽힐 수 있다. 이 모델이 이 과제를 학습해도 실제 말투 판단 능력을 입증하지 못한다.
문자열 규칙은 부정·반어·다의어·간접 표현을 이해하지 못한다. 결과는 기술 검증용이다.

전체 train/validation을 각각 읽으며 모든 원본 대화 ID 중복을 검사한다.
관계×감정×응답 주제별 reservoir(기본64개)를 유지하고 관계별로 순환 선발한다.
기존 `reviews-balanced-v1`의 CSV·검수·후보는 수정하지 않으며, 원본 ZIP에서 독립적으로
재선별한다. 42조합 모두 선별된다고 보장하지 않고 실제 조합 분포를 기록한다.
명확한 대조 후보가 부족하면 더 약한 규칙으로 완화하지 않는다. 최소 train16행/validation8행이
없으면 실패하며, 충분하지만 요청 상한보다 작으면 실제 크기를 명시하고 진행한다.
기존 eval/contrast_set·T-16·사람 평가 데이터는 읽지 않는다.

각 데이터 행에는 `label`, `weak_label`(동일한 0/1), `label_source=heuristic`,
`human_approved=false`, `review_status=weak_unreviewed`, `generator`, `labeling_rule`,
`rule_version`, `transform`, `pair_id`, `source_conversation_ids`, `reply_source`,
`rule_evidence`를 기록한다. 답장을 가져온 대화의 split·ID·ZIP/JSON 출처도 보존한다.
누수 검사는 맥락뿐 아니라 **답장 원본 대화 ID까지** 포함한다.

### 자동 산출물과 편향 점검

| 파일 (새 auto-* 폴더 기준) | 내용 |
|---|---|
| `summary.json` | 전 단계 성공 후에만 생성되는 최종 증거 요약 |
| `failure.json`, `*.log` | 실패 단계·예외 종류, 단계별 실제 실행 로그 |
| `data/source_manifest.json` | 전체 읽기 수, 선별/기권 수, 실제 학습 행 수 |
| `data/weak_rules.json`, `data/weak_audit.json` | 규칙 전문·한계·출처, 양 클래스 답장/맥락 분포 일치 검사 |
| `data/train.jsonl`, `data/validation.jsonl` | 실제 원본으로 만든 미검수 weak 데이터 |
| `gpu.jsonl` | 2초 간격, 승인 GPU만 read-only nvidia-smi로 VRAM·사용률 기록 |
| `training/loss.jsonl` | step별 loss·gradient norm·torch VRAM 할당/예약/최대량 |
| `training/run.json` | 버전·설정·파일 SHA·GPU·가중치 변화·재로드 오차·최대 VRAM |
| `training/model/` | 실제 학습 모델·tokenizer·pipeline 메타데이터 |
| `training/weak_diagnostics.json` | 길이 stump·답장 token NB baseline, 모델의 답장만/맥락만 ablation, 동일 답장 맥락별 점수차 |
| `latency.json`, `reevaluation.json` | 저장 모델의 별도 CLI 추론 지연과 독립 프로세스 재평가 |
| `demo_input.json` | 자동 CLI 검사에 사용한 실제 validation 입력; 서버 전용 |

길이 stump와 token NB는 train으로만 맞추고 weak validation에서 평가한다.
주변 분포가 정확히 균형이므로 accuracy=0.5가 기대값이다. 모델의 답장만·맥락만 ablation도
같은 입력에 반대 레이블이 있으므로 약한 검증에서 0.5가 기대값이다.
full-input의 점수차·대조 구분이 나아지지 않을 수 있으며 이 경우도 그대로 보고한다.
baseline의 F1은 양성만 예측하면 약0.667이 될 수 있으므로 accuracy와 혼동행렬을 함께 본다.
이 진단은 고차 상관·대리 과제 편향을 제거하거나 실제 일반화 성능을 보장하지 않는다.
`gpu.jsonl`은 선택 GPU 전체 사용량(다른 프로세스 포함), torch 메모리는 이 프로세스 사용량이다.
nvidia-smi를 읽을 수 없으면 명시적으로 unavailable을 기록한다.

새 입력은 기존 CLI나 JSON 파일로 추론한다. JSON 객체는 relation, last_them, draft,
선택 context(시간순 them/me 배열)를 포함한다. 아래 경로의 auto-실행시각은 실제 폴더로 바꾼다:

```bash
ml/.venv-demo/bin/python -m ml.infer \
  --checkpoint /root/p14-work/auto-실행시각/training/model --device cuda \
  --input-json /root/p14-work/new-input.json
```

별도 쉘에서 추론할 때도 `export CUDA_DEVICE_ORDER=PCI_BUS_ID CUDA_VISIBLE_DEVICES=N`을 먼저 실행해야 한다.
추론 결과에 `label_mode=weak-demo`가 표시된다. cold_score는 미보정 점수다.
원본·학습 데이터·입력·모델·캐시는 서버에만 두고 GitHub에 올리지 않는다.
실패 후에는 failure.json의 phase에 해당하는 log를 읽고 새 workdir로 재실행한다.
자동 재실행이나 서비스 GPU 선점/종료, 원격 접속, 배포, 병합은 수행하지 않는다.

## 파일과 데이터 흐름

| 파일 | 역할 |
|---|---|
| `data.py` | 재귀 ZIP/JSON 읽기, 후보 추출, CSV 검수 내보내기·확정, 분할 검사 |
| `propose.py` | 별도로 생성한 변형 답안을 정답 없는 pending CSV로 반입 |
| `config.json` | 모델 이름·revision·길이·맥락 수·seed (운영 models.yaml과 독립) |
| `train.py` | Transformers Sequence Classification 전체 Fine-tuning, FP32·AdamW |
| `model.py` | 공용 토큰화, 체크포인트 로더, Precision/Recall/F1·혼동행렬 |
| `evaluate.py`, `infer.py` | 저장 모델 재평가, CLI 점수와 지연 측정 |
| `tests/` | 원본과 무관한 구조 fixture, 작은 무작위 ELECTRA로 오프라인 통합 검증 |

입력은 관계 + 최근 8턴(시간순, them/me) + 상대 최근 발화와 내 답장이다.
화자 감정·상황·출처는 추적용이며 모델 입력에는 넣지 않는다. 평점·공감도는 라벨로 쓰지 않는다.
맥락/답장 토큰을 별도로 배분해 긴 맥락이 답장을 없애지 않게 한다.
답장은 토큰 예산의 절반까지 앞부분, 맥락은 나머지 예산의 최근 부분을 유지한다.
긴 입력에서 일부 정보가 잘릴 수 있다. 학습·추론은 같은 함수를 쓴다.

## 1. 학교 서버의 독립 환경 (아직 실행하지 않은 명령)

`tone-chat-deploy`, `tone-chat-llm`, 시스템 패키지, 서비스의 gpu.off 스위치를 변경하지 않는다.
먼저 담당자에게 허용 GPU 번호를 확인한다. `nvidia-smi`는 사용 현황 참고이며 사용 허가가 아니다.

```bash
# 운영 폴더 밖에 준비한 p14-kcelectra 작업 브랜치의 저장소 루트에서 실행
uv venv --python 3.10 ml/.venv
uv pip install --python ml/.venv/bin/python torch==2.5.1 \
  --index-url https://download.pytorch.org/whl/cu121
uv pip install --python ml/.venv/bin/python -r ml/requirements.txt
export HF_HOME=/root/p14-work/hf-cache
export TOKENIZERS_PARALLELISM=false
mkdir -p /root/p14-work
ml/.venv/bin/python -m pytest ml/tests -q
```

PyTorch 2.5.1+cu121, Transformers 4.49.0에 맞췄다. `uv pip`는 지정 venv만 수정한다.
P100용 기본값은 FP32다. BF16·TF32·Flash Attention·분산 학습을 요청하지 않는다.
첫 실행은 배치 4, 길이 256, 누적 4, 최대 20 optimizer step이다.
메모리 부족 시 새 run 경로에서 `--batch-size 2 --accumulation 8`로 줄인다.
모델 다운로드에는 네트워크가 필요하며, 첫 다운로드 뒤 run.json에 기록된
`resolved_commit`을 `--revision <SHA>`로 지정하면 모델 revision을 고정할 수 있다.

## 2. 실제 ZIP 읽기·검수 후보 만들기

```bash
ml/.venv/bin/python -m ml.data prepare \
  --root /root/p14-data --output /root/p14-work/reviews-small --limit-per-split 128
```

`train/`, `validation/` 아래 모든 ZIP과 그 내부 JSON을 직접 읽는다.
TL_/VL_ 같은 이름은 가정하지 않는다. ZIP을 풀어 쓰지 않는다.
후보 수 제한은 내보내기에만 적용하며 전체 원본 ID를 읽어 분할 중복을 검사한다.
잘못된 ZIP/JSON/발화, 원본 ID 중복, 데이터 없는 경로는 즉시 실패한다.
source_manifest.json은 전체 ZIP 수·대화 수·listener 후보 수와 실제 내보낸 수를 구분한다.
성공 시 읽기 오류는 0이다. 실패 시 성공 manifest를 만들지 않는다(새 출력 경로 사용 권장).

사용자가 확인한 전체 규모와 대조한다(이 환경에서 재확인한 수치는 아님):

| 분할 | ZIP | 대화 | listener 응답 |
|---|---:|---:|---:|
| train | 42 | 25,456 | 181,802 |
| validation | 42 | 3,182 | 22,554 |

각 후보는 원본 대화 ID·발화 인덱스·관계·감정·상황·최근 맥락·실제 응답·
ZIP 상대 경로·내부 JSON 경로·JSON SHA256을 보존한다. 미래 발화는 넣지 않는다.
후보 JSONL은 검수할 때 읽는 맥락 원장이다. 원본 구조에 추가 메타데이터가 있어도 무시한다.

## 3. 변형 생성과 사람 검수 (공식 reviewed 경로에서 필수)

원본 답변도 `label=null`, CSV `status=pending`이다. 자동 label 0/1은 없다.
두 사람은 먼저 맥락·관계·초안을 보고 독립적으로 0/1/불확실을 기록하고,
불일치는 논의한 뒤 CSV에 합의 라벨과 근거를 남긴다. 불확실은 pending/rejected로 둔다.
시연용 소규모 검수부터 시작해 분할별 두 클래스가 모두 있도록 준비한다.

- 0: 이 관계·맥락에서 무난하게 읽힐 가능성이 높음.
- 1: 이 관계·맥락에서 차갑게 읽힐 가능성이 높음.
- 짧음·거절·반말 자체로 1을 주지 않는다. 간결한 정상 응답과 긴 차가운 응답도 검수한다.
- **각 분할 안에 같은 답장이 서로 다른 맥락에서 0/1이 되는 사례를 포함한다.**
  같은 문장의 서로 다른 맥락은 같은 원본 분할 안에서 찾는다. 맥락을 다른 분할에서 가져오지 않는다.
- 상대 감정·공감도·avg_rating은 정답이 아니다. 설명할 수 없는 자동 변형은 버린다.

부정 후보 생성은 별도 단계다. 사람이 직접 작성하거나, 서버에서 라이선스를 확인한
오픈 모델/버전을 고정한 규칙으로 작성한다. Claude·ChatGPT 출력은 학습 데이터로 쓰지 않는다.
이 코드에는 학습용 합성 문장이나 외부 LLM 호출을 넣지 않았다.

별도 생성 결과의 JSONL 필드: `candidate_id`, `draft`, `generator`.
`generator`는 `human`, `rule:<버전>`, `open-model:<모델 revision 및 라이선스>` 중 하나다.
candidate_id는 해당 분할 후보 원장의 ID여야 한다. 생성기가 제안한 라벨은 무시한다.

```bash
# 외부에서 만든 train.variants.jsonl을 같은 split의 후보에 연결
ml/.venv/bin/python -m ml.propose \
  --candidates /root/p14-work/reviews-small/train.candidates.jsonl \
  --variants /root/p14-work/train.variants.jsonl \
  --output /root/p14-work/reviews-small/train.with-variants.csv
# 검수 전에 train.with-variants.csv를 train.review.csv로 선택한다.
# validation도 동일한 절차. 기존 검수 결과는 덮어쓰지 말고 별도 백업한다.
```

변형이 적으면 review.csv에 candidate_id를 복사한 새 행을 직접 추가해도 된다.
원본은 generator=original, 수정 답안은 human 또는 생성기 출처를 적는다.
CSV의 확정 필드: `label=0/1`, `status=approved`, `reviewer`, `rationale`.
맥락·관계·원본 응답은 후보 JSONL에서 읽으므로 CSV에는 중복 저장하지 않는다.
CSV는 UTF-8 BOM이며 줄바꿈·쉼표는 표준 CSV 인용을 쓴다.

```bash
ml/.venv/bin/python -m ml.data finalize \
  --reviews /root/p14-work/reviews-small --output /root/p14-work/labeled-small
```

승인과 근거가 없는 행은 학습할 수 없다. train/validation을 재분할하지 않는다.
대화 ID·동일 전체 입력의 분할 누수와 중복 예제를 검사한다.
label_audit.json에 클래스 수·클래스별 평균 글자 수·동일 답장의 상반 라벨 수를 남긴다.
길이 편향은 평균만으로 해소되지 않으므로 검수자는 길이 분포·관계별 균형도 점검한다.
후보·CSV·라벨 JSONL은 실제 데이터이므로 서버에만 둔다. eval/contrast_set.jsonl,
T-16 및 별도 사람 평가 데이터는 이 경로로 반입하지 않는다.

## 4. 최초 GPU 학습·저장·재로드

```bash
# 반드시 담당자가 승인한 번호를 입력. 미설정 시 cuda 실행은 실패한다.
read -r -p '승인된 GPU 번호: ' P14_GPU
export CUDA_VISIBLE_DEVICES="$P14_GPU"
ml/.venv/bin/python -c 'import torch; print(torch.__version__, torch.cuda.is_available()); print(torch.cuda.get_device_name(0))'

ml/.venv/bin/python -m ml.train \
  --train /root/p14-work/labeled-small/train.jsonl \
  --validation /root/p14-work/labeled-small/validation.jsonl \
  --output /root/p14-work/runs/demo-01 --device cuda \
  --batch-size 4 --accumulation 4 --epochs 1 --max-steps 20
```

CUDA가 없으면 CPU로 조용히 대체하지 않고 실패한다. CUDA 선택 뒤 프로세스 안의 cuda:0은
허용 목록의 첫 GPU다. 이 스크립트는 GPU 한 개만 쓰며 torchrun으로 실행하지 않는다.
분류 head 초기화 경고는 정상이다. ELECTRA encoder도 함께 학습한다.
`max-steps`는 상한이므로 데이터가 적으면 한 epoch의 실제 step 수는 더 작다.

결과:

- `loss.jsonl`: 매 optimizer step 학습 손실·gradient norm.
- `model/`: safetensors 가중치·모델 config·tokenizer·pipeline.json. 네트워크 없이 재로드 가능.
- `optimizer.pt`: optimizer 상태/step 참고용. 자동 학습 재개 기능은 이번 범위에 없다.
- `evaluation.json`: validation의 positive class=1 Precision/Recall/F1·accuracy·혼동행렬.
- `run.json`: GPU 이름·CUDA_VISIBLE_DEVICES·패키지 버전·seed·학습 설정·입력 파일 SHA256·
  모델 commit·데이터 감사·encoder 및 head 행렬 변화량·저장 전후 점수 오차.

encoder/head 변화가 0이거나 손실/gradient가 비정상이면 실패한다.
실제 GPU 업데이트 입증은 run.json의 device=cuda, GPU=P100, optimizer_steps>0,
두 행렬의 weight_max_abs_delta>0, reload_absolute_error<=1e-6와 loss.jsonl을 함께 확인한다.
독립 CPU 테스트의 업데이트는 서버 GPU 학습 증거로 쓰지 않는다.

확장 시 새 디렉터리로 `prepare`의 limit을 제거하고 검수를 확대한 뒤 새 run에 학습한다.
현재 스크립트는 전체 토큰화 결과를 RAM에 보관하므로 전체 규모 전환 때 RAM 사용량도 확인한다.
validation으로 반복 튜닝한 뒤 그 수치를 독립 평가로 주장하지 않는다.

## 5. 저장 모델 평가·CLI 추론·지연

```bash
ml/.venv/bin/python -m ml.evaluate \
  --checkpoint /root/p14-work/runs/demo-01/model \
  --data /root/p14-work/labeled-small/validation.jsonl \
  --output /root/p14-work/runs/demo-01/reevaluation.json --device cuda

# 실제 시연 입력을 터미널에서 받는다. 대화 원문을 로그 파일에 남기지 않는다.
read -r -p '관계: ' P14_RELATION
read -r -p '상대 최근 발화: ' P14_LAST
read -r -p '보낼 답장: ' P14_DRAFT
ml/.venv/bin/python -m ml.infer \
  --checkpoint /root/p14-work/runs/demo-01/model --device cuda \
  --relation "$P14_RELATION" --last-them "$P14_LAST" --draft "$P14_DRAFT" \
  --warmup 5 --runs 30 --output /root/p14-work/runs/demo-01/latency.json
```

최근 맥락은 `--context /root/p14-work/demo-context.json`으로 추가한다.
JSON 배열의 각 원소는 `role`(them/me), `text` 문자열이다. 오래된 순으로 넣는다.
context 없이도 관계·상대 최근 발화·답장만으로 시연할 수 있다.
CPU 추론은 `--device cpu`로 가능하다.

출력은 label(0/1), cold_score(softmax의 1번 클래스), 임계값(기본 0.5),
모델 로드/첫 추론/p50/p95 지연이다. 점수는 보정된 실제 확률로 해석하지 않는다.
CUDA 동기화로 실제 계산을 기다린다. 반복 지연은 배치 1의 토큰화·전송·forward·softmax를
포함하고 모델 로드는 제외한다. 한 입력 반복의 warm latency이므로 다양한 길이·부하의
운영 p95와 다르다. 30ms/50ms 목표 달성 여부는 P100 실제 측정 전까지 미확인이다.

## 검증 범위와 후속 작업

`python -m pytest ml/tests -q`: 외부 모델 다운로드와 GPU 없이 수행 가능.
tiny ELECTRA 통합 테스트는 테스트용 vocab·무작위 가중치를 임시 폴더에 만들고,
실제 역전파·저장·재로드·평가·CLI를 확인한다. KcELECTRA 성능 검증은 아니다.
개발 환경의 실제 결과는 함께 제공하는 구현 보고서를 참고한다.

시연에서는 source_manifest, label_audit, loss, run, evaluation, latency를 제시한다.
소규모 검수/합성 후보 기반 validation 수치는 기술 검증이다. 별도의 블라인드 사람 라벨
평가에서 일반화·맥락 구분·관계별 성능을 확인하기 전에는 말투 분류 성능을 확정하지 않는다.
이번 변경은 운영 엔진 통합·ONNX/TorchScript 내보내기·배포·병합을 포함하지 않는다.

참고: [KcELECTRA 모델 카드](https://huggingface.co/beomi/KcELECTRA-base),
[Transformers 4.49 문서](https://huggingface.co/docs/transformers/v4.49.0/en/model_doc/electra).
