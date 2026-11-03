"""Add metric depth anchors and a room point cloud to a gaze track written by export_gaze_video.py --trajectory.

Depth Anything gives relative structure but its metric scale is off on the Aria fisheye (it is trained on pinhole
images). MPS SLAM semi-dense points are real metric 3D points, so for every video frame they are projected into the RGB
camera (through the track's own fisheye ray grid, nearest point per grid cell as a coarse z-buffer) and stored as
"anchors": [[x, y, axial depth m], ...] in upright-video normalised coordinates. The app rescales each depth map so its
median ratio to the anchors is 1. A downsampled copy of the cloud ("cloud") gives the 3D memory view the room's shape.

  python export_depth_anchors.py --track data/demo/aria_x.gaze.json --points mps_slam/semidense_points.csv.gz
"""

import argparse
import json
from pathlib import Path


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--track", required=True, type=Path)
    parser.add_argument("--points", required=True, type=Path, help="MPS semidense_points.csv.gz")
    parser.add_argument("--max-points", type=int, default=60000, help="points used for anchors")
    parser.add_argument("--cloud-points", type=int, default=12000, help="points kept for the 3D view")
    parser.add_argument("--max-depth", type=float, default=10.0)
    parser.add_argument("--max-anchors", type=int, default=96, help="anchors kept per frame")
    args = parser.parse_args(argv)

    import numpy as np
    from projectaria_tools.core import mps

    track = json.loads(args.track.read_text("utf-8"))
    rays = track.get("rays")
    if not rays:
        raise SystemExit("the track has no ray grid; export it with --trajectory first")
    size = rays["size"]
    grid = np.array([ray if ray else [0.0, 0.0, -1.0] for ray in rays["values"]], dtype=np.float32)  # missing rays never match
    nodes = np.array([[col / (size - 1), row / (size - 1)] for row in range(size) for col in range(size)], dtype=np.float32)
    # half the angle between neighbouring grid rays near the centre: a point further from every ray is outside the lens
    centre = (size // 2) * size + size // 2
    cos_limit = float(np.cos(np.arccos(np.clip(grid[centre] @ grid[centre + 1], -1, 1)) * 0.75))

    cloud = mps.read_global_point_cloud(str(args.points))
    good = [p.position_world for p in cloud if p.inverse_distance_std < 0.001 and p.distance_std < 0.15]
    points = np.array(good, dtype=np.float32)
    rng = np.random.default_rng(0)
    if len(points) > args.max_points:
        points = points[rng.choice(len(points), args.max_points, replace=False)]
    print(f"{len(cloud)} points, {len(good)} well estimated, {len(points)} used")

    with_anchors = 0
    for sample in track["samples"]:
        pose = sample.get("pose")
        if not pose:
            continue
        m = np.array(pose, dtype=np.float32).reshape(3, 4)
        cam = (points - m[:, 3]) @ m[:, :3]  # R^T (p - t), row vectors
        z = cam[:, 2]
        keep = (z > 0.15) & (np.linalg.norm(cam, axis=1) < args.max_depth)
        if not keep.any():
            continue
        cam, z = cam[keep], z[keep]
        directions = cam / np.linalg.norm(cam, axis=1, keepdims=True)
        dots = directions @ grid.T
        node = dots.argmax(axis=1)
        inside = dots[np.arange(len(node)), node] >= cos_limit
        node, z = node[inside], z[inside]
        nearest = {}
        for n, depth in zip(node.tolist(), z.tolist()):
            if depth < nearest.get(n, np.inf):
                nearest[n] = depth
        if len(nearest) >= 8:
            chosen = list(nearest.items())
            if len(chosen) > args.max_anchors:
                chosen = [chosen[i] for i in rng.choice(len(chosen), args.max_anchors, replace=False)]
            sample["anchors"] = [[round(float(nodes[n][0]), 4), round(float(nodes[n][1]), 4), round(depth, 3)] for n, depth in chosen]
            with_anchors += 1

    all_points = np.array(good, dtype=np.float32)
    keep = all_points[rng.choice(len(all_points), min(args.cloud_points, len(all_points)), replace=False)]
    track["cloud"] = [round(float(v), 3) for v in keep.reshape(-1)]
    args.track.write_text(json.dumps(track, separators=(",", ":")), "utf-8")
    print(f"{args.track}: anchors on {with_anchors}/{len(track['samples'])} frames, {len(keep)} cloud points")


if __name__ == "__main__":
    main()
