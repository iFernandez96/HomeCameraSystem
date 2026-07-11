"""Conservative quality gate for biometric face crops.

Only very small, nearly flat, or globally blurred crops are rejected.  The
gate runs immediately before persistence; recognition itself can still use the
frame, so this never turns a low-quality image into a false non-match.

Python 3.6 compatible.
"""


MIN_FACE_SIDE = 40
MIN_CONTRAST = 8.0
MIN_SHARPNESS = 2.0


def face_crop_quality(crop, min_side=MIN_FACE_SIDE,
                      min_contrast=MIN_CONTRAST,
                      min_sharpness=MIN_SHARPNESS):
    """Return ``(accepted, reason, scalar_metrics)`` for an RGB crop."""
    try:
        height = int(crop.shape[0])
        width = int(crop.shape[1])
    except (AttributeError, IndexError, TypeError, ValueError):
        return (False, "invalid", {})
    metrics = {"width": width, "height": height}
    if min(width, height) < int(min_side):
        return (False, "too_small", metrics)
    try:
        step = max(1, int(max(width, height) / 128))
        gray = []
        for y in range(0, height, step):
            row = []
            for x in range(0, width, step):
                try:
                    pixel = crop[y, x]
                except (IndexError, KeyError, TypeError):
                    pixel = crop[y][x]
                try:
                    value = (0.299 * float(pixel[0])
                             + 0.587 * float(pixel[1])
                             + 0.114 * float(pixel[2]))
                except (IndexError, KeyError, TypeError):
                    value = float(pixel)
                row.append(value)
            gray.append(row)
        count = sum(len(row) for row in gray)
        mean = sum(sum(row) for row in gray) / float(count)
        variance = sum(
            sum((value - mean) ** 2 for value in row) for row in gray
        ) / float(count)
        contrast = variance ** 0.5
        metrics["contrast"] = contrast
        if contrast < float(min_contrast):
            return (False, "low_contrast", metrics)
        total = 0.0
        samples = 0
        for row in gray:
            for x in range(1, len(row) - 1):
                total += abs(row[x + 1] - 2.0 * row[x] + row[x - 1])
                samples += 1
        for y in range(1, len(gray) - 1):
            limit = min(len(gray[y - 1]), len(gray[y]), len(gray[y + 1]))
            for x in range(limit):
                total += abs(gray[y + 1][x] - 2.0 * gray[y][x] + gray[y - 1][x])
                samples += 1
        sharpness = total / float(max(1, samples))
        metrics["sharpness"] = sharpness
        if sharpness < float(min_sharpness):
            return (False, "blurry", metrics)
    except Exception:
        return (False, "invalid", metrics)
    return (True, "ok", metrics)
