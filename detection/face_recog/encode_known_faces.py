#!/usr/bin/env python3
"""Build the known-faces encodings file used by the live recognizer.

Reads `refs/photo_NN.jpg` + `manifest.json`, runs face detection on each
photo, and saves a pickled list of (person_name, 128d_encoding) pairs to
`encodings.pkl`.

Multi-person photos are handled by sorting detected faces left-to-right
along the x axis and applying the labels from the manifest in order.

Usage (run on the Jetson host where face_recognition is installed):
    python3 encode_known_faces.py
    python3 encode_known_faces.py --refs ./refs --manifest ./manifest.json
"""
import argparse
import json
import os
import pickle
import sys

try:
    import face_recognition
except ImportError as e:
    print(
        "[encode] face_recognition not importable. Face recognition is\n"
        "currently BLOCKED on the Jetson Nano 2GB — both the CUDA dlib\n"
        "wheel and the CUDA-disabled rebuild deadlock at import (see\n"
        "detection/face_recog/README.md and memory/jetson_dlib_no_cuda.md\n"
        "for the diagnostic narrative). Don't attempt the install path\n"
        "until one of the documented unblock paths (pin v19.x, switch to\n"
        "InsightFace+ONNX, or patch v20 static init) is in place.",
        file=sys.stderr,
    )
    raise SystemExit(1) from e

SKIP_TOKEN = "_skip"


def main() -> int:
    here = os.path.dirname(os.path.abspath(__file__))
    p = argparse.ArgumentParser()
    p.add_argument("--refs", default=os.path.join(here, "refs"))
    p.add_argument("--manifest", default=os.path.join(here, "manifest.json"))
    p.add_argument("--out", default=os.path.join(here, "encodings.pkl"))
    p.add_argument(
        "--model",
        default="hog",
        choices=("hog", "cnn"),
        help="Face detector. 'hog' is CPU-only, fast (~80ms/face). 'cnn' is "
        "GPU-accelerated and more accurate but the dlib build on JetPack 4.x "
        "is finicky — start with hog, switch later.",
    )
    args = p.parse_args()

    with open(args.manifest) as f:
        manifest = json.load(f)

    # No PEP 585 generic annotations here — `list[tuple[...]]` and
    # `dict[str, int]` raise TypeError at module load on Python 3.6, the
    # version JetPack 4.x ships on the Jetson host where this script
    # actually runs. CLAUDE.md "detection/*.py must stay Python 3.6
    # compatible" sharp edge. Bare locals; the shape is still obvious
    # from the use sites below.
    encodings = []  # list of (label, 128d encoding-as-list)
    counts = {}  # label -> count

    for photo_name, labels in sorted(manifest.items()):
        if photo_name.startswith("_"):
            continue
        path = os.path.join(args.refs, photo_name)
        if not os.path.exists(path):
            print("[encode] {} missing — skipped".format(photo_name))
            continue

        image = face_recognition.load_image_file(path)
        boxes = face_recognition.face_locations(image, model=args.model)
        if not boxes:
            print("[encode] no faces in {} — skipped".format(photo_name))
            continue

        # face_recognition returns boxes as (top, right, bottom, left).
        # Sort left-to-right so we line up with the manifest's order.
        boxes_sorted = sorted(boxes, key=lambda b: b[3])

        if len(boxes_sorted) != len(labels):
            print(
                "[encode] {}: detected {} face(s) but manifest has {} label(s); "
                "labels = {}".format(photo_name, len(boxes_sorted), len(labels), labels)
            )
            # Pair up as many as we can; trailing entries on the shorter side
            # are dropped.
        face_encodings = face_recognition.face_encodings(image, boxes_sorted)
        for label, encoding in zip(labels, face_encodings):
            if label == SKIP_TOKEN or label == "unknown":
                continue
            encodings.append((label, encoding.tolist()))
            counts[label] = counts.get(label, 0) + 1
            print("[encode] {} face -> {}".format(photo_name, label))

    if not encodings:
        print("[encode] no encodings produced — manifest mismatch?")
        return 2

    with open(args.out, "wb") as f:
        pickle.dump(encodings, f)

    print()
    print("[encode] wrote {} ({} encoding(s))".format(args.out, len(encodings)))
    for name, n in sorted(counts.items()):
        print("[encode]   {}: {}".format(name, n))

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
