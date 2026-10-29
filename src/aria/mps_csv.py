"""Read documented Aria Gen 2 MPS eye-gaze and closed-loop CSV into JSONL.

These are postprocessed offline records, never online-causal replay inputs.
"""
import argparse
import csv
import hashlib
import json
import math
from pathlib import Path


def load_csv(path, kind, cutoff_us=None):
    path = Path(path)
    if kind not in ('gaze', 'pose'):
        raise ValueError('unsupported kind')
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    fields = (['yaw_rads_cpf', 'pitch_rads_cpf'] if kind == 'gaze' else
              ['tx_world_device', 'ty_world_device', 'tz_world_device', 'qx_world_device', 'qy_world_device', 'qz_world_device', 'qw_world_device'])
    with path.open(encoding='utf-8-sig', newline='') as source:
        rows = csv.DictReader(source)
        required = ['tracking_timestamp_us', *fields] + (['graph_uid'] if kind == 'pose' else [])
        if not rows.fieldnames or any(name not in rows.fieldnames for name in required):
            raise ValueError('missing required Gen2 MPS columns')
        previous = -1
        for index, row in enumerate(rows):
            ts = int(row['tracking_timestamp_us'])
            if ts < 0 or ts < previous:
                raise ValueError('invalid timestamp order')
            previous = ts
            if cutoff_us is not None and ts > cutoff_us:
                break
            values = [float(row[key]) for key in fields]
            if not all(math.isfinite(value) for value in values):
                raise ValueError('nonfinite sample')
            item = {'schemaVersion': 1, 'id': f'{kind}-{index}', 'type': kind,
                    'captureTsNs': ts * 1000, 'sourceClockId': 'aria_device_time',
                    'source': 'aria_gen2_mps', 'causalStatus': 'offline_assisted',
                    'processedAt': None, 'processedAtUnavailableReason': 'mps_processing_time_not_provided',
                    'provenance': {'fileSha256': digest, 'row': index + 2},
                    'imageRef': None, 'depth': None, 'calibration': None,
                    'unavailableReasons': {'imageRef': 'vrs_not_loaded', 'depth': 'not_in_mps_csv', 'calibration': 'not_loaded'}}
            if kind == 'gaze':
                item.update({'yawRad': values[0], 'pitchRad': values[1], 'coordinateFrame': 'central_pupil_frame'})
            else:
                if not row['graph_uid']:
                    raise ValueError('missing map id')
                item.update({'translationM': values[:3], 'quaternionXyzw': values[3:], 'coordinateFrame': 'world', 'mapId': row['graph_uid']})
            yield item


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('kind', choices=('gaze', 'pose'))
    parser.add_argument('csv_file')
    parser.add_argument('--cutoff-us', type=int)
    args = parser.parse_args()
    if args.cutoff_us is not None and args.cutoff_us < 0:
        parser.error('cutoff must be nonnegative')
    for record in load_csv(args.csv_file, args.kind, args.cutoff_us):
        print(json.dumps(record, allow_nan=False, separators=(',', ':')))

if __name__ == '__main__':
    main()
