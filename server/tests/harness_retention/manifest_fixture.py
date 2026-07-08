import os
from collections import namedtuple
from pathlib import Path


Usage = namedtuple("Usage", ["total", "used", "free"])


class DiskModel:
    def __init__(self, start_free, clips, recordings_dir):
        self.start_free = int(start_free)
        self._sizes_by_name = {name: int(size_bytes) for name, size_bytes, _mtime in clips}
        self.recordings_dir = Path(recordings_dir)
        self.calls = []

    def deleted_mp4_names(self):
        return {
            name
            for name in self._sizes_by_name
            if not (self.recordings_dir / name).exists()
        }

    def free_bytes(self):
        return self.start_free + sum(
            self._sizes_by_name[name] for name in self.deleted_mp4_names()
        )

    def __call__(self, path):
        self.calls.append(path)
        return Usage(total=0, used=0, free=self.free_bytes())


def build_scratch_recordings(clips, dest_dir):
    dest = Path(dest_dir)
    dest.mkdir(parents=True, exist_ok=True)

    for name, size_bytes, mtime_epoch in clips:
        path = dest / name
        path.touch()
        os.truncate(path, size_bytes)
        os.utime(path, (mtime_epoch, mtime_epoch))


def parse_recordings_manifest(path):
    clips = []
    df_avail_bytes = None

    for raw_line in Path(path).read_text().splitlines():
        line = raw_line.strip()
        if not line:
            continue

        parts = line.split()
        if parts[0].startswith("-"):
            if len(parts) < 7:
                raise ValueError("malformed ls row: {0}".format(raw_line))
            size_bytes = int(parts[4])
            mtime_epoch = int(parts[5])
            clip_path = Path(parts[6])
            if not clip_path.is_absolute():
                raise ValueError("manifest clip path is not absolute: {0}".format(raw_line))
            clips.append((clip_path.name, size_bytes, mtime_epoch))
        else:
            if len(parts) < 4:
                raise ValueError("malformed df row: {0}".format(raw_line))
            df_avail_bytes = int(parts[3])

    if df_avail_bytes is None:
        raise ValueError("manifest missing df row")

    return clips, df_avail_bytes
