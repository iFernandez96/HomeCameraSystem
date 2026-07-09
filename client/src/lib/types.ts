export type DetectionBox = {
  /** Normalized [0..1] coordinates relative to frame width/height. */
  x: number
  y: number
  w: number
  h: number
  label: string
  score: number
}

/**
 * iter-356.53 — bbox-track sidecar (per-event). The detection
 * worker writes this JSON file at clip-window expiry; the server
 * exposes it at GET /api/events/{id}/tracks. The `ClipModal`
 * fetches it on mount and binds the canvas overlay to
 * `<video>.timeupdate`, drawing the closest-in-time sample so the
 * bbox follows the object across pre-roll + post-roll.
 *
 * Legacy clips (pre-iter-356.53) have no sidecar; the route 404s
 * and the client falls back to the static `event.boxes` overlay.
 */
export type EventTrackSample = {
  /** Seconds from clip start (= `event_ts - pre_roll_s`). */
  ts_offset_s: number
  boxes: DetectionBox[]
}

export type EventTracks = {
  v: 1
  event_id: string
  pre_roll_s: number
  post_roll_s: number
  /** Ascending by `ts_offset_s`. May be empty when no detection
   *  passed the threshold during the clip window. */
  samples: EventTrackSample[]
}

export type DetectionEvent = {
  v: 1
  type: 'detection'
  id: string
  /** Unix epoch seconds (float). */
  ts: number
  camera_id: string
  label: string
  score: number
  boxes: DetectionBox[]
  /**
   * URL of the saved thumbnail captured at detection time. Server emits
   * the key always; value is null when no thumbnail was written (idle
   * gear, capture race, or thumbnail rotation pruned it). Treat as
   * "no image" when null OR absent — runtime falsy check handles both.
   */
  thumb_url?: string | null
  /**
   * Face-recognition match for the top person bbox, when the worker has
   * a known-faces database loaded. Absent / null when no face was matched
   * within tolerance.
   *
   * iter-357 (multi-person face-recog): when the event matched
   * multiple people, this field stays as the FIRST matched name
   * for backward compat (the iter-216 SQLite indexed column +
   * every pre-iter-357 client read path keeps working). The full
   * match list is in `person_names` below.
   */
  person_name?: string | null
  /**
   * iter-357 — full list of recognized faces for this event, in
   * detection-confidence order, deduped case-insensitively. Set
   * by the worker only when face recognition matched at least one
   * person; absent / null on legacy single-person events and on
   * events with no recognized faces. When present and non-empty,
   * `person_names[0]` always equals `person_name` (server-side
   * Pydantic invariant — see `_internal.py::DetectionPayload`).
   *
   * Consumers that just want to render "every name on this event"
   * should normalize via:
   *   const names = event.person_names ??
   *                 (event.person_name ? [event.person_name] : [])
   */
  person_names?: string[] | null
  /**
   * URL of the per-event MP4 clip, when the host-side recorder
   * (iter-202 `detection/recording.py`) wrote one for this event_id.
   * Null when the recorder isn't deployed yet OR the event missed
   * the cap (concurrent ffmpeg processes ≥ max_concurrent). Format:
   * `/api/events/<event_id>/clip` matching the iter-201 route. The
   * `<ClipModal>` (iter-203) hard-codes the same URL today; this
   * field exists so a future iter can skip the video-error
   * fallback path on events known to lack clips.
   */
  clip_url?: string | null
}

/**
 * Server WebSocket event shape. iter-170 collapsed this from a
 * `DetectionEvent | StatusEvent` union to a single member after the
 * Charter's wire-boundary contract audit (iter-161 / iter-169) found
 * the `StatusEvent` branch was a phantom — the server only emits
 * `make_detection_event(...)` over `/api/events/ws`; no
 * `make_status_event` exists, no route or service publishes
 * `{type: 'status', ...}` on the bus. Status data is exposed via the
 * REST `/api/status` endpoint, polled by `useStatus`.
 *
 * If a future iter genuinely starts publishing a non-detection event
 * type, widen this back to a discriminated union and add the
 * server-side emitter + tests in the same iter (per CLAUDE.md "Tests
 * as a contract surface" rule).
 */
export type ServerEvent = DetectionEvent

/**
 * Push notification filters per the iter-205/iter-207 Feature #4
 * data model. Server-stamped `user_id` (from JWT) is implicit on
 * the wire (not exposed to the client). `cameras`, `person_names`,
 * and `schedule_window` are AND-combined; null in any field = no
 * gating on that dimension; empty list `[]` on a list field =
 * match nothing in that field.
 */
export type PushFilters = {
  cameras: string[] | null
  person_names: string[] | null
  /**
   * iter-209 (slice 4): HH:MM-HH:MM time-of-day window for push
   * delivery, interpreted in SERVER LOCAL TIME (matches the
   * detection `schedule_off_*` semantics). Wraps across midnight
   * when start > end (e.g. 22:00 → 07:00 covers night-time pushes).
   * null = no time gating; start == end = "no schedule" sentinel.
   */
  schedule_window: { start: string; end: string } | null
}

/**
 * Polygon mask point in normalized [0, 1] coordinates relative to the
 * frame's width/height. Survives resolution changes (the worker
 * re-projects against the live frame size at inference time).
 * iter-191 (Feature #5).
 */
export type ZonePoint = [number, number]

/**
 * Closed polygon = ordered list of points. iter-191 server bounds:
 * 3-32 vertices per polygon, up to 16 polygons total.
 */
export type Zone = ZonePoint[]

export type DetectionConfig = {
  threshold: number
  cooldown_s: number
  enabled: boolean
  /** HH:MM (24h, local) — both must be set for the schedule to apply. */
  schedule_off_start: string | null
  schedule_off_end: string | null
  /** Lower-cased COCO class names the worker emits events for. */
  classes: string[]
  /**
   * iter-191 (Feature #5): polygon masks. When non-empty, only events
   * whose bbox-center falls inside at least one polygon are emitted.
   * Empty default = no spatial gating (pre-iter-191 behaviour).
   * iter-191 ships schema only; iter-191b wires the worker filter,
   * iter-191c lands the client `<canvas>` editor in Settings.
   */
  zones: Zone[]
  /** iter-254: seconds AFTER detection the recorder keeps writing.
   * Live-tunable; takes effect on the next event without a worker
   * restart. */
  clip_post_roll_s: number
  /** iter-254: seconds BEFORE detection the recorder includes.
   * Persisted now; the worker honours it once iter-255 lands the
   * rolling-segment recorder. */
  clip_pre_roll_s: number
  /** iter-257: retention/clip-cap preset — week / month / 5 years.
   * Picks BOTH retention_days AND the per-preset cap on
   * clip_post_roll_s / clip_pre_roll_s. */
  clip_retention_preset: RetentionPreset
  /** iter-305 (user "How do I know which cam is which? Right now,
   * I only have 1 camera, but it is not labeled at all"): friendly
   * display name for the camera (e.g. "Front Door", "Driveway").
   * Used as the Live page header. Multi-cam (MC Phase 1+) will
   * move this under a per-camera section. Default "Front Door". */
  camera_label: string
  /** iter-308 (user "make the infrastructure" for two-way audio):
   * gates the Live page Talk + Listen affordances. Defaults false
   * — Live page leaves them disabled with "Soon" caption until
   * the operator wires a mic + speaker (per the iter-307 hardware
   * recommendation) and flips this in Settings. */
  audio_enabled: boolean
  /** iter-356.6X (tiered-inference slice 4): when true, the worker
   * saves face + person crops on every detection for retraining.
   * Mirrors `face_capture_enabled` server-side. */
  face_capture_enabled: boolean
  /** iter-356.6X: bounded retention for the face/person capture
   * trees. Server clamps to [1, 365]. */
  face_capture_retention_days: number
  /** Continuous-capture (visit) feature — S5. When true, the worker
   * records one clip per VISIT (presence span) instead of one per
   * detection. Defaults false until the operator opts in. The worker
   * reads this off the config-poll. */
  continuous_capture: boolean
  /** S5: hard cap on a single visit's duration (seconds). Caps
   * stuck-detection disk fill. Server clamps to [30, 600]. */
  max_visit_s: number
  /** S5: post-roll grace (seconds) after the subject leaves before
   * the visit clip is finalized. NEW field (plan R3) — distinct from
   * the deprecated `clip_post_roll_s`. Server clamps to [3, 60]. */
  absence_finalize_s: number
}

/** A curated pick-list of common COCO classes shown as chips in Settings. */
export const COMMON_DETECTION_CLASSES = [
  'person',
  'car',
  'truck',
  'bicycle',
  'motorbike',
  'bus',
  'cat',
  'dog',
  'bird',
] as const

export const DETECTION_LIMITS = {
  thresholdMin: 0.05,
  thresholdMax: 0.95,
  cooldownMin: 0,
  cooldownMax: 60,
  // iter-254: per-event clip duration knobs. iter-257: bound is
  // the ABSOLUTE ceiling (week preset's 30 min). The active
  // per-preset cap is derived from `RETENTION_PRESETS` at runtime
  // and binds the slider's `max` prop.
  clipPostRollMin: 3,
  clipPostRollMax: 1800, // 30 min — week preset cap
  clipPreRollMin: 0,
  clipPreRollMax: 300, // 5 min — week preset cap
  // Continuous-capture (visit) feature — S5. Mirrors
  // MAX_VISIT_MIN/MAX + ABSENCE_FINALIZE_MIN/MAX in
  // server/app/services/detection_config.py. The slider UI (S6)
  // binds its min/max props to these.
  maxVisitMin: 30,
  maxVisitMax: 600,
  absenceFinalizeMin: 3,
  absenceFinalizeMax: 60,
} as const

// iter-257: retention/clip-cap presets. Mirrored from
// `server/app/services/detection_config.py::RETENTION_PRESETS`.
// Both sides hardcode these — the server's per-preset cap is the
// security boundary; the client uses them for slider `max` props
// + UI copy.
export type RetentionPreset = 'week' | 'month' | 'year_5'
export const RETENTION_PRESETS: Record<
  RetentionPreset,
  {
    label: string
    description: string
    retentionDays: number
    clipPostRollMaxS: number
    clipPreRollMaxS: number
  }
> = {
  week: {
    label: '1 week',
    description: 'Up to 30-minute clips',
    retentionDays: 7,
    clipPostRollMaxS: 1800,
    clipPreRollMaxS: 300,
  },
  month: {
    label: '1 month',
    description: 'Up to 15-minute clips',
    retentionDays: 30,
    clipPostRollMaxS: 900,
    clipPreRollMaxS: 150,
  },
  year_5: {
    label: '5 years',
    description: '30-second clips only',
    retentionDays: 365 * 5,
    clipPostRollMaxS: 30,
    clipPreRollMaxS: 0,
  },
}

export type WorkerMetrics = {
  fps?: number
  infer_per_s?: number
  /**
   * Which mode the inference loop is in:
   *  - `active`            — recently saw a detection, sampling at active FPS
   *  - `idle`              — no recent detection, sampling at lower FPS
   *  - `off`               — user toggled detection off (manual)
   *  - `scheduled-off`     — current time is inside the configured off-window
   *  - `low-memory`        — host MemAvailable below threshold; worker still
   *    draining frames but inference paused to free RAM
   *  - `thermal-throttled` — GPU above the 80 °C hot threshold; worker
   *    forced into idle-rate inference until temp drops below 70 °C
   */
  gear?:
    | 'active'
    | 'idle'
    | 'off'
    | 'scheduled-off'
    | 'low-memory'
    | 'thermal-throttled'
  frames?: number
  inferences?: number
  emitted?: number
  /**
   * Cumulative count of failed `Capture()` calls since worker start.
   * RTSP hiccups, decoder reconnects, and dropped buffers all increment
   * this. Useful to spot stream flakiness without journald access.
   */
  dropped?: number
  /**
   * Wall-clock latency of the most recent `net.Detect()` call, in ms.
   * Steady-state ~45 ms on the Nano 2GB at FP16; climbs sharply when
   * the GPU thermal-throttles, so this is the cleanest live signal of
   * thermal pressure on the inference hot path.
   */
  infer_ms_recent?: number
  /**
   * 95th-percentile inference latency over the worker's last 20
   * `net.Detect()` calls. Resilient to single-shot cold-cache spikes
   * (which `infer_ms_recent` exposes raw); a sustained p95 above the
   * baseline means actual throttling rather than a transient spike.
   */
  infer_ms_p95?: number
  /**
   * Times the worker's mediamtx watchdog has kicked the gateway since
   * worker start. Stays at 0 in healthy operation; rising values mean
   * the camera pipeline keeps going dark (USB hub, libargus, NvMMLite,
   * etc.) and detect.py is recovering by restarting mediamtx.
   */
  mediamtx_restarts?: number
  /**
   * iter-302: nvargus-daemon escalation count. Non-zero means the
   * mediamtx-only restart path didn't recover the stream and the
   * heavy-hammer (nvargus-daemon restart, then mediamtx) was needed.
   * Each escalation blanks all consumers for ~5-10 s.
   */
  argus_restarts?: number
  /**
   * iter-302: unix-epoch seconds of the worker's most recent
   * successful Capture(). 0 until the first real frame arrives.
   * The server derives `seconds_since_last_frame` on /api/status
   * from this; UI uses that instead of reading this directly.
   */
  last_frame_ts?: number
  /**
   * Wall-clock ms for the most recent `save_thumb()` call (iter-187,
   * Feature #9 observability). Captures the whole save path —
   * jetson_utils.saveImage + retention sweep — so an operator can see
   * what a detection event's I/O actually costs. Used to decide
   * whether the NVENC encode swap (~80 ms → ~10 ms claim) is worth
   * implementing for THIS deployment. 0 when no detection event has
   * fired yet this worker session.
   */
  thumb_ms_recent?: number
  /**
   * Wall-clock seconds since the detection worker started. Distinct
   * from the server-process uptime in `ServerStatus.uptime_s` — the
   * worker can restart independently when systemd (re)launches it
   * after a wedge. Use this to interpret cumulative counters
   * (`frames`, `dropped`, `mediamtx_restarts`).
   */
  uptime_s?: number
  /**
   * Distinct names currently in the worker's face-recognition database.
   * Empty/absent when face recognition is disabled (no encodings loaded
   * or the library isn't installed).
   */
  face_recog_names?: string[]
  /**
   * docs/logging_plan.md §1.2 — cumulative failure-rate counters since
   * worker start. Individual failures are logged to journald at their
   * call site; these let the UI/operator see the RATE over time. All
   * stay at 0 in healthy operation; a rising value points at the named
   * subsystem.
   */
  /** Clip recordings skipped because the in-flight recorder cap was hit. */
  clips_dropped_capacity?: number
  /** ffmpeg clip-recorder spawns that failed to start (missing binary, dir, RTSP down). */
  clip_start_failures?: number
  /** Face-recognition passes that raised (face_locations/face_encodings/decode). */
  face_recog_failures?: number
  /** Detection-event POSTs to the server that failed (network / non-2xx). Each is a LOST event. */
  event_post_failures?: number
  /** Thumbnail saves that failed (encode / write / retention sweep). */
  thumb_save_failures?: number
  /**
   * Continuous-capture observability (feat/continuous-capture, plan S6).
   * Only non-zero when the worker runs with continuous capture enabled;
   * both stay 0 / absent on the legacy fixed-clip path.
   */
  /** Visits that reached finalize — one continuous clip per visit. */
  visits_finalized?: number
  /** Opens refused because free disk fell below the worker floor (S4.5). A rising value means the card is filling faster than eviction reclaims. */
  clips_dropped_disk_floor?: number
  /**
   * Watchdog escalation state for camera capture wedges. The worker climbs
   * restart_mediamtx -> restart_nvargus -> reboot when libargus/RTSP stops
   * producing frames while the process is still alive.
   */
  /** Current persisted ladder index. 0 means healthy / bottom rung. */
  watchdog_level?: number
  /** Last watchdog rung name; empty string means no action has fired yet. */
  watchdog_last_action?: string
  /** Unix-epoch seconds of the last watchdog action. 0 means never. */
  watchdog_last_action_at?: number
  /** Unix-epoch seconds of the last guarded reboot attempt. 0 means never. */
  watchdog_last_reboot_at?: number
  /** Total watchdog escalations this worker session. */
  watchdog_action_count?: number
  /**
   * Last bounded wedge diagnostic snapshot captured immediately before a
   * watchdog escalation. Values correlate the "Failed to create
   * CaptureSession" / "Argus OverFlow" moment with nvargus RSS, GPU temp,
   * memory, and pending-event count. 0 means never or not parseable.
   */
  wedge_diag_at?: number
  wedge_diag_nvargus_rss_kb?: number
  wedge_diag_gpu_temp_c?: number
  wedge_diag_mem_avail_mb?: number
  wedge_diag_argus_pending?: number
}

/**
 * Auth user shape (iter-181, Auth Plan Phase 3). Mirrors the
 * server's `UserOut` Pydantic model. Keep these names in lockstep
 * with `server/app/routes/auth.py::UserOut`.
 */
export type User = {
  username: string
  role: string
}

export type LoginRequest = {
  username: string
  password: string
}

/**
 * Server response from POST /api/auth/login AND POST /api/auth/refresh.
 * Both routes set fresh access + refresh cookies via Set-Cookie
 * (HttpOnly, JS can't read them) and return only the user.
 */
export type LoginResponse = {
  user: User
}

/** Server response from GET /api/auth/me. Same shape as LoginResponse. */
export type MeResponse = {
  user: User
}

export type ServerStatus = {
  ok: boolean
  uptime_s: number
  camera: 'ok' | 'missing' | 'error'
  detection_active: boolean
  /**
   * True if the host-side detection worker has POSTed a heartbeat in the
   * last ~30 s. False during boot before the worker has phoned in once.
   */
  worker_alive: boolean
  /** Seconds since the last heartbeat, or null if never seen. */
  worker_last_seen_s: number | null
  /**
   * Latest metrics snapshot from the worker. Null when worker is dead so
   * the UI never shows stale telemetry.
   */
  worker_metrics: WorkerMetrics | null
  cpu_temp_c: number | null
  /**
   * GPU thermal zone (`GPU-therm` on Tegra). Distinct from
   * `cpu_temp_c` — under inference load the GPU rises faster and is
   * the actual thermal-throttle trigger on the Nano. Null on
   * platforms without a `GPU-therm` thermal zone.
   */
  gpu_temp_c: number | null
  /**
   * CPU throttle ceiling — `scaling_max_freq / cpuinfo_max_freq` as a
   * percent. 100 = the kernel governor will let the CPU run at full
   * clock; below 100 = a thermal trip, `nvpmodel` cap, or other policy
   * has pulled the ceiling down. This is the *headroom*, not the
   * current frequency, so it's stable at idle and only drops when the
   * platform is actually throttling. Null on platforms without cpufreq.
   */
  cpu_freq_pct: number | null
  /** Linux load average [1m, 5m, 15m]. Null on non-Linux. */
  load_avg: [number, number, number] | null
  memory_used_mb: number | null
  memory_total_mb: number | null
  disk_free_gb: number | null
  fps: number
  /**
   * Live count of registered Web Push subscriptions on the server
   * (iter-155). Lets the Settings UI ambiently surface "N devices
   * receive notifications" so the user can verify a subscription
   * landed without firing a test push. Always non-negative.
   */
  push_subs_count: number
  /**
   * Seconds since the worker's most recent successful Capture()
   * (iter-302). null when the worker has never reported a frame yet
   * (booting / never received one). Distinct from `worker_last_seen_s`
   * which is heartbeat freshness — the iter-300 outage had heartbeat
   * fine for 14 hours while this counter would have climbed to
   * 50,000+. UI flips a "STREAM STALE" pill when this exceeds ~60.
   */
  seconds_since_last_frame: number | null
  /**
   * iter-313 (performance-auditor #3): friendly camera label
   * inlined from /api/detection/config so the Live page can read
   * it off the existing 5 s poll instead of a dedicated mount-
   * fetch. Same value as DetectionConfig.camera_label.
   */
  camera_label: string
  /**
   * iter-313: two-way audio gating, inlined from
   * /api/detection/config for the same reason. Live page reads
   * this to enable/disable the Talk button without an extra RTT.
   */
  audio_enabled: boolean
}
