"""Verify the public Aria Gen2 VRS using the official SDK; emits summaries only."""
import argparse
import hashlib
import importlib.util
import importlib.metadata
import json
import math
from datetime import timedelta
from pathlib import Path

EXPECTED_SHA256 = '52e78d73dfc12b1d551292e0598b2babc7851c83297ebaab318686fb372f5c7f'

def sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda: f.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()

def indices(count):
    return sorted({0, count // 2, count - 1}) if count > 0 else []

def verify(vrs, mps_csv=None):
    report = {'schemaVersion':1, 'sample':'official_gen2_sample_data_1', 'vrsSha256':sha256(vrs),
              'status':'blocked', 'streams':[], 'rgb':None, 'gaze':None, 'calibration':None,
              'mpsPose':None, 'unavailableReasons':{}}
    if report['vrsSha256'] != EXPECTED_SHA256:
        report['unavailableReasons']['vrs'] = 'checksum_mismatch'
        return report
    try:
        from projectaria_tools.core import data_provider
        from projectaria_tools.core.sensor_data import TimeDomain
        report['sdkVersion'] = importlib.metadata.version('projectaria-tools')
    except Exception:
        report['unavailableReasons']['sdk'] = 'sdk_unavailable'
        return report
    try:
        provider = data_provider.create_vrs_data_provider(str(vrs))
        if provider is None: raise ValueError('provider unavailable')
        report['deviceVersion'] = str(provider.get_device_version())
        domains = [(name, getattr(TimeDomain,name)) for name in ('RECORD_TIME','DEVICE_TIME','HOST_TIME','TIME_CODE') if hasattr(TimeDomain,name)]
        for stream in provider.get_all_streams():
            count = provider.get_num_data(stream)
            supported = [name for name, domain in domains if provider.supports_time_domain(stream,domain)]
            first = provider.get_first_time_ns(stream,TimeDomain.DEVICE_TIME) if count and 'DEVICE_TIME' in supported else None
            last = provider.get_last_time_ns(stream,TimeDomain.DEVICE_TIME) if count and 'DEVICE_TIME' in supported else None
            report['streams'].append({'id':str(stream),'label':provider.get_label_from_stream_id(stream), 'count':count,'timeDomains':supported,'firstDeviceTimeNs':first,'lastDeviceTimeNs':last})
    except Exception:
        report['unavailableReasons']['vrs'] = 'provider_or_stream_inspection_failed'
        return report
    try:
        calib=provider.get_device_calibration()
        camera=calib.get_camera_calib('camera-rgb') if calib is not None else None
        cpf=calib.get_transform_device_cpf() if calib is not None else None
        report['calibration']={'devicePresent':calib is not None,'rgbCameraPresent':camera is not None,'deviceCpfTransformPresent':cpf is not None}
    except Exception:
        report['unavailableReasons']['calibration']='calibration_read_failed'
    try:
        rgb=provider.get_stream_id_from_label('camera-rgb')
        if rgb is None or provider.get_num_data(rgb)==0:
            report['unavailableReasons']['rgb']='stream_absent_or_empty'
        else:
            count=provider.get_num_data(rgb); samples=[]
            for index in indices(count):
                image, metadata=provider.get_image_data_by_index(rgb,index)
                if not image.is_valid(): raise ValueError('invalid image')
                array=image.to_numpy_array()
                if array.size == 0 or len(array.shape) < 2: raise ValueError('empty image')
                samples.append({'index':index,'captureTimestampNs':int(metadata.capture_timestamp_ns),'shape':list(array.shape)})
            report['rgb']={'streamId':str(rgb),'count':count,'decodedSamples':samples}
    except Exception:
        report['unavailableReasons']['rgb']='decode_failed'
    try:
        gaze=provider.get_stream_id_from_label('eyegaze')
        if gaze is None or provider.get_num_data(gaze)==0:
            report['unavailableReasons']['gaze']='stream_absent_or_empty'
        else:
            count=provider.get_num_data(gaze); samples=[]
            for index in indices(count):
                record=provider.get_eye_gaze_data_by_index(gaze,index)
                valid=bool(record.combined_gaze_valid) and math.isfinite(record.yaw) and math.isfinite(record.pitch)
                samples.append({'index':index,'trackingTimestampNs':int(record.tracking_timestamp // timedelta(microseconds=1))*1000,'combinedGazeValid':valid,'spatialGazePointValid':bool(record.spatial_gaze_point_valid)})
            report['gaze']={'streamId':str(gaze),'count':count,'samples':samples,'source':'on_device','causalStatus':'unknown'}
            if not any(sample['combinedGazeValid'] for sample in samples): report['unavailableReasons']['gaze']='no_valid_sample_among_checked_indices'
    except Exception:
        report['unavailableReasons']['gaze']='gaze_read_failed'
    if mps_csv is not None:
        try:
            spec=importlib.util.spec_from_file_location('mps_csv',Path(__file__).resolve().parents[1] / 'src/aria/mps_csv.py')
            module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
            rgb_samples=report['rgb']['decodedSamples'] if report['rgb'] else []
            if not rgb_samples: raise ValueError('no cutoff')
            cutoff=rgb_samples[-1]['captureTimestampNs']; rows=module.load_csv(mps_csv,'pose',cutoff//1000)
            count=0; last=None
            for row in rows: count+=1; last=row['captureTsNs']
            report['mpsPose']={'fileSha256':sha256(mps_csv),'cutoffDeviceTimeNs':cutoff,'rowCountAtOrBeforeCutoff':count,'lastDeviceTimeNs':last,'causalStatus':'offline_assisted'}
        except Exception:
            report['unavailableReasons']['mpsPose']='mps_read_or_cutoff_unavailable'
    else:
        report['unavailableReasons']['mpsPose']='not_supplied'
    report['status']='inspected' if report['rgb'] and report['calibration'] and report['calibration']['rgbCameraPresent'] and report['calibration']['deviceCpfTransformPresent'] and report['gaze'] and any(s['combinedGazeValid'] for s in report['gaze']['samples']) else 'partial'
    return report

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('vrs',type=Path); parser.add_argument('--mps-csv',type=Path); parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    try: report=verify(args.vrs,args.mps_csv)
    except Exception: report={'schemaVersion':1,'status':'blocked','unavailableReasons':{'input':'file_unavailable'}}
    args.output.write_text(json.dumps(report,indent=2,allow_nan=False)+'\n',encoding='utf-8')
    print(json.dumps({'status':report['status']}))
    return 0 if report['status']=='inspected' else 1
if __name__=='__main__':
    raise SystemExit(main())

