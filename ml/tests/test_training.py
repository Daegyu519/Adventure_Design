"""Real backpropagation with a tiny random LOCAL model, never a tone benchmark."""
import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from ml.data import finalize, read_jsonl
from ml.tests.test_data import reviewed


def make_tiny_model(model_path):
    torch = pytest.importorskip("torch")
    pytest.importorskip("transformers")
    from transformers import BertTokenizerFast, ElectraConfig, ElectraForSequenceClassification
    torch.set_num_threads(1)
    torch.manual_seed(14)
    model_path.mkdir()
    vocab = ["[PAD]", "[UNK]", "[CLS]", "[SEP]", "[MASK]", "context", "reply", "friend", "colleague", "-", "a", "b", ":"]
    (model_path / "vocab.txt").write_text("\n".join(vocab), encoding="utf-8")
    tokenizer = BertTokenizerFast(vocab_file=str(model_path / "vocab.txt"))
    tokenizer.save_pretrained(model_path)
    config = ElectraConfig(vocab_size=len(vocab), embedding_size=16, hidden_size=16,
                           num_hidden_layers=1, num_attention_heads=2, intermediate_size=32,
                           max_position_embeddings=256, num_labels=2)
    ElectraForSequenceClassification(config).save_pretrained(model_path)
    return model_path


def test_tiny_finetune_save_reload_and_cli(tmp_path):
    from ml.train import train
    model_path = make_tiny_model(tmp_path / "tiny")
    finalize(reviewed(tmp_path), tmp_path / "labeled")
    args = argparse.Namespace(train=tmp_path / "labeled/train.jsonl", validation=tmp_path / "labeled/validation.jsonl",
                              output=tmp_path / "run", device="cpu", model=str(model_path), revision=None,
                              epochs=2, max_steps=2, batch_size=1, accumulation=2, learning_rate=1e-3)
    args.epoch_metrics = True
    args.input_format = "context-pair-v2"
    result = train(args)
    assert result["optimizer_steps"] == 2
    assert all(v > 0 for v in result["weight_max_abs_delta"].values())
    assert result["reload_absolute_error"] <= 1e-6
    assert result["evaluation"]["n"] == 2
    assert len(read_jsonl(args.output / "loss.jsonl")) == 2
    epochs = read_jsonl(args.output / "epoch_metrics.jsonl")
    assert len(epochs) == 2 and epochs[-1]["optimizer_steps"] == 2
    assert set(epochs[0]["validation"]["recall_by_class"]) == {"0", "1"}
    checkpoint = args.output / "model"
    env = {**os.environ, "HF_HUB_OFFLINE": "1", "TOKENIZERS_PARALLELISM": "false",
           "OMP_NUM_THREADS": "1", "PYTHONIOENCODING": "utf-8"}
    common = [sys.executable, "-m"]
    inference = subprocess.run(common + ["ml.infer", "--checkpoint", str(checkpoint), "--device", "cpu",
                                          "--relation", "friend", "--last-them", "context", "--draft", "reply",
                                          "--warmup", "1", "--runs", "3"], capture_output=True, text=True,
                               encoding="utf-8", env=env, check=True)
    prediction = json.loads(inference.stdout)
    assert 0 <= prediction["cold_score"] <= 1
    assert prediction["latency_ms"]["runs"] == 3
    assert prediction["latency_ms"]["p95"] > 0
    evaluation = subprocess.run(common + ["ml.evaluate", "--checkpoint", str(checkpoint), "--data", str(args.validation),
                                          "--output", str(tmp_path / "reevaluation.json")], capture_output=True,
                               text=True, encoding="utf-8", env=env, check=True)
    assert json.loads(evaluation.stdout)["confusion_matrix"] == result["evaluation"]["confusion_matrix"]
    exported = tmp_path / "export"
    export = subprocess.run(common + ["ml.export", "--checkpoint", str(checkpoint), "--output", str(exported),
                                     "--inputs", str(args.validation), "--device", "cpu"], capture_output=True,
                            text=True, encoding="utf-8", env=env)
    assert export.returncode == 0, export.stderr
    verification = json.loads((exported / "verification.json").read_text())
    assert verification["fresh_process"] and verification["status"] == "passed"
    from ml.model import Predictor
    predictor = Predictor(checkpoint)
    rows = read_jsonl(args.validation)
    batch = predictor.predict_batch(rows)
    assert batch == pytest.approx([predictor.predict(r)[0] for r in rows], abs=1e-6)
