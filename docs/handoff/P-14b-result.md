# P-14b 결과 (2026-11-01, 숫자만. 데이터 행·가중치는 학교 서버 /root/p14b, Git 제외)

**결론: 채택 기준 미충족. 운영 설정 변경 없음.**

## 선생님 레이블
- 선생님: Qwen3-30B-A3B IQ3_XXS(임시 llama-server, GPU3, :11470, 끝나고 종료). 프롬프트 `engine/prompts/tone_fast.md`(해시 979f0f7ac1c2), temperature 0, 소프트 점수 = r[차갑게]+r[성의없게]+r[화나게], 이진 = 점수 >= 0.5, label_source=teacher:qwen3-30b-a3b.
- AI-Hub 046 train에서 관계별 균등 6,000행 + val 800행(관계 7종 각 약 857). 40%는 규칙 변형 답장(ack/refuse/topic/curt 고정 문구, 외부 LLM 문장 없음).
- 유효 JSON 6000/6000, 확신 >= 0.4 통과 6000. 양성 1,409(23.5%), val 양성 197/800.
- 변형별 양성: ack 111/590, curt 449/619, refuse 562/622, topic 249/627, 원래 답장 38/3542.
- 기존 규칙 레이블 234행과 비교(행=규칙 0/1, 열=선생님 0/1): [[154,2],[75,3]]. 선생님은 규칙의 "감정 맥락 뒤 ㅇㅇ" 양성 78개 중 3개만 잡음(둘의 정의가 다름).
- 선생님 점수 분포가 거칠다(분위수 0.1~0.25가 대부분, 높은 쪽 0.8~0.95).

## 분류기 (KcELECTRA-base, 소프트 CE, max_length 192, 4 epoch, 조기 종료 patience 1, val 소프트 손실 최소 epoch 사용)
- 선생님 val 일치(0.5): P 0.88 / R 0.85 (선생님을 따라 배운 정도일 뿐 정확도 아님).
- 대조 세트 16행 단독(contrast.py, context 비움) P/R: 0.3 -> 0.455/0.625, 0.4 -> 0.333/0.125, 0.5 -> 0.5/0.125, 0.6 -> 0/0.
- 엔진 입력(상대 발화를 context로 포함) 2회 합 32행: 0.3 -> 0.50/0.75, 0.4 -> 0.667/0.50, 0.5 -> 0.60/0.375, 0.6 -> 0.667/0.25.
- 지연(TorchScript, 단일 입력 300회): GPU P100 p50 12.2 ms / p95 13.0 ms, CPU(4스레드, 부하 평균 15인 공유 서버) p50 174 ms / p95 211 ms. GPU TorchScript는 nvrtc fuser 오류가 나서 fuser를 꺼야 함(`ml/classifier_shim.py`).

## 실시간 앙상블 (Gemma tone_fast :11435 + 분류기, OR 결합, 2회 x 16행)
| | P | R | p95 |
|---|---|---|---|
| Gemma 단독 | 1.0 | 0.25 | 878 ms |
| + 분류기 >= 0.3 | 0.50 | 0.75 | 878 ms |
| + 분류기 >= 0.4 | 0.714 | 0.625 | 878 ms |
| + 분류기 >= 0.5 | 0.667 | 0.50 | 878 ms |
| + 분류기 >= 0.6 | 0.75 | 0.375 | 878 ms |
분류기는 Gemma와 병렬 호출(HTTP 셈 p95 63 ms, 서버 GPU3 shim을 ssh 터널 11480으로 호출). 임계값은 대조 세트로 고르지 않았다.

## 채택 기준: 미충족
재현율은 Gemma보다 높지만(>0.25) 정밀도가 모든 임계값에서 0.9 미만(최대 0.75). 따라서 운영 연결 제안 없음.

## 재현
`python -m ml.teacher sample|label|report`, `python -m ml.train_soft`, `ml.export`, `ml.classifier_shim`(테스트용 HTTP), `ml.ensemble_eval`(설정 `ml/p14b_classifiers.test.yaml`, 테스트 전용).
