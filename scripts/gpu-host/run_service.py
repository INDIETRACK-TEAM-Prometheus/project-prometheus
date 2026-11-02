"""Run one Prometheus GPU service (scripts/colab/*_service.py) as a plain process on a self-hosted GPU.

In Colab the notebook kernel keeps the service's daemon HTTP thread alive; here the main thread waits instead.
"""

import runpy
import sys
import threading

service_path, service_name = sys.argv[1], sys.argv[2]
if service_name not in {"depth", "gaze"}:
    raise SystemExit("unsupported Prometheus GPU service")
runpy.run_path(service_path, run_name="_prometheus_{}_service".format(service_name))
print("{} service running".format(service_name), flush=True)
threading.Event().wait()
