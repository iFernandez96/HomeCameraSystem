import json
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit


@dataclass(frozen=True, repr=False)
class PushSubscription:
    endpoint: str
    expiration_time: object
    keys: dict
    filters: object
    user_id: str

    @property
    def endpoint_host(self):
        return urlsplit(self.endpoint).netloc

    def __repr__(self):
        keys = sorted(self.keys)
        return (
            "PushSubscription("
            "endpoint_host={0!r}, keys={1!r}, has_endpoint_path={2})"
        ).format(self.endpoint_host, keys, bool(urlsplit(self.endpoint).path))


def load_push_subscriptions(path):
    raw = json.loads(Path(path).read_text())
    if not isinstance(raw, list):
        raise ValueError("push fixture must be a list")

    return [_parse_subscription(row, index) for index, row in enumerate(raw)]


def host_summary(subs):
    counts = {}
    for sub in subs:
        counts[sub.endpoint_host] = counts.get(sub.endpoint_host, 0) + 1
    return sorted(counts.items())


def _parse_subscription(row, index):
    if not isinstance(row, dict):
        raise ValueError("push fixture row {0} must be an object".format(index))

    endpoint = row.get("endpoint")
    keys = row.get("keys")
    user_id = row.get("user_id")
    expiration_time = row.get("expirationTime")
    filters = row.get("filters")

    if not isinstance(endpoint, str):
        raise ValueError("push fixture row {0} endpoint must be a string".format(index))
    parsed = urlsplit(endpoint)
    if parsed.scheme != "https" or not parsed.netloc or not parsed.path:
        raise ValueError("push fixture row {0} endpoint must be an https URL".format(index))
    if not isinstance(keys, dict):
        raise ValueError("push fixture row {0} keys must be an object".format(index))
    if not all(isinstance(keys.get(name), str) and keys[name] for name in ("p256dh", "auth")):
        raise ValueError("push fixture row {0} keys must include p256dh and auth".format(index))
    if not isinstance(user_id, str) or not user_id:
        raise ValueError("push fixture row {0} user_id must be a non-empty string".format(index))
    if expiration_time is not None and not isinstance(expiration_time, (int, float)):
        raise ValueError("push fixture row {0} expirationTime must be numeric or null".format(index))
    if filters is not None and not isinstance(filters, dict):
        raise ValueError("push fixture row {0} filters must be an object or null".format(index))

    return PushSubscription(
        endpoint=endpoint,
        expiration_time=expiration_time,
        keys=dict(keys),
        filters=filters,
        user_id=user_id,
    )
