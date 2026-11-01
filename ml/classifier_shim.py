"""HTTP service around an exported TorchScript classifier (127.0.0.1 only; P-28).

POST /score {context:[{role:me|them,text}], draft, relation, last_them?} -> {score, latency_ms}
GET  /health -> {ok:true}
Bad input -> 400 {"error":"bad_request"}. Request text is never logged. The engine sends only masked text (rule 16).
`last_them` is optional: if absent, the last "them" turn of `context` is used.
"""
import argparse
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

MAX_BODY = 64 * 1024
MAX_TEXT = 4000
MAX_TURNS = 32


def parse_request(raw: bytes) -> dict:
    """Validate a /score body and return the model row. Raises ValueError on any problem (message carries no text)."""
    try:
        body = json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        raise ValueError("invalid json") from None
    if not isinstance(body, dict):
        raise ValueError("body must be an object")
    draft, relation, context = body.get("draft"), body.get("relation", ""), body.get("context", [])
    if not isinstance(draft, str) or not draft.strip() or len(draft) > MAX_TEXT:
        raise ValueError("draft")
    if not isinstance(relation, str) or len(relation) > 100:
        raise ValueError("relation")
    if not isinstance(context, list) or len(context) > MAX_TURNS:
        raise ValueError("context")
    for t in context:
        if (not isinstance(t, dict) or t.get("role") not in ("me", "them")
                or not isinstance(t.get("text"), str) or len(t["text"]) > MAX_TEXT):
            raise ValueError("context turn")
    last = body.get("last_them")
    if last is None:
        last = next((t["text"] for t in reversed(context) if t["role"] == "them"), "")
    if not isinstance(last, str) or not last.strip() or len(last) > MAX_TEXT:
        raise ValueError("last_them")
    return {"relation": relation, "last_them": last, "draft": draft, "context": context}


def make_handler(predict):
    lock = threading.Lock()   # one forward pass at a time on the device

    class H(BaseHTTPRequestHandler):
        def _send(self, code: int, obj: dict) -> None:
            body = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            self._send(200, {"ok": True}) if self.path == "/health" else self._send(404, {"error": "not_found"})

        def do_POST(self):
            if self.path != "/score":
                return self._send(404, {"error": "not_found"})
            try:
                n = int(self.headers.get("Content-Length", ""))
                if not 0 < n <= MAX_BODY:
                    raise ValueError("size")
                row = parse_request(self.rfile.read(n))
            except ValueError:
                return self._send(400, {"error": "bad_request"})
            try:
                with lock:
                    score, ms = predict(row)
            except Exception:   # noqa: BLE001 - message may hold text; send nothing
                return self._send(500, {"error": "internal"})
            self._send(200, {"score": score, "latency_ms": ms})

        def log_message(self, *args):   # never log request lines or text
            pass

    return H


def main() -> None:
    import torch
    from .torchscript_infer import ScriptPredictor
    # nvrtc fuser fails on this server's P100/TorchScript trace; plain kernels are fast enough (p95 ~13 ms)
    torch._C._jit_override_can_fuse_on_gpu(False)
    torch._C._jit_set_texpr_fuser_enabled(False)
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--export", type=Path, required=True)
    p.add_argument("--port", type=int, default=11481)
    p.add_argument("--device", choices=["cpu", "cuda"], default="cpu")
    a = p.parse_args()
    pred = ScriptPredictor(a.export, a.device)
    pred.predict({"relation": "친구", "last_them": "워밍업", "draft": "응", "context": []})
    ThreadingHTTPServer(("127.0.0.1", a.port), make_handler(pred.predict)).serve_forever()


if __name__ == "__main__":
    main()
