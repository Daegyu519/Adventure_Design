"""Test-only HTTP shim around an exported TorchScript classifier (127.0.0.1 only).

Used by ml.ensemble_eval so the engine venv needs no torch. POST /predict {row} -> {score, latency_ms}.
"""
import argparse
import json
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

from .torchscript_infer import ScriptPredictor


def main() -> None:
    import torch
    # nvrtc fuser fails on this server's P100/TorchScript trace; plain kernels are fast enough (p95 ~13 ms)
    torch._C._jit_override_can_fuse_on_gpu(False)
    torch._C._jit_set_texpr_fuser_enabled(False)
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--export", type=Path, required=True)
    p.add_argument("--port", type=int, default=11480)
    p.add_argument("--device", choices=["cpu", "cuda"], default="cpu")
    a = p.parse_args()
    pred = ScriptPredictor(a.export, a.device)
    pred.predict({"relation": "친구", "last_them": "워밍업", "draft": "응", "context": []})

    class H(BaseHTTPRequestHandler):
        def do_POST(self):
            row = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            score, ms = pred.predict(row)
            body = json.dumps({"score": score, "latency_ms": ms}).encode()
            self.send_response(200); self.send_header("Content-Length", str(len(body))); self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    HTTPServer(("127.0.0.1", a.port), H).serve_forever()


if __name__ == "__main__":
    main()
