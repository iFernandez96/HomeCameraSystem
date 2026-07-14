# Independent offline observer

The Android wrapper already checks the Jetson without relying on the Jetson to
send its own outage notification. Android Doze can still defer that work.
`deploy/observer/homecam-observer.py` provides the same two-failure hysteresis
for an always-on router, NAS, or computer outside the Jetson.

Create `~/.config/homecam-observer.env` on that observer host:

```ini
HOMECAM_OBSERVER_URLS=https://homecam.tailnet.example,http://10.0.0.9:8000
HOMECAM_OBSERVER_INTERVAL_S=30
HOMECAM_OBSERVER_WEBHOOK=https://your-private-notification-gateway.example/hook
```

The webhook receives only `{v, system, state, ts}` on confirmed offline and
recovery transitions. It never receives credentials, camera data, event IDs,
or recording paths. Leave the webhook unset to maintain local state without
sending anything externally.

Install the user unit on that separate host and enable it with
`systemctl --user enable --now homecam-observer.service`. Do not run it on the
Jetson; that would not be independent of a Jetson power failure.
