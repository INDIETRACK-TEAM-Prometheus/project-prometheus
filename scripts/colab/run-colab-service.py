"""Run one Colab service in a persistent, isolated kernel namespace."""

import os
import runpy


service_path = os.environ.pop("PROMETHEUS_COLAB_SERVICE_PATH")
service_name = os.environ.pop("PROMETHEUS_COLAB_SERVICE_NAME")
if service_name not in {"depth", "gaze"}:
    raise SystemExit("unsupported Prometheus Colab service")

namespace_key = "_PROMETHEUS_{}_NAMESPACE".format(service_name.upper())
if namespace_key not in globals():
    globals()[namespace_key] = runpy.run_path(
        service_path, run_name="_prometheus_{}_service".format(service_name)
    )
