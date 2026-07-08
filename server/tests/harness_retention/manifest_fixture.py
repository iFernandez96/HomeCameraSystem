from pathlib import Path


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
