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


def run(tones, ctx=CTX, store=None, g=GATE):
    return A.aggregate(DRAFT, g, ctx, tones, store or ProfileStore(), CONVO, CFG)


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
