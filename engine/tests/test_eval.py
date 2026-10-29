import json
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
KEYS = {"precision", "recall", "abstain_rate", "context_split", "mode", "n"}


def run(*flags: str) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, str(REPO / "eval/run_eval.py"), *flags], cwd=REPO,
                          capture_output=True, text=True, timeout=120)


def test_eval_mock_json_meets_baseline():
    p = run("--mock", "--json")
    assert p.returncode == 0, p.stderr
    out = json.loads(p.stdout)   # stdout은 JSON 한 줄뿐이다
    assert KEYS <= out.keys()
    assert isinstance(out["precision"], float)
    assert out["mode"] == "mock"
    assert out["precision"] >= json.loads((REPO / "eval/baseline.json").read_text())["precision"]


def test_eval_detail_mode_runs():
    p = run("--mock", "--detail", "--json")
    assert p.returncode == 0, p.stderr
    assert json.loads(p.stdout)["n"] == 16
