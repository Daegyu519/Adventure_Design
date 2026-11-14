import math

import pytest
import yaml

from app.settings import DEFAULT_MODELS_PATH
from harness.schemas import READINGS, ContextReading, Conversation, GateResult, ToneReading, Turn
from harness.store import ProfileStore
from layers import aggregate as A
from layers import gate

CFG = yaml.safe_load(DEFAULT_MODELS_PATH.read_text(encoding="utf-8"))["aggregate"]
CONVO = Conversation(pair_id="p", turns=[Turn(speaker="them", text="이거 미뤄도 될까요?")])
DRAFT = "안 돼요."
GATE = GateResult(prior=0.6, signals=["이유 없는 거절", "마침표로 끝남", "짧은 답"], passed=True)
# "이유 설명"은 문장에 없고 "확인"은 늘 채워진 것으로 본다 → violation 1/2
CTX = ContextReading(prev_act="부탁", expectation_points=["이유 설명", "확인"], confidence=0.8)


def tone(neg: float, conf: float = 0.8) -> ToneReading:
    return ToneReading(readings={"차갑게": neg, "무난하게": 1 - neg}, confidence=conf)


def run(tones, ctx=CTX, store=None, g=GATE, cfg=CFG):
    return A.aggregate(DRAFT, g, ctx, tones, store or ProfileStore(), CONVO, cfg)


def z_of(f: dict) -> float:
    w = CFG["weights"]
    return (w["bias"] + w["prior"] * f["prior"] + w["neg"] * f["neg"] + w["violation"] * f["violation"]
            + w["pattern"] * f["pattern"])


def test_single_expert_formula():
    v = run([(tone(0.7), 1.0)])
    f = v.features
    assert set(f) == {"prior", "neg", "violation", "pattern", "disagreement", "confidence"}
    assert f["prior"] == 0.6 and f["neg"] == pytest.approx(0.7) and f["violation"] == 0.5
    assert f["pattern"] == 0 and f["disagreement"] == 0 and f["confidence"] == pytest.approx(0.8)
    assert v.risk == round(1 / (1 + math.exp(-z_of(f))), 3)
    assert v.alert and not v.abstain and v.top_reading == "차갑게"
    assert "이유 설명 없음" in v.signals


def test_alert_top_reading_is_negative_max_not_merged_max():
    even = ToneReading(readings={"차갑게": 0.2, "성의없게": 0.2, "화나게": 0.2, "무난하게": 0.4}, confidence=0.8)
    v = run([(even, 1.0)], g=GATE.model_copy(update={"prior": 0.9}))
    assert v.alert and not v.abstain
    assert v.top_reading == "차갑게"            # 합친 읽힘의 최대는 무난하게(.4)지만 알림이면 부정 셋 중 최대


def test_quiet_top_reading_is_merged_max():
    v = run([(tone(0.3), 1.0)], ctx=None, g=GATE.model_copy(update={"prior": 0.0}))
    assert v.risk < CFG["alert_threshold"] and not v.alert and not v.abstain
    assert v.top_reading == "무난하게"


@pytest.mark.parametrize("bias,risk", [(-1e4, 0.0), (1e4, 1.0)])
def test_extreme_z_does_not_overflow(bias, risk):
    cfg = CFG | {"weights": CFG["weights"] | {"bias": bias}}
    assert run([(tone(0.5), 1.0)], cfg=cfg).risk == risk


def test_alpha_weighting():
    tones = [(tone(0.8, 1.0), 1.0), (tone(0.2, 0.25), 1.0)]
    assert run(tones).features["neg"] == pytest.approx((0.8 + 0.2 * 0.25) / 1.25)
    m = A.merged(tones)
    assert set(m) == set(READINGS)
    assert A.negative(m) == pytest.approx((0.8 + 0.2 * 0.25) / 1.25)


def test_two_agreeing_experts_alert():
    v = run([(tone(0.75), 1.0), (tone(0.65), 1.0)])
    assert v.disagreement == pytest.approx(0.1) and not v.abstain and v.alert


@pytest.mark.parametrize("tones", [[], [(tone(0.9), 0.0)], [(tone(0.9, 0.0), 1.0)]],
                         ids=["no-experts", "zero-weight-only", "zero-confidence-only"])
def test_zero_tone_experts_abstain(tones):
    v = run(tones)
    assert v.abstain and not v.alert
    assert v.risk == 0.0 and v.top_reading == "무난하게"


def test_disagreement_abstains():
    v = run([(tone(0.9), 1.0), (tone(0.1), 1.0)])
    assert v.disagreement == pytest.approx(0.8)
    assert v.abstain and not v.alert
    # 상세 경로는 이 값으로 "의견이 갈려서 기권"을 알아보고 심판에 묻는다(실시간은 그대로 기권)
    assert v.disagreement > CFG["max_disagreement"]


def test_zero_weight_ignored():
    v = run([(tone(0.9), 0.0), (tone(0.1), 1.0)])
    assert v.features["neg"] == pytest.approx(0.1)
    assert v.disagreement == 0


def test_missing_context_scores():
    v = run([(tone(0.7, 0.6), 1.0), (tone(0.7, 0.8), 1.0)], ctx=None)
    assert v.features["violation"] == 0
    assert v.confidence == pytest.approx(0.7)
    assert not v.abstain and 0 < v.risk < 1


def test_low_confidence_abstains():
    v = run([(tone(0.9, 0.2), 1.0)], ctx=CTX.model_copy(update={"confidence": 0.3}))
    assert v.confidence == pytest.approx(0.25)
    assert v.abstain and not v.alert
    # 의견 갈림이 아니므로 상세 경로도 심판에 묻지 않는다
    assert v.disagreement <= CFG["max_disagreement"]


# confidence는 위에서 범위 검사를 하지 않는다. 집계에서 [0, 1]로 자르고, NaN·무한대는 0(그 전문가를 안 씀)으로 본다.
def test_out_of_range_confidence_is_clamped():
    v = run([(tone(0.8, 5.0), 1.0), (tone(0.2, 1.0), 1.0)], ctx=None)
    assert v.features["neg"] == pytest.approx(0.5)      # 5.0이 1.0으로 잘려 두 전문가 α가 같다
    assert v.confidence == 1.0
    v = run([(tone(0.8, -0.5), 1.0), (tone(0.2, 1.0), 1.0)])
    assert v.features["neg"] == pytest.approx(0.2) and v.disagreement == 0


@pytest.mark.parametrize("bad", [float("nan"), float("inf")])
def test_non_finite_confidence_excludes_expert(bad):
    v = run([(tone(0.9, bad), 1.0), (tone(0.1, 0.8), 1.0)])
    assert v.features["neg"] == pytest.approx(0.1) and v.disagreement == 0
    assert all(math.isfinite(x) for x in v.features.values())
    assert run([(tone(0.9, bad), 1.0)]).abstain


def test_nan_context_confidence_counts_as_zero():
    v = run([(tone(0.9, 0.6), 1.0)], ctx=CTX.model_copy(update={"confidence": float("nan")}))
    assert v.confidence == pytest.approx(0.3)
    assert v.abstain and not v.alert


def store_with(global_count: int) -> ProfileStore:
    return ProfileStore(pair_patterns={"p": {"이유 없는 거절": {"count": 1, "strength": 3, "feeling": "차갑게"}}},
                        global_patterns={"이유 없는 거절": global_count})


@pytest.mark.parametrize("few", [1, CFG["global_min_obs"] - 1])
def test_one_report_alone_changes_nothing(few):
    n = CFG["global_min_obs"]
    tones = [(tone(0.5), 1.0)]
    base_g = gate.score(DRAFT, CONVO, ProfileStore(), "me", 0.3, n)
    base = A.aggregate(DRAFT, base_g, CTX, tones, ProfileStore(), CONVO, CFG)

    # L0: 신고가 기준보다 적으면 사전점수가 그대로
    few_g = gate.score(DRAFT, CONVO, store_with(few), "me", 0.3, n)
    assert few_g.prior == base_g.prior
    # L3: 같은 gate 결과로도 pattern 항이 0
    few_v = A.aggregate(DRAFT, few_g, CTX, tones, store_with(few), CONVO, CFG)
    assert few_v.risk == base.risk and not few_v.pattern_used and few_v.features["pattern"] == 0

    # 전체 관찰 수가 기준에 닿으면 두 레이어 모두 오른다
    many_g = gate.score(DRAFT, CONVO, store_with(n), "me", 0.3, n)
    assert many_g.prior > base_g.prior
    assert A.aggregate(DRAFT, base_g, CTX, tones, store_with(n), CONVO, CFG).features["pattern"] == 1.0
    many = A.aggregate(DRAFT, many_g, CTX, tones, store_with(n), CONVO, CFG)
    assert many.risk > base.risk and many.pattern_used


def test_missing_points_uses_tone_reason():
    reasoned = ToneReading(readings={"무난하게": 1}, has_reason=True)
    assert A.missing_points(DRAFT, CTX, [(tone(0.5), 1.0)]) == ["이유 설명"]
    assert A.missing_points(DRAFT, CTX, [(reasoned, 1.0)]) == []


def test_realtime_reading_from_cues_vent_then_model():
    # P-32: 실시간 알림 제목은 하소연 느낌 → 겉 신호 → 모델 최대. 정한 신호가 signals 맨 앞(이유 문구가 제목과 맞게)
    neg = ToneReading(readings={"차갑게": 0.1, "성의없게": 0.6, "화나게": 0.1, "무난하게": 0.2}, confidence=0.8)
    angry = GateResult(prior=0.6, signals=["짧은 답", "따지는 말투"], passed=True)
    v = A.aggregate("왜 매번 이래?", angry, None, [(neg, 1.0)], ProfileStore(), CONVO, CFG, cues=True)
    assert v.alert and v.top_reading == "화나게" and v.signals[0] == "따지는 말투"
    assert A.aggregate("왜 매번 이래?", angry, None, [(neg, 1.0)], ProfileStore(), CONVO, CFG).top_reading == "성의없게"
    plain = GateResult(prior=0.6, signals=["짧은 답"], passed=True)
    assert A.aggregate("음", plain, None, [(neg, 1.0)], ProfileStore(), CONVO, CFG, cues=True).top_reading == "성의없게"
    felt = ProfileStore(pair_patterns={"p": {"짧은 답": {"count": 1, "strength": 2, "feeling": "차갑게"}}},
                        global_patterns={"짧은 답": 1})
    cfg1 = {**CFG, "global_min_obs": 1}
    v = A.aggregate("왜 매번 이래?", angry, None, [(neg, 1.0)], felt, CONVO, cfg1, cues=True)
    assert v.top_reading == "차갑게" and v.signals[0] == "짧은 답" and v.pattern_used
    # 기준(5명) 아래면 하소연 느낌을 쓰지 않는다(규칙 7)
    assert A.aggregate("왜 매번 이래?", angry, None, [(neg, 1.0)], felt, CONVO, CFG, cues=True).top_reading == "화나게"


def test_gate_blame_and_consonant_cues():
    s = gate.score("왜 매번 이래?", CONVO, ProfileStore(), "me", 0.0, 5).signals
    assert "따지는 말투" in s
    assert "자음만 쓴 답" in gate.score("ㅇㅋ", CONVO, ProfileStore(), "me", 0.0, 5).signals
    for t in ("ㅋㅋ", "다 됐어!", "좋잖아"):
        sig = gate.score(t, CONVO, ProfileStore(), "me", 0.0, 5).signals
        assert "따지는 말투" not in sig and "자음만 쓴 답" not in sig, t


def test_profanity_cue_reads_angry():
    # P-33: 비속어(초성·띄어쓰기 포함)는 사전점수를 올리고 실시간 제목을 화나게로. 비슷한 낱말(시발점·시바견·새끼손가락)은 아니다
    for t in ("씨발 나도 몰라", "ㅅㅂ 진짜", "ㅈㄴ 귀찮게 하네", "꺼져"):
        g = gate.score(t, CONVO, ProfileStore(), "me", 0.0, 5)
        assert "비속어" in g.signals and g.prior >= 0.35, t
    for t in ("시발점이 어디야", "시바견 귀여워", "새끼손가락 다쳤어", "미친 맛있다"):
        assert "비속어" not in gate.score(t, CONVO, ProfileStore(), "me", 0.0, 5).signals, t
    neg = ToneReading(readings={"차갑게": 0.7, "화나게": 0.1, "무난하게": 0.2}, confidence=0.8)
    g = GateResult(prior=0.6, signals=["따지는 말투", "비속어"], passed=True)
    v = A.aggregate("ㅅㅂ 왜 이제 말해", g, None, [(neg, 1.0)], ProfileStore(), CONVO, CFG, cues=True)
    assert v.top_reading == "화나게" and v.signals[0] == "비속어"


def test_rough_word_false_positives_p42():
    score = lambda t: gate.score(t, CONVO, ProfileStore(), "me", 0.0, 5)  # noqa: E731
    # 강조어로만 쓴 거친 말 + 좋은 뜻: 비속어 아님. 욕 자체나 따지는 말이 있으면 그대로 비속어
    for t in ("존나 고마워", "ㅁㅊ 대박", "ㅈㄴ 맛있다", "졸라 웃겨"):
        assert "비속어" not in score(t).signals, t
    for t in ("존나 싫어", "ㅈㄴ 귀찮게 하네", "씨발 고마워", "존나 안 좋아", "존나 좋겠냐", "ㅈㄴ 좋은데 왜 이제 말해"):
        assert "비속어" in score(t).signals, t
    # 비슷한 낱말
    for t in ("그 말 계속 곱씹게 돼", "애가 졸라서 사줬어", "허리띠 졸라매야지"):
        assert "비속어" not in score(t).signals, t
    assert "비속어" in score("씹어 먹을 놈").signals and "비속어" in score("졸라 짜증나").signals
    # 공감하는 말은 따지는 말투가 아니다
    for t in ("진짜 짜증나겠다ㅠ", "와 열받겠다", "짜증날 만하네"):
        assert "따지는 말투" not in score(t).signals, t
    for t in ("아 짜증나", "열받네 진짜"):
        assert "따지는 말투" in score(t).signals, t
    # 욕·따지는 말에 붙은 느낌표·물결·"좀"은 사전점수를 깎지 않는다. 사과는 깎는다
    assert score("꺼져!").prior == score("꺼져").prior and score("좀 닥쳐~").prior == score("닥쳐").prior
    assert score("왜 매번 이래!").prior == score("왜 매번 이래").prior
    assert score("고마워!").prior <= score("고마워").prior          # 평범한 말에서는 그대로 누그러뜨림
    assert score("미안 씨발 깜빡했어").prior < score("씨발 깜빡했어").prior


def test_rough_level_table_p44():
    # 2026-11-15 사용자가 정한 강도 표. 강: 친해도 그대로 / 중 / 약
    from harness import korean as K
    table = {
        3: ["씨발련아", "시발련아", "개새끼야", "미친새끼야", "병신같은년아", "븅신새끼야", "니애미", "느금마", "씨발놈아"],
        2: ["병신아", "미친놈아", "ㅅㅂ아", "ㅅㅂ", "시발", "지랄하네", "좆같네", "꺼져", "닥쳐", "죽을래?",
            "ㅂㅅ", "ㅁㅊㄴ", "ㄷㅊ", "니엄마", "ㄴㅇㅁ", "개새끼ㅋㅋㅋ"],
        1: ["ㅅㅂㅋㅋㅋ", "ㅁㅊ다", "ㅁㅊ네", "미쳤네 진짜", "미친놈ㅋㅋ", "ㅈㄹㅋㅋ", "뭐래", "존나 싫어", "꺼져ㅋㅋ"],
        0: ["안녕", "알겠어", "존나 고마워", "ㅁㅊ 대박", "존나 웃기네", "시발점이 어디야", "새끼손가락 다쳤어", "곱씹게 돼", "미친 맛있다"],
    }
    for level, texts in table.items():
        for x in texts:
            assert K.rough_level(x) == level, (x, K.rough_level(x), level)
    # 가족을 건드리는 말은 웃음을 붙여도 강
    assert K.rough_level("니애미ㅋㅋㅋ") == 3
    # surface가 같이 내고, 기존 비속어 신호는 그대로다(판정에는 아직 안 쓴다)
    assert K.surface("씨발련아")["rough_level"] == 3 and K.surface("씨발련아")["profanity"]
    assert K.surface("꺼져ㅋㅋ")["rough_level"] == 1 and K.surface("꺼져ㅋㅋ")["profanity"]
