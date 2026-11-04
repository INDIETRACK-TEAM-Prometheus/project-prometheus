# Attributions

Everything Prometheus uses that it did not write itself: models and APIs, datasets, libraries and tools, with the
version used and its license. Versions are the ones pinned or installed for the hackathon demo (November 2026).

## Meta models (Meta Model API)

| What | Used for | Terms |
|---|---|---|
| **SAM 3.1** (`sam-3.1`) | Segments the object at the gaze point (point prompt) | Meta Model API terms |
| **Muse Spark 1.2** (`muse-spark-1.2`, minimal effort) | Names the objects RT-DETR and SAM cut out; next-action predictions; place recognition across recordings | Meta Model API terms |
| **Muse Spark 1.3** (`muse-spark-1.3`) | Full scenario contract on the earlier `/classic` page and `/api/reason-provisional` | Meta Model API terms |
| `@meta-sam/parser` 0.1.0 | Decodes SAM 3.1 mask responses | SAM License (Meta, updated November 19, 2025) |

## Datasets

| Dataset | Used for | License | Status in this repository |
|---|---|---|---|
| **Aria Everyday Activities** (Meta, release 1.0.0): loc2_script3_seq1_rec1, loc2_script3_seq1_rec2, loc2_script2_seq6_rec1, loc2_script5_seq2_rec1 | Main demo: RGB scene video, eye-camera video, MPS eye gaze, MPS closed-loop trajectory, MPS semi-dense points | [AEA Dataset License](https://www.projectaria.com/datasets/aea/license/): no distribution or public display of the dataset or derived works without Meta's written permission | Derived clips are in `data/demo/` of the **private** repository; permission requested (Discord question to the organizers, emails to the address in the license bounced). Remove before making the repository public unless permission is granted. |
| **HARMONIC** (CMU HARP Lab), sample run p122/run/011 | Fallback clip: egocentric video, both eye videos, Pupil Labs gaze | No license stated on the [project page](https://harplab.github.io/harmonic/) or in the paper | Kept out of git; permission request drafted, not sent. Newman et al., "HARMONIC: A multimodal dataset of assistive human–robot collaboration", IJRR 2021. |

Considered and not used: the Visual Experience Dataset (VEDB, CC-BY; downloads need Databrary institutional
authorization and gaze is not provided), Gaze-in-Wild (project site unavailable), Ego4D / EgoExo4D (restrictive license).

## Models run locally

| Model | Used for | License |
|---|---|---|
| **RT-DETRv2 R18** ([PekingU/rtdetr_v2_r18vd](https://huggingface.co/PekingU/rtdetr_v2_r18vd)) via Hugging Face transformers 4.57.1 | Boxes for every object in the frame (names come from Muse Spark) | Apache-2.0 |
| **Depth Anything V2 Metric Hypersim Small** ([DepthAnything/Depth-Anything-V2](https://github.com/DepthAnything/Depth-Anything-V2)) | Metric depth for distances and 3D memory | Apache-2.0 |
| **WebEyeTrack** model and package 0.0.2 | Webcam gaze on the earlier `/classic` page only | MIT |
| **MediaPipe Tasks Vision** 0.10.21 (`face_landmarker.task`) | Face landmarks on the earlier `/classic` page only | Apache-2.0 |

## Libraries

JavaScript (`package.json`): React 19.2.0 and React DOM 19.2.0 (MIT), three.js 0.186.1 (MIT), Vite 8.3.5 and
@vitejs/plugin-react 6.2.1 (MIT), munkres 2.1.1 (MIT), webeyetrack 0.0.2 (MIT), @meta-sam/parser 0.1.0 (SAM License).

Python, local inference workers: PyTorch 2.6.0 CPU (BSD-3-Clause), torchvision 0.21.0 (BSD), transformers 4.57.1
(Apache-2.0), OpenCV 4.10 headless (Apache-2.0), NumPy (BSD-3-Clause), Pillow 11.1 (MIT-CMU).

Python, data export: projectaria_tools 1.7.1 (Apache-2.0), msgpack 1.2.4 (Apache-2.0), gdown 5.2.0 (MIT).

## Tools and assets

- **FFmpeg** 9.0 (gyan.dev full build, GPL): video encoding in the export scripts; not shipped.
- **IBM Plex Sans / IBM Plex Mono** via Google Fonts (SIL Open Font License 1.1).
- **Taste Skill** ([Leonxlnx/taste-skill](https://github.com/Leonxlnx/taste-skill)): design guidance for the UI.

## License notes

- **No AGPL code:** an earlier build used Ultralytics YOLO (AGPL-3.0); it was replaced by RT-DETRv2 (Apache-2.0)
  before release, and Ultralytics is not a dependency.
- **AEA clips:** the hackathon organizers ruled that footage without Meta's written permission must be left out
  (projects using material they have no rights to are disqualified). They are not part of the submission and must be
  removed from the repository history before it is made public.
- **HARMONIC:** no license is stated, so its media is not redistributed here.
