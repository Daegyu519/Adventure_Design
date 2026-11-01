"""Offline integration: real CPU backprop, never a mock training result."""
import argparse
import json
import subprocess
import sys

import pytest

from ml.demo import run_demo, validate_gpu
from ml.tests.test_training import make_tiny_model
from ml.tests.test_weak import write_raw


def test_unattended_pipeline_real_cpu_training_and_cli(tmp_path, monkeypatch):
    model = make_tiny_model(tmp_path / "tiny")
    monkeypatch.setenv("HF_HUB_OFFLINE", "1")
    monkeypatch.setenv("OMP_NUM_THREADS", "1")
    write_raw(tmp_path / "raw", "train", 8)
    write_raw(tmp_path / "raw", "validation", 4)
    args = argparse.Namespace(device="cpu", gpu=None, root=tmp_path / "raw", workdir=tmp_path / "demo",
                              skip_tests=True, train_size=16, validation_size=8, model=str(model), revision=None,
                              batch_size=2, epochs=2, max_steps=2)
    result = run_demo(args)
    assert result["status"] == "complete" and result["device"] == "cpu"
    assert result["optimizer_steps"] == 2
    assert all(delta > 0 for delta in result["weight_max_abs_delta"].values())
    assert result["reload_error"] <= 1e-6
    assert result["latency"]["latency_ms"]["p95"] > 0
    assert result["latency"]["human_approved"] is False
    assert result["latency"]["label_mode"] == "weak-demo"
    audit = json.loads((args.workdir / "training/weak_diagnostics.json").read_text(encoding="utf-8"))
    assert audit["baselines"]["length_only"]["accuracy"] == .5
    assert audit["baselines"]["reply_tokens_only"]["accuracy"] == .5
    assert audit["reply_only_ablation"]["accuracy"] == .5
    assert audit["context_only_ablation"]["accuracy"] == .5
    assert not list(args.workdir.rglob("*.csv"))
    with pytest.raises(FileExistsError):
        run_demo(args)


def test_failure_is_recorded_and_never_marks_success(tmp_path, monkeypatch):
    pytest.importorskip("torch")
    args = argparse.Namespace(device="cpu", gpu=None, root=tmp_path / "missing", workdir=tmp_path / "demo",
                              skip_tests=True, train_size=16, validation_size=8)
    with pytest.raises(subprocess.CalledProcessError):
        run_demo(args)
    failure = json.loads((args.workdir / "failure.json").read_text(encoding="utf-8"))
    assert failure["phase"] == "data"
    assert not (args.workdir / "summary.json").exists()


def test_gpu_selection_and_production_path_guards(tmp_path):
    for invalid in ("", "0,1", "-1", "8", "all", "0;command"):
        with pytest.raises(ValueError):
            validate_gpu(invalid)
    assert validate_gpu("3") == "3"
    pytest.importorskip("torch")
    args = argparse.Namespace(device="cpu", gpu=None, workdir=tmp_path / "tone-chat-deploy/demo")
    with pytest.raises(ValueError, match="production"):
        run_demo(args)


def test_bootstrap_missing_gpu_and_help_never_installs(monkeypatch, capsys):
    from ml.bootstrap import main
    monkeypatch.setattr(sys, "argv", ["bootstrap"])
    monkeypatch.setattr(sys.stdin, "isatty", lambda: False)
    with pytest.raises(SystemExit, match="provide --gpu"):
        main()
    monkeypatch.setattr(sys, "argv", ["bootstrap", "--help"])
    with pytest.raises(SystemExit) as error:
        main()
    assert error.value.code == 0
    assert "--gpu" in capsys.readouterr().out


def test_read_only_gpu_monitor_failure_is_explicit(monkeypatch):
    from ml.telemetry import gpu_sample
    def unavailable(*args, **kwargs):
        raise FileNotFoundError()
    monkeypatch.setattr(subprocess, "run", unavailable)
    assert gpu_sample("2")["status"] == "nvidia-smi unavailable"


def test_gpu_monitor_records_only_requested_index(monkeypatch, tmp_path):
    from types import SimpleNamespace
    from ml.telemetry import Monitor, gpu_sample
    calls = []
    def sample(argv, **kwargs):
        calls.append(argv)
        return SimpleNamespace(stdout="3, Tesla P100, 4096, 16384, 72\n")
    monkeypatch.setattr(subprocess, "run", sample)
    value = gpu_sample("3")
    assert value["utilization_percent"] == 72
    assert value["memory_used_mib"] == 4096
    assert calls[0][:3] == ["nvidia-smi", "-i", "3"]
    with Monitor("3", tmp_path / "gpu.jsonl"):
        pass
    assert len((tmp_path / "gpu.jsonl").read_text().splitlines()) == 2


def test_bootstrap_targets_only_dedicated_venv(monkeypatch, tmp_path):
    import ml.bootstrap as bootstrap
    source = tmp_path / "source"
    (source / "ml").mkdir(parents=True)
    monkeypatch.setattr(bootstrap, "__file__", str(source / "ml/bootstrap.py"))
    monkeypatch.setattr(sys, "argv", ["bootstrap", "--gpu", "4", "--max-steps", "1"])
    monkeypatch.setattr(bootstrap.shutil, "which", lambda _: "/test-only/uv")
    calls = []
    def capture(argv, **kwargs):
        calls.append((argv, kwargs))
    monkeypatch.setattr(subprocess, "run", capture)
    bootstrap.main()
    assert len(calls) == 4
    assert calls[0][0][1:3] == ["venv", "--python"]
    assert ".venv-demo" in calls[0][0][-1]
    assert all(c[1]["env"]["CUDA_VISIBLE_DEVICES"] == "4" for c in calls)
    assert all(c[1]["env"]["CUDA_DEVICE_ORDER"] == "PCI_BUS_ID" for c in calls)
    assert calls[-1][0][1:3] == ["-m", "ml.demo"]
