"""Stdlib-only launcher: creates its OWN venv, then runs ml.demo (no SSH/sudo)."""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path


def main() -> None:
    # --help must never install dependencies.
    if "--help" in sys.argv or "-h" in sys.argv:
        from .demo import main as demo_main
        demo_main()
        return
    from .demo import validate_gpu
    argv = sys.argv[1:]
    # Require the allowed GPU before downloads/venv changes in unattended execution.
    if "--gpu" not in argv or argv.index("--gpu") + 1 >= len(argv):
        if not sys.stdin.isatty():
            raise SystemExit("provide --gpu with the single approved GPU index")
        argv.extend(["--gpu", input("승인받은 GPU 번호(1개): ").strip()])
    gpu = validate_gpu(argv[argv.index("--gpu") + 1])
    if "--device" in argv and argv[argv.index("--device") + 1] != "cuda":
        raise SystemExit("bootstrap is a CUDA demo; run ml.demo directly for local CPU tests")
    env = {**os.environ, "CUDA_DEVICE_ORDER": "PCI_BUS_ID", "CUDA_VISIBLE_DEVICES": gpu, "PYTHONIOENCODING": "utf-8"}
    root = Path(__file__).resolve().parent.parent
    if any(part.lower() in {"tone-chat-deploy", "tone-chat-llm"} for part in root.parts):
        raise SystemExit("run from the independent P-14 source folder, outside production")
    venv = root / "ml/.venv-demo"
    python = venv / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    uv = shutil.which("uv")
    if not uv:
        raise SystemExit("uv is required; no system Python packages were changed")
    if not python.exists():
        if venv.exists():
            raise SystemExit("incomplete ml/.venv-demo exists; use a clean source folder")
        subprocess.run([uv, "venv", "--python", "3.10", str(venv)], cwd=root, env=env, check=True)
    subprocess.run([uv, "pip", "install", "--python", str(python), "torch==2.5.1",
                    "--index-url", "https://download.pytorch.org/whl/cu121"], cwd=root, env=env, check=True)
    subprocess.run([uv, "pip", "install", "--python", str(python), "-r", "ml/requirements.txt"], cwd=root, env=env, check=True)
    subprocess.run([str(python), "-m", "ml.demo", *argv], cwd=root, env=env, check=True)


if __name__ == "__main__":
    main()
