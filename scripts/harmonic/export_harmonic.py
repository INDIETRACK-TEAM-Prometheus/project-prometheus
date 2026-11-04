"""Export one HARMONIC run (CMU HARP Lab, Pupil Labs eye tracker) in the demo clip format the app plays:

  <out>.mp4         the egocentric (world) video, H.264, browser playable
  <out>.eyes.mp4    left and right eye videos side by side, one frame per world frame (eye0 is mounted upside down)
  <out>.gaze.json   {"version":1, ... "samples":[{"t", "x", "y", "pose"}], "rays":{...}}

Gaze comes from the dataset's own text_data/gaze_positions.csv (Pupil Labs gaze mapped into the world frame, origin
top left): the median of the confident samples within half a world frame of each world frame. HARMONIC has no head
tracking; the participant sits at a table, so the camera is taken as still at a seated eye height, with the world
frame gravity aligned (+z up), and camera rays come from a pinhole with the Pupil world camera's nominal intrinsics.

  python export_harmonic.py --run data/harmonic/sample/harmonic_0.5.0/p122/run/011 --out data/demo/harmonic_p122_run011
"""

import argparse
import csv
import json
import shutil
import subprocess
from pathlib import Path


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--run", required=True, type=Path, help="a HARMONIC run folder (with videos/ and text_data/)")
    parser.add_argument("--out", required=True, type=Path, help="output path without extension")
    parser.add_argument("--min-confidence", type=float, default=0.6)
    parser.add_argument("--focal", type=float, default=829.0, help="world camera focal length in pixels at 1280x720")
    parser.add_argument("--eye-height", type=float, default=1.2, help="metres above the floor (seated)")
    parser.add_argument("--ray-grid", type=int, default=33)
    args = parser.parse_args(argv)

    import cv2
    import numpy as np

    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise SystemExit("ffmpeg is required")
    videos, text = args.run / "videos", args.run / "text_data"
    world_ts = np.load(videos / "world_timestamps.npy")
    eye_ts = {name: np.load(videos / f"{name}_timestamps.npy") for name in ("eye0", "eye1")}

    world = cv2.VideoCapture(str(videos / "world.mp4"))
    width, height = int(world.get(cv2.CAP_PROP_FRAME_WIDTH)), int(world.get(cv2.CAP_PROP_FRAME_HEIGHT))
    frames = int(world.get(cv2.CAP_PROP_FRAME_COUNT))
    count = min(frames, len(world_ts))
    # the browser plays the video at its nominal rate, so track times are frame index / that rate (the recorded
    # timestamps, used to pair eye frames and gaze, drift from it by over a second across a run)
    fps = round(world.get(cv2.CAP_PROP_FPS), 3)
    world.release()

    # Scene video: re-encoded as is (the frame count follows world_timestamps).
    subprocess.run([ffmpeg, "-loglevel", "error", "-y", "-i", str(videos / "world.mp4"), "-frames:v", str(count), "-an",
                    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(args.out.with_suffix(".mp4"))], check=True)

    # Eye video: for every world frame the nearest frame of each eye, left eye (eye1) on the left.
    caps = {name: cv2.VideoCapture(str(videos / f"{name}.mp4")) for name in ("eye0", "eye1")}
    current = {name: (-1, None) for name in caps}
    eye_w, eye_h = int(caps["eye0"].get(cv2.CAP_PROP_FRAME_WIDTH)), int(caps["eye0"].get(cv2.CAP_PROP_FRAME_HEIGHT))
    encoder = subprocess.Popen([ffmpeg, "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "gray", "-s", f"{eye_w * 2}x{eye_h}", "-r", str(fps), "-i", "-",
                                "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(args.out.with_suffix(".eyes.mp4"))], stdin=subprocess.PIPE)

    def eye_frame(name, t):
        stamps = eye_ts[name]
        target = int(np.clip(np.searchsorted(stamps, t), 0, len(stamps) - 1))
        index, image = current[name]
        while index < target:
            ok, frame = caps[name].read()
            if not ok:
                break
            index, image = index + 1, cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        current[name] = (index, image)
        return image if image is not None else np.zeros((eye_h, eye_w), np.uint8)

    for t in world_ts[:count]:
        right = cv2.rotate(eye_frame("eye0", t), cv2.ROTATE_180)
        left = eye_frame("eye1", t)
        encoder.stdin.write(np.ascontiguousarray(np.hstack([left, right])).tobytes())
    encoder.stdin.close()
    if encoder.wait() != 0:
        raise SystemExit("ffmpeg failed to write the eye video")

    # Gaze per world frame.
    gaze = []
    with open(text / "gaze_positions.csv", newline="") as f:
        for row in csv.DictReader(f):
            if float(row["confidence"]) >= args.min_confidence:
                gaze.append((float(row["timestamp"]), float(row["norm_pos_x"]), float(row["norm_pos_y"])))
    gaze_t = np.array([g[0] for g in gaze]); gaze_xy = np.array([g[1:] for g in gaze])
    half = 0.5 * (world_ts[count - 1] - world_ts[0]) / (count - 1)
    # camera (x right, y down, z forward) -> world (x right, y forward, z up), still at a seated eye height
    pose = [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, args.eye_height]
    samples, with_gaze = [], 0
    for index, t in enumerate(world_ts[:count]):
        sample = {"t": round(index / fps, 4), "pose": pose}
        lo, hi = np.searchsorted(gaze_t, t - half), np.searchsorted(gaze_t, t + half)
        if hi > lo:
            x, y = np.median(gaze_xy[lo:hi], axis=0)
            if 0 <= x <= 1 and 0 <= y <= 1:
                sample.update(x=round(float(x), 5), y=round(float(y), 5)); with_gaze += 1
        samples.append(sample)

    scale = width / 1280
    fx, cx, cy = args.focal * scale, width / 2, height / 2
    rays = []
    for row in range(args.ray_grid):
        for col in range(args.ray_grid):
            u, v = col / (args.ray_grid - 1) * (width - 1), row / (args.ray_grid - 1) * (height - 1)
            ray = np.array([(u - cx) / fx, (v - cy) / fx, 1.0]); ray /= np.linalg.norm(ray)
            rays.append([round(float(c), 5) for c in ray])

    track = {"version": 1, "source": "harmonic-pupil-labs-gaze", "sequence": f"{args.run.parent.parent.name}/{args.run.name}",
             "width": width, "height": height, "fps": fps, "samples": samples, "rays": {"size": args.ray_grid, "values": rays}}
    args.out.with_suffix(".gaze.json").write_text(json.dumps(track, separators=(",", ":")), "utf-8")
    print(f"{args.out}: {count} frames at {fps} fps, gaze on {with_gaze}/{count}")


if __name__ == "__main__":
    main()
