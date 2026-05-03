# Face training workflow (iter-351..354)

Hands-on guide for the operator: how the face classifier learns who's
who, how to correct misclassifications, and how to bootstrap a new
person.

## Quick mental model

```
   live camera frame
          │
          ▼
   ┌─────────────┐
   │  detect.py  │ ── SSD-MobileNet sees a "person"
   └─────────────┘
          │  crop the person bbox
          ▼
   ┌──────────────────────┐
   │ face_recog/recognizer│ ── HOG face_locations + face_encodings
   └──────────────────────┘
          │
          ├── match found  ─►  emits person_name="Israel" + saves
          │                    crop to face_captures/israel/
          │
          └── no match    ─►   emits person_name=null + saves crop to
                               face_captures/__unknown__/

                               ▼
                       Operator opens the PWA → /training
                       Reviews each name's gallery
                       Sorts misclassifications + names unknowns
                       Hits Re-train  (iter-354)
                               ▼
                       encode_known_faces.py rebuilds encodings.pkl
                       Worker reloads on next start.
```

## What's saved

Every time the recognizer sees a face inside a person bbox, it saves
the face crop as JPEG quality 95 (with ~30 % padding around the face
for context) to:

```
<face_captures_dir>/
    israel/                        ← classifier called this Israel
        1700000000000_clip-001.jpg
        1700000060000_clip-002.jpg
    sheenal/
    __unknown__/                   ← no match within tolerance
        1700000120000_clip-003.jpg
```

Each per-name dir is capped at 200 entries (LRU eviction by mtime), so
a busy household won't fill the SD card. At ~10 KB per crop × 200 ×
20 names ≈ 40 MB cap.

The directory is configured by `FACE_CAPTURES_DIR` in the server's
`.env` (default `./face_captures`). It must be a path the host-side
detection worker AND the containerized server can both reach — the
project bind-mounts it the same way `snapshots/`, `recordings/`, and
`face_captures/` are bind-mounted in `deploy/docker-compose.yml`.

## Operator workflow (the loop)

You do this whenever the system mis-IDs someone or sees a new face:

### 1. Open the PWA → Training tab

The page lists every per-name directory and `__unknown__/` with a
count + most-recent timestamp. Tap a name to open its gallery.

### 2. Triage one gallery at a time

For each crop in `israel/`, ask: "Is this actually Israel?"

- **Yes** → leave it alone.
- **No, that's actually Sheenal** → Move it to `sheenal/`. (Phase 3.)
- **No, that's a stranger** → Move it to `__unknown__/`.
- **Looks distorted / partial / can't tell** → Delete it.

For the `__unknown__/` gallery the question flips: "Do I recognize
this person? If yes, what's their name?" If you recognize them, move
the crop to the appropriate person's folder (creating one if it's a
new person — type the name in the move dialog).

### 3. Hit "Re-train" (Phase 4)

The Re-train button POSTs to `/api/face/retrain`, which does this on
the Jetson:

1. Reads every JPEG in `face_captures/<name>/` for each name.
2. Re-runs `face_locations` on each, extracts the encoding.
3. Writes the merged `encodings.pkl` to `face_recog/encodings.pkl`.
4. Restarts the detection worker via systemd so the new encodings
   load.

The whole thing takes 1-3 min depending on how many crops you've
curated. The PWA polls a status endpoint and shows a progress
indicator.

### 4. Verify

After the worker restarts, the Live page's status row shows
"Recognized: israel, sheenal, …" — the names you just trained on.
Walk past the camera; the next event should show your name in the
notification + on the event row.

## Bootstrapping a new household member

Same loop, just from a cold start:

1. Have the new person walk past the camera a few times. The worker
   will save crops to `__unknown__/`.
2. Open the PWA → Training → `__unknown__`.
3. Move the new person's crops into a fresh dir (the move dialog lets
   you type a new name). Aim for ~10-15 distinct crops at different
   angles / lighting.
4. Hit Re-train.

## What to keep an eye on

- **`__unknown__/` count climbing fast.** Means the model is
  consistently failing to ID someone you know. Either curate more
  examples (loop above), or lower the recognizer tolerance from 0.55
  to 0.50 (`FaceRecognizer(tolerance=0.50)` in `recognizer.py`) for
  fewer false negatives at the cost of more false positives.
- **Crops that are blurry / sideways / tiny.** Skip those — they hurt
  more than they help. The HOG model needs ~150 px of face for a
  reliable encoding.
- **The same person ending up in two different name dirs** (e.g.
  half their crops in `israel/`, half in `israel_2/`). Pick one,
  move the other dir's contents over, delete the empty dir, re-train.
- **Disk fill.** The 200/dir LRU cap protects you, but if you let
  20 dirs accumulate that's still 200 × 20 × 10 KB ≈ 40 MB. A
  retention sweep (drop entries older than 90 days) is a future iter
  if this becomes a real problem; today, manual delete in the PWA
  works.

## Why this design

- **JPEGs in directories on disk, not blobs in SQLite.** The operator
  can `ssh jetson` and `ls face_captures/` if the PWA is broken —
  the data is never trapped. Move/delete via PWA OR via `mv` / `rm`
  on the host; both work.
- **Per-name dirs are filesystem-friendly.** The classifier label IS
  the directory name (sanitized), so a glance at `ls -la face_captures/`
  shows you exactly which household members the worker is encoding for.
- **No dlib at the read tier.** The PWA + server only browse JPEGs;
  the heavy `face_recognition` import only happens on the worker
  (already does, for inference) and during Re-train (one shot).
  Browsing the gallery on a phone is fast and never depends on dlib's
  finicky import behavior on the Nano.
- **30 % padding around the face bbox.** When you Re-train,
  `face_recognition.face_locations()` runs on each saved JPEG to find
  the face again before extracting an encoding. A tight bbox crop
  often fails this re-detection (the model wants ~150 px of face plus
  context). 30 % padding is the sweet spot — small enough to keep the
  crop disk-cheap, large enough that re-detection succeeds reliably.
- **JPEG quality 95.** Higher than the default 85 to keep
  face_recognition's HOG features sharp on retrain. The size cost is
  ~25 % per crop (still <15 KB typical) — well worth the recognition
  accuracy gain.

## Limits today (Phase 1 + Phase 2)

- ✅ **Phase 1 (worker save):** every face gets saved during inference.
- ✅ **Phase 2 (read-only PWA):** browse + view. No actions yet.
- 🔜 **Phase 3 (move/delete actions):** in iter-353.
- 🔜 **Phase 4 (Re-train button):** in iter-354.

Until Phase 3/4 land, the workflow is half-manual: you curate via SSH,
then SSH again to run `python encode_known_faces.py` and
`sudo systemctl restart homecam-detect`.

## Camera quality + future swap

The capture's pixel quality is bounded by what the detection worker
sees coming out of MediaMTX, which today is the H.264 stream MediaMTX
encodes from `nvarguscamerasrc` at 720p30. There's no separate
high-resolution snapshot path — only one process can hold libargus
at a time on the Jetson, and that process is MediaMTX.

So "best capture quality" today means three things:
1. **JPEG quality 95** when we encode the crop (configured in
   `recognizer.py::_FACE_JPEG_QUALITY`).
2. **30 % bbox padding** so face_recognition's HOG model can re-detect
   on retrain (configured in `recognizer.py::_FACE_BBOX_PAD_FRAC`).
3. **Whatever resolution the camera + MediaMTX can produce** — when
   you swap the camera, the recognizer doesn't care (it just sees
   bigger numpy arrays). To raise the streamed resolution, edit the
   `nvv4l2h264enc` width/height in `deploy/mediamtx.yml` and restart
   `mediamtx.service`. Trade-off: encode CPU, NVDEC headroom on the
   detection side, and bandwidth all scale with resolution.
