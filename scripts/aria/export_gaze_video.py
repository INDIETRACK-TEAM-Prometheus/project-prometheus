"""Export one Project Aria sequence (e.g. Aria Everyday Activities) as an upright RGB video plus the wearer's eye gaze in it.

Uses only the official projectaria_tools API (pip install projectaria-tools): the RGB stream from the VRS recording, MPS
general eye gaze, and the device calibration to re-project each gaze ray into the RGB camera. Output:

  <out>.mp4         H.264, upright, playable in the browser (needs ffmpeg on PATH)
  <out>.gaze.json   {"version":1, "source":..., "width":..., "height":..., "fps":..., "samples":[{"t":s, "x":0-1, "y":0-1}]}
  <out>.eyes.mp4    the eye-tracking camera (both eyes side by side) at the same frame times, so it plays in step

With --trajectory (MPS closed_loop_trajectory.csv) every sample also carries "pose": the RGB camera to world transform
(row-major 3x4, metres), and the file a "rays" grid: unit ray directions in the RGB camera frame on a regular grid over
the upright video (fisheye, so rays are looked up, not computed from a pinhole). A pixel plus a depth then gives a world
point, which is how the app keeps segmented objects in 3D while the wearer moves.

x/y are normalised to the upright video frame; t is seconds from the first exported frame (matches video.currentTime).

  python export_gaze_video.py --vrs recording.vrs --gaze mps/eye_gaze/general_eye_gaze.csv --out aria_walk --seconds 60
"""

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path


def upright_point(x, y, raw_height):
    """Aria RGB frames are stored rotated 90 degrees counter-clockwise; rotating the image clockwise maps (x, y) here."""
    return raw_height - 1 - y, x


def ray_grid(rgb_calibration, raw_width, raw_height, size):
    """Unit rays (camera frame) at size x size points spread evenly over the upright frame; null outside the lens."""
    import numpy as np
    rays = []
    for row in range(size):
        for col in range(size):
            # upright (x', y') -> raw (y', W' - 1 - x'), where the upright width W' is the raw height
            ux, uy = col / (size - 1) * (raw_height - 1), row / (size - 1) * (raw_width - 1)
            ray = rgb_calibration.unproject_no_checks(np.array([uy, raw_height - 1 - ux], dtype=np.float64))
            if ray is None or not np.all(np.isfinite(ray)) or ray[2] <= 0:
                rays.append(None)
            else:
                ray = ray / np.linalg.norm(ray)
                rays.append([round(float(v), 5) for v in ray])
    return {"size": size, "values": rays}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--vrs", required=True, type=Path)
    parser.add_argument("--gaze", required=True, type=Path, help="MPS general_eye_gaze.csv")
    parser.add_argument("--out", required=True, type=Path, help="output path without extension")
    parser.add_argument("--start", type=float, default=0.0, help="seconds to skip at the start")
    parser.add_argument("--seconds", type=float, default=60.0, help="length to export")
    parser.add_argument("--size", type=int, default=1024, help="output width/height (Aria RGB is square)")
    parser.add_argument("--default-depth", type=float, default=1.0, help="metres, when the gaze has no depth estimate")
    parser.add_argument("--no-eyes", action="store_true", help="skip the eye-tracking camera video")
    parser.add_argument("--trajectory", type=Path, help="MPS closed_loop_trajectory.csv for per-frame camera poses")
    parser.add_argument("--json-only", action="store_true", help="write only <out>.gaze.json (videos already exported)")
    parser.add_argument("--ray-grid", type=int, default=33, help="ray lookup grid size per side")
    args = parser.parse_args(argv)

    import numpy as np
    from projectaria_tools.core import data_provider, mps
    from projectaria_tools.core.mps.utils import get_gaze_vector_reprojection, get_nearest_eye_gaze, get_nearest_pose
    from projectaria_tools.core.sensor_data import TimeDomain, TimeQueryOptions

    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg and not args.json_only:
        raise SystemExit("ffmpeg is required to write a browser-playable H.264 video")

    provider = data_provider.create_vrs_data_provider(str(args.vrs))
    label = "camera-rgb"
    stream = provider.get_stream_id_from_label(label)
    calibration = provider.get_device_calibration()
    rgb_calibration = calibration.get_camera_calib(label)
    gaze = mps.read_eyegaze(str(args.gaze))
    count = provider.get_num_data(stream)
    if count == 0 or not gaze:
        raise SystemExit("no RGB frames or no eye gaze in this sequence")

    first_ns = provider.get_image_data_by_index(stream, 0)[1].capture_timestamp_ns
    start_ns, end_ns = first_ns + int(args.start * 1e9), first_ns + int((args.start + args.seconds) * 1e9)
    indices = [i for i in range(count) if start_ns <= provider.get_image_data_by_index(stream, i)[1].capture_timestamp_ns < end_ns]
    if len(indices) < 2:
        raise SystemExit("the requested window has fewer than two RGB frames")
    stamps = [provider.get_image_data_by_index(stream, i)[1].capture_timestamp_ns for i in indices]
    fps = round((len(stamps) - 1) / ((stamps[-1] - stamps[0]) / 1e9), 3)

    out_video, out_gaze = args.out.with_suffix(".mp4"), args.out.with_suffix(".gaze.json")
    trajectory = mps.read_closed_loop_trajectory(str(args.trajectory)) if args.trajectory else None
    T_device_rgb = rgb_calibration.get_transform_device_camera().to_matrix() if trajectory else None
    encoder = None if args.json_only else subprocess.Popen([ffmpeg, "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{args.size}x{args.size}",
                                "-r", str(fps), "-i", "-", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(out_video)],
                               stdin=subprocess.PIPE)
    eyes_stream = None if args.no_eyes or args.json_only else provider.get_stream_id_from_label("camera-et")
    eyes_encoder = None
    if eyes_stream is not None and provider.get_num_data(eyes_stream) > 0:
        eh, ew = provider.get_image_data_by_index(eyes_stream, 0)[0].to_numpy_array().shape[:2]
        eyes_encoder = subprocess.Popen([ffmpeg, "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "gray", "-s", f"{ew}x{eh}", "-r", str(fps), "-i", "-",
                                         "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(args.out.with_suffix(".eyes.mp4"))], stdin=subprocess.PIPE)
    samples = []
    import cv2
    for index, stamp in zip(indices, stamps):
        image = provider.get_image_data_by_index(stream, index)[0].to_numpy_array()
        raw_height, raw_width = image.shape[:2]
        if encoder:
            upright = np.ascontiguousarray(np.rot90(image, k=3))
            frame = cv2.resize(upright, (args.size, args.size), interpolation=cv2.INTER_AREA)
            encoder.stdin.write(frame[:, :, :3].astype(np.uint8).tobytes())
        if eyes_encoder:
            # The eye camera runs slower than the RGB camera; repeat its nearest frame so both videos share frame times.
            eyes = provider.get_image_data_by_time_ns(eyes_stream, stamp, TimeDomain.DEVICE_TIME, TimeQueryOptions.CLOSEST)[0].to_numpy_array()
            eyes_encoder.stdin.write(np.ascontiguousarray(eyes[:, :, 0] if eyes.ndim == 3 else eyes).astype(np.uint8).tobytes())
        sample = {"t": round((stamp - stamps[0]) / 1e9, 4)}
        eye = get_nearest_eye_gaze(gaze, stamp)
        point = None
        if eye is not None:
            depth = getattr(eye, "depth", 0.0) or args.default_depth
            point = get_gaze_vector_reprojection(eye, label, calibration, rgb_calibration, depth)
        if point is not None:
            x, y = upright_point(float(point[0]), float(point[1]), raw_height)
            # upright width is the raw height and vice versa
            nx, ny = x / raw_height, y / raw_width
            if 0 <= nx <= 1 and 0 <= ny <= 1:
                sample.update(x=round(nx, 5), y=round(ny, 5))
        if trajectory:
            pose = get_nearest_pose(trajectory, stamp)
            if pose is not None:
                T_world_rgb = pose.transform_world_device.to_matrix() @ T_device_rgb
                sample["pose"] = [round(float(v), 5) for v in T_world_rgb[:3, :].reshape(-1)]
        samples.append(sample)
    if encoder:
        encoder.stdin.close()
        if encoder.wait() != 0:
            raise SystemExit("ffmpeg failed to write the video")
    if eyes_encoder:
        eyes_encoder.stdin.close()
        if eyes_encoder.wait() != 0:
            raise SystemExit("ffmpeg failed to write the eye video")
    extra = {}
    if trajectory:
        extra["rays"] = ray_grid(rgb_calibration, raw_width, raw_height, args.ray_grid)
    out_gaze.write_text(json.dumps({"version": 1, "source": "project-aria-mps-eye-gaze", "sequence": args.vrs.parent.name,
                                    "width": args.size, "height": args.size, "fps": fps, "samples": samples, **extra}, separators=(",", ":")), "utf-8")
    valid = sum(1 for sample in samples if "x" in sample)
    print(f"{out_video} ({len(samples)} frames, {fps} fps) and {out_gaze} ({valid}/{len(samples)} frames with gaze)")


if __name__ == "__main__":
    sys.exit(main())
