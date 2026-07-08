**Risky Core Contract**

Push gateway leg = real persisted subscriptions + real VAPID keys + real server push code must transform one canonical detection event into exactly the eligible Web Push sends, without leaking subscription secrets.

Contract:
`/api/_internal/event` inserts the event, builds payload `{title, body, tag, url, event_id, unread_count, optional image}`, then calls `PushService.send_matching(event, payload)`. `send_matching` must apply per-sub filters first: `cameras`, `person_names`, and `schedule_window`/quiet-hours. Only matching subs reach `_fanout_to`. `_fanout_to` must use real VAPID, send JSON payload through real `pywebpush.webpush`, count successes, prune only gateway `404/410`, preserve transient/5xx/auth failures, and never log endpoint/key bytes.

**What Real Gateway Can Prove**

Without a phone in hand, this leg can honestly prove:

1. Real subscription JSON and real VAPID PEMs load into the actual `PushService`.
2. Real Mozilla autopush endpoints accept or reject the encrypted Web Push request.
3. Success semantics: gateway accepted delivery, ideally observed as `201 Created` if `pywebpush` exposes the response; otherwise “no exception from pywebpush and `sent == N`” is the service-level proof.
4. Dead-sub semantics: `404/410` causes prune from the in-memory/file registry, and no other status does.
5. Payload shape before encryption: title/body/tag/url/event_id/unread_count/image exactly as `_internal/event` would send.
6. Filter/quiet-hours gating happens before network send by observing selected subscriptions with `webpush` blocked/spied, then separately live-sending only the selected set.
7. TTL/urgency can be pinned at the pywebpush call boundary if the service passes explicit kwargs. A gateway round-trip can prove the request was accepted with those parameters, but not that a phone displayed them.

It cannot prove notification display, image render, Android badge update, service-worker click behavior, or user-visible delivery. That is the deferred device leg.

**Atomic Step List**

1. `server/tests/harness_push_gateway/test_fixture_parser.py`  
   Parse `.jetson-snapshot/proof_fixtures/push/push_subs.json`; assert 8 rows, valid shape, Mozilla host-only classification, no assertion output includes endpoint/key material.

2. `server/tests/harness_push_gateway/test_vapid_fixture_load.py`  
   Load `.jetson-snapshot/proof_fixtures/push/vapid_private.pem` and `vapid_public.pem` through real `PushService.load_keys`; assert `private_pem`, `public_key_b64`, `_vapid_obj` present.

3. `server/tests/harness_push_gateway/test_secret_redaction.py`  
   With copied real fixture loaded, force one synthetic failure and assert logs contain gateway host only, never endpoint path, `p256dh`, `auth`, or full JSON.

4. `server/tests/harness_push_gateway/test_payload_contract.py`  
   Post a canonical internal event with `thumb_url`; spy `send_matching`; assert payload has title/body/tag/url/event_id/unread_count/image and no subscription fields.

5. `server/tests/harness_push_gateway/test_payload_no_image_contract.py`  
   Same event without `thumb_url`; assert `image` key is absent, not null.

6. `server/tests/harness_push_gateway/test_filter_camera_gate.py`  
   Load copied real subs but replace only metadata filters locally; spy `_fanout_to`; assert camera mismatch never reaches send.

7. `server/tests/harness_push_gateway/test_filter_person_gate.py`  
   One invariant: `person_names` filters select only matching event person, including multi-sub mixed match/no-match.

8. `server/tests/harness_push_gateway/test_filter_schedule_gate.py`  
   One invariant: `schedule_window` quiet-hours gate rejects outside-window event before `_fanout_to`.

9. `server/tests/harness_push_gateway/test_send_kwargs_contract.py`  
   Spy real `webpush` call boundary; assert payload JSON, VAPID object, subject, and explicit TTL/urgency kwargs. If current code lacks TTL/urgency, this should be the small failing step that adds them.

10. `server/tests/harness_push_gateway/test_live_test_push_gateway.py`  
   SKIPIF-gated. Use real copied fixture + VAPID; call `send_all` with harmless test payload; assert success count plus non-secret log hygiene. No pruning assertion here.

11. `server/tests/harness_push_gateway/test_live_detection_payload_gateway.py`  
   SKIPIF-gated. Use one known-current copied real sub and `send_matching` with an event-shaped payload including image/unread_count; assert gateway accepted one eligible send.

12. `server/tests/harness_push_gateway/test_live_prune_404_410.py`  
   SKIPIF-gated and preferably Jetson-only. Run against the real server/secrets volume snapshot with stale subs available; assert only `404/410` responses prune, resulting persisted `push_subs.json` count drops by exactly dead count, with no endpoint bytes in failure output.

**Where Steps Run**

Steps 1-9 run locally with copied fixtures under `.jetson-snapshot/proof_fixtures/push/`. They need real subscription/key bytes, but no network, and the skip gate keeps CI green when fixtures are absent.

Steps 10-11 can run locally with copied fixtures if outbound network is available, but Jetson-over-SSH is cleaner because it avoids copying secrets and uses the production Python/container environment.

Step 12 should run on Jetson over SSH against the live secrets volume or a Jetson-local copy. It mutates/prunes real subscription state, so it should not be a casual local test unless the fixture is an explicit disposable copy.
