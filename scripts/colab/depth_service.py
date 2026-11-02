"""Depth Anything V2 Metric Hypersim Small on a Colab GPU, served on the VM's loopback only.

Run inside a Colab session with `colab exec -f scripts/colab/depth_service.py --timeout 900` after
uploading scripts/depth/model.py and worker.py to /content/prometheus-depth/app/. The HTTP server
listens on 127.0.0.1:8765 inside the VM and is reached only through the SSH tunnel opened by
scripts/colab/start-depth.ps1. It reuses the local worker's request validation and output format.
"""

import gzip
import io
import json
import os
import shutil
import subprocess
import sys
import threading
import urllib.request
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# Colab by default; a self-hosted GPU (scripts/gpu-host) points this at its own directory.
HOME = Path(os.environ.get("PROMETHEUS_DEPTH_HOME", "/content/prometheus-depth"))
BACKEND_LABEL = "ssh_remote" if os.environ.get("PROMETHEUS_BACKEND_LABEL") == "ssh_remote" else "colab_remote"
APP = HOME / "app"
PORT = 8765
SOURCE_COMMIT = "a561b849ebae10a6f5ef49e26c83cbbcd36c71bf"
SOURCE_ZIP = f"https://github.com/DepthAnything/Depth-Anything-V2/archive/{SOURCE_COMMIT}.zip"
CHECKPOINT_URL = "https://huggingface.co/depth-anything/Depth-Anything-V2-Metric-Hypersim-Small/resolve/main/depth_anything_v2_metric_hypersim_vits.pth"


def encode_reply(value, accept_encoding):
    body = json.dumps(value, separators=(",", ":"), allow_nan=False).encode("ascii")
    encodings = {}
    for item in accept_encoding.split(","):
        parts = [part.strip() for part in item.split(";")]
        try:
            encodings[parts[0].lower()] = float(parts[1][2:]) if len(parts) > 1 and parts[1].lower().startswith("q=") else 1.0
        except ValueError:
            encodings[parts[0].lower()] = 0.0
    gzip_enabled = encodings.get("gzip", encodings.get("*", 0.0)) > 0
    return (gzip.compress(body, compresslevel=1, mtime=0) if gzip_enabled else body), gzip_enabled


def fetch(url, timeout=300):
    with urllib.request.urlopen(url, timeout=timeout) as response:
        return response.read()


def download(url, destination, timeout=300):
    destination.parent.mkdir(parents=True, exist_ok=True)
    next_progress = 16 * 1024 * 1024
    received = 0
    with urllib.request.urlopen(url, timeout=timeout) as response, destination.open("wb") as output:
        total = int(response.headers.get("Content-Length") or 0)
        while chunk := response.read(8 * 1024 * 1024):
            output.write(chunk)
            received += len(chunk)
            if received >= next_progress:
                size = f"/{total}" if total else ""
                print(f"checkpoint download: {received}{size} bytes", flush=True)
                next_progress += 16 * 1024 * 1024


XFORMERS_VERSION = "0.0.35"
# Run in a separate interpreter so a broken binary can never crash the service: a real GPU attention call must match PyTorch.
XFORMERS_VERIFY_CODE = """
import sys, torch
import xformers
import xformers.ops as ops
if not torch.cuda.is_available():
    sys.exit(2)
generator = torch.Generator(device="cuda").manual_seed(7)
q, k, v = (torch.randn(1, 64, 6, 64, device="cuda", generator=generator) for _ in range(3))
got = ops.memory_efficient_attention(q, k, v)
want = torch.nn.functional.scaled_dot_product_attention(q.transpose(1, 2), k.transpose(1, 2), v.transpose(1, 2)).transpose(1, 2)
if not torch.isfinite(got).all() or (got - want).abs().max().item() > 1e-3:
    sys.exit(3)
print(xformers.__version__)
"""


def ensure_xformers(run=subprocess.run, environ=None, python=sys.executable):
    """Install the optional xFormers accelerator for the DINOv2 attention and return its version, or None.

    Never required and never allowed to break the service: torch is not touched (--no-deps), the install must pass a
    real GPU attention check in a separate process, and any failure removes xFormers so DINOv2 uses plain PyTorch attention.
    """
    import os
    if (os.environ if environ is None else environ).get("PROMETHEUS_XFORMERS") == "0":
        return None

    def verified():
        try:
            result = run([python, "-c", XFORMERS_VERIFY_CODE], capture_output=True, text=True, timeout=300)
        except Exception:
            return False
        return result.returncode == 0 and result.stdout.strip().splitlines()[-1:] == [XFORMERS_VERSION]

    try:
        if verified():
            return XFORMERS_VERSION
        install = run([python, "-m", "pip", "install", "--no-deps", "--quiet", "--disable-pip-version-check", f"xformers=={XFORMERS_VERSION}"],
                      capture_output=True, text=True, timeout=600)
        if install.returncode == 0 and verified():
            return XFORMERS_VERSION
    except Exception:
        pass
    try:
        run([python, "-m", "pip", "uninstall", "-y", "--quiet", "--disable-pip-version-check", "xformers"], capture_output=True, text=True, timeout=300)
    except Exception:
        pass
    return None


def bootstrap():
    if not (APP / "model.py").is_file() or not (APP / "worker.py").is_file():
        raise SystemExit("upload scripts/depth/model.py and worker.py to /content/prometheus-depth/app first")
    sys.path.insert(0, str(APP))
    import model as depth_model
    if depth_model.SOURCE_COMMIT != SOURCE_COMMIT:
        raise SystemExit("uploaded model.py pins a different source commit")
    source = HOME / "source"
    if not (source / "metric_depth" / "depth_anything_v2" / "dpt.py").is_file():
        print("downloading pinned Depth Anything source", flush=True)
        archive = zipfile.ZipFile(io.BytesIO(fetch(SOURCE_ZIP)))
        staging = HOME / "source-extract"
        shutil.rmtree(staging, ignore_errors=True)
        archive.extractall(staging)
        shutil.rmtree(source, ignore_errors=True)
        shutil.move(str(staging / f"Depth-Anything-V2-{SOURCE_COMMIT}"), str(source))
        shutil.rmtree(staging, ignore_errors=True)
        print("pinned source ready", flush=True)
    checkpoint = depth_model.checkpoint_path(HOME)
    try:
        depth_model.verify_checkpoint(HOME)
    except depth_model.DepthFailure:
        print("downloading pinned Hypersim checkpoint", flush=True)
        download(CHECKPOINT_URL, checkpoint)
        depth_model.verify_checkpoint(HOME)
    import torch
    import worker
    print("loading checkpoint on CUDA", flush=True)
    xformers_version = ensure_xformers()   # before the DINOv2 modules are imported by load_model
    print(json.dumps({"xformers": xformers_version or "unavailable"}), flush=True)
    model, checkpoint_hash, load_ms = depth_model.load_model(HOME, device="cuda")
    gpu = subprocess.run(["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"], capture_output=True, text=True).stdout.strip()
    ready = {
        "type": "ready", "status": "ready", "model": depth_model.model_metadata(checkpoint_hash, "cuda"), "modelLoadMs": load_ms,
        "pythonVersion": sys.version.split()[0], "torchVersion": torch.__version__, "device": "cuda", "gpu": gpu or None,
        "backend": BACKEND_LABEL, "accelerators": {"xformers": xformers_version},
    }
    return model, checkpoint_hash, ready, worker, depth_model


def serve(model, checkpoint_hash, ready, worker, depth_model):
    lock = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def reply(self, status, value):
            body, gzip_enabled = encode_reply(value, self.headers.get("Accept-Encoding", ""))
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Vary", "Accept-Encoding")
            if gzip_enabled:
                self.send_header("Content-Encoding", "gzip")
            if self.close_connection:
                self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            content_lengths = self.headers.get_all("Content-Length", [])
            if self.headers.get("Transfer-Encoding") or len(content_lengths) > 1 or any(value.strip() != "0" for value in content_lengths):
                self.close_connection = True
                self.reply(400, {"status": "error", "error": "DEPTH_INVALID_REQUEST"})
                return
            if self.path == "/health":
                self.reply(200, ready)
            else:
                self.close_connection = True
                self.reply(404, {"status": "error", "error": "not_found"})

        def do_POST(self):
            if self.path != "/infer":
                self.close_connection = True
                self.reply(404, {"status": "error", "error": "not_found"})
                return
            if self.headers.get("Transfer-Encoding"):
                self.close_connection = True
                self.reply(400, {"id": None, "status": "error", "error": "DEPTH_INVALID_REQUEST"})
                return
            content_lengths = self.headers.get_all("Content-Length", [])
            length_text = content_lengths[0].strip() if len(content_lengths) == 1 else ""
            if not length_text or not length_text.isascii() or not length_text.isdigit():
                self.close_connection = True
                self.reply(400, {"id": None, "status": "error", "error": "DEPTH_INVALID_REQUEST"})
                return
            length = int(length_text)
            if length <= 0:
                self.close_connection = True
                self.reply(400, {"id": None, "status": "error", "error": "DEPTH_INVALID_REQUEST"})
                return
            if length > depth_model.MAX_REQUEST_BYTES:
                self.close_connection = True
                self.reply(413, {"id": None, "status": "error", "error": "DEPTH_REQUEST_TOO_LARGE"})
                return
            raw = self.rfile.read(length)
            if not lock.acquire(blocking=False):
                self.reply(429, {"id": None, "status": "error", "error": "DEPTH_PROVIDER_BUSY"})
                return
            request_id = None
            try:
                request = json.loads(raw)
                if isinstance(request, dict) and isinstance(request.get("id"), str):
                    request_id = request["id"][:128]
                self.reply(200, worker.infer_request(model, checkpoint_hash, request, device="cuda"))
            except depth_model.DepthFailure as exc:
                self.reply(200, {"id": request_id, "status": "error", "error": exc.code})
            except (UnicodeDecodeError, json.JSONDecodeError):
                self.reply(200, {"id": request_id, "status": "error", "error": "DEPTH_INVALID_REQUEST"})
            except Exception:
                self.reply(200, {"id": request_id, "status": "error", "error": "DEPTH_INFERENCE_FAILED"})
            finally:
                lock.release()

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    threading.Thread(target=server.serve_forever, name="prometheus-depth", daemon=True).start()
    return server


if "_PROMETHEUS_DEPTH_SERVER" not in globals():
    _PROMETHEUS_DEPTH_SERVER = serve(*bootstrap())
print(json.dumps({"service": "prometheus-depth", "listening": f"127.0.0.1:{PORT}"}))
