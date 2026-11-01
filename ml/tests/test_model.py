import math

import pytest

from ml.model import encode, metrics, normalize_input


class Tokenizer:
    def encode(self, text, **kwargs):
        return list(text)

    def num_special_tokens_to_add(self, **kwargs):
        return 3

    def prepare_for_model(self, ids, pair_ids, **kwargs):
        return {"first": ids, "second": pair_ids}


def test_input_keeps_reply_recent_context_and_omits_emotion():
    row = {"relation": "친구", "context": [{"role": "them", "text": "old" * 200}],
           "last_them": "LATEST", "draft": "REPLY", "speaker_emotion": "SECRET"}
    encoded = encode(Tokenizer(), row, 64)
    assert "LATEST" in "".join(encoded["first"])
    assert "REPLY" in "".join(encoded["second"])
    assert "SECRET" not in "".join(encoded["first"])
    assert len(encoded["first"]) + len(encoded["second"]) + 3 <= 64


def test_metrics_confusion_and_zero_division():
    result = metrics([0, 0, 1, 1], [.1, .8, .7, .3])
    assert result["confusion_matrix"] == [[1, 1], [1, 1]]
    assert result["precision"] == result["recall"] == result["f1"] == .5
    assert metrics([0], [.1])["f1"] == 0
    with pytest.raises(ValueError):
        metrics([1], [math.nan])


def test_cuda_requires_explicit_gpu_selection(monkeypatch):
    pytest.importorskip("torch")
    from ml.model import device_for
    monkeypatch.delenv("CUDA_VISIBLE_DEVICES", raising=False)
    with pytest.raises(ValueError, match="CUDA_VISIBLE_DEVICES"):
        device_for("cuda")


def test_missing_relation_is_not_invented_and_empty_input_rejected():
    row = normalize_input({"last_them": "context", "draft": "reply"})
    assert row["relation"] == "" and row["context"] == []
    for bad in [{}, {"last_them": " ", "draft": "reply"},
                {"last_them": "context", "draft": "reply", "context": [{"role": "unknown", "text": "x"}]}]:
        with pytest.raises(ValueError):
            normalize_input(bad)


def test_generic_fast_tokenizer_v2_inserts_cls_sep_without_changing_legacy():
    tokenizers = pytest.importorskip("tokenizers")
    from transformers import PreTrainedTokenizerFast
    backend = tokenizers.Tokenizer(tokenizers.models.WordLevel(
        {"[UNK]":0,"[CLS]":1,"[SEP]":2,"[PAD]":3,"context":4,"reply":5},unk_token="[UNK]"))
    backend.pre_tokenizer = tokenizers.pre_tokenizers.Whitespace()
    tok = PreTrainedTokenizerFast(tokenizer_object=backend,unk_token="[UNK]",cls_token="[CLS]",sep_token="[SEP]",pad_token="[PAD]")
    assert tok.num_special_tokens_to_add(pair=True)==0
    row={"relation":"friend","context":[],"last_them":"context","draft":"reply"}
    legacy=encode(tok,row,64)
    fixed=encode(tok,row,64,input_format="context-pair-v2")
    assert legacy['input_ids'][0]!=tok.cls_token_id
    assert fixed['input_ids'][0]==tok.cls_token_id and fixed['input_ids'].count(tok.sep_token_id)==2
    assert fixed['attention_mask']==[1]*len(fixed['input_ids'])
    assert fixed['token_type_ids'][-1]==1 and len(fixed['input_ids'])<=64
    assert encode(tok,row,64)==legacy
    with pytest.raises(ValueError,match="unknown input format"):
        encode(tok,row,64,input_format="unknown")
