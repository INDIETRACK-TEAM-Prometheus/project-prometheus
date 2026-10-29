#!/usr/bin/env bash
set -euo pipefail
# Optional, manual network action. Obtain independent trusted hashes first.
: "${MEDIAPIPE_TGZ_SHA256:?Set the independently verified SHA-256 of tasks-vision-0.10.21.tgz}"
: "${FACE_MODEL_SHA256:?Set the independently verified SHA-256 of face_landmarker float16/1}"
[[ "$MEDIAPIPE_TGZ_SHA256" =~ ^[0-9a-fA-F]{64}$ && "$FACE_MODEL_SHA256" =~ ^[0-9a-fA-F]{64}$ ]] || { echo 'Expected 64-digit SHA-256 values' >&2; exit 1; }
destination="$(dirname "$0")/assets-0.10.21"
mkdir "$destination" # Refuse to overwrite an existing installation.
curl --fail --location --proto '=https' --output "$destination/tasks-vision-0.10.21.tgz" 'https://registry.npmjs.org/@mediapipe/tasks-vision/-/tasks-vision-0.10.21.tgz'
printf '%s  %s\n' "$MEDIAPIPE_TGZ_SHA256" "$destination/tasks-vision-0.10.21.tgz" | sha256sum --check
curl --fail --location --proto '=https' --output "$destination/face_landmarker.task" 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task'
printf '%s  %s\n' "$FACE_MODEL_SHA256" "$destination/face_landmarker.task" | sha256sum --check
tar -xzf "$destination/tasks-vision-0.10.21.tgz" -C "$destination"
printf 'Assets installed at %s\n' "$destination"
