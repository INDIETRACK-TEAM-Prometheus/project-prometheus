from pathlib import Path

for path in ("/content/prometheus-depth/app", "/content/prometheus-depth/checkpoints"):
    Path(path).mkdir(parents=True, exist_ok=True)
# `colab upload` waits for an overwrite confirmation, so stale copies are removed before re-upload.
for name in ("model.py", "worker.py"):
    Path("/content/prometheus-depth/app", name).unlink(missing_ok=True)
print("prepared /content/prometheus-depth")
