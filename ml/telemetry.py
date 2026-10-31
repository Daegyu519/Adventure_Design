"""Read-only monitoring of the single explicitly allowed physical GPU."""
from __future__ import annotations

import json
import subprocess
import threading
import time
from pathlib import Path


def gpu_sample(gpu: str) -> dict:
    try:
        proc = subprocess.run(["nvidia-smi", "-i", gpu,
                               "--query-gpu=index,name,memory.used,memory.total,utilization.gpu",
                               "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=5, check=True)
        index, name, used, total, utilization = [part.strip() for part in proc.stdout.strip().split(",")]
        return {"time_unix": time.time(), "physical_gpu": index, "name": name,
                "memory_used_mib": float(used), "memory_total_mib": float(total), "utilization_percent": float(utilization)}
    except (OSError, subprocess.SubprocessError, ValueError):
        return {"time_unix": time.time(), "physical_gpu": gpu, "status": "nvidia-smi unavailable"}


class Monitor:
    def __init__(self, gpu: str, output: Path):
        self.gpu, self.output = gpu, output
        self.stop_event = threading.Event()
        self.thread = threading.Thread(target=self._loop, daemon=True)

    def _write(self) -> None:
        with self.output.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(gpu_sample(self.gpu)) + "\n")

    def _loop(self) -> None:
        while not self.stop_event.wait(2):
            self._write()

    def __enter__(self):
        self._write()
        self.thread.start()
        return self

    def __exit__(self, *args):
        self.stop_event.set()
        self.thread.join(timeout=6)
        self._write()
