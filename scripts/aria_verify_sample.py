"""Verify a downloaded official sample archive without exporting sensitive rows."""
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import zipfile

root = Path(__file__).resolve().parents[1]
archive = root / 'data/aria/aria_gen2_sample_data_1_mps_output_dec_2025.zip'
output = root / 'data/aria/closed_loop_trajectory.csv'
sha = hashlib.sha256()
with archive.open('rb') as source:
    for block in iter(lambda: source.read(1024 * 1024), b''):
        sha.update(block)
with zipfile.ZipFile(archive) as z:
    members = set(z.namelist())
    with z.open('slam/closed_loop_trajectory.csv') as src, output.open('wb') as dst:
        shutil.copyfileobj(src, dst)
spec = importlib.util.spec_from_file_location('mps_csv', root / 'src/aria/mps_csv.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
count = 0
first = last = None
maps = set()
for row in module.load_csv(output, 'pose'):
    count += 1
    if first is None: first = row['captureTsNs']
    last = row['captureTsNs']
    maps.add(row['mapId'])
print(json.dumps({'archiveSha256':sha.hexdigest(), 'archiveBytes':archive.stat().st_size,
  'poseRows':count, 'firstTimestampNs':first, 'lastTimestampNs':last, 'mapCount':len(maps),
  'generalGazePresent':'eye_gaze/general_eye_gaze.csv' in members, 'causalStatus':'offline_assisted'}))
