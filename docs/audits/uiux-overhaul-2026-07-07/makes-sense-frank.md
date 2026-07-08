# Frank's Brutal Review of the Home Camera Thing — 2026-07-07

## The first thing that pissed me off

Honestly? I had to go looking for things to complain about, and that has never happened to me before with an app my son built. But I found my opening move fast: I rotate my phone sideways to actually watch the door — the whole point of "full screen" — and the button to get back OUT of full screen is a little `‹` arrow crammed into a 36-pixel box (`w-9 h-9`, Watch.tsx:435). Everything else in this app got the memo about 44 pixels. This one button didn't. My thumb is bigger than my grandson's, and I missed it twice before I found it. If you're going to make me rotate my whole phone to see the picture, don't make the way out a game of pixel-hunting.

## Category A — I can't tap that (4 findings)

> "I'm hitting the wrong button half the time. My finger isn't a stylus."

[A1] `client/src/pages/Watch.tsx:430-438` — the "Exit full screen" `‹` chevron button in fullscreen mode is `w-9 h-9` (36×36px). Every other on-video button in this app (bbox toggle, native-fullscreen toggle, snapshot, quality menu) is 44×44px. This is the one exception, and it's the button I need most urgently when I've had enough of staring at a giant black rectangle. **Fix:** bump to `w-11 h-11` to match the rest of VideoTile's corner buttons.

[A2] `client/src/pages/settings/DetectionSection.tsx:502` — the "What to detect" class chips (person/cat/dog/etc.) are `min-h-[36px]`. Every other tappable control in Settings got bumped to 44px years ago (the comment on the SettingsTabs even brags about it). These chips got left behind. **Fix:** `min-h-[44px]` to match the rest of the tab.

[A3] `client/src/components/VideoPlayer.tsx:152,166` — inside the clip player (the thing I open every single time I tap an event to see who was at the door), the Speed dropdown and the Repeat button are both `min-h-[36px]`. This is the ONE screen my wife uses the most — checking "who rang the bell at 2pm" — and its two secondary controls are below the touch-target floor the rest of the app respects. **Fix:** bump both to `min-h-[44px]`; there's plenty of width in that strip.

[A4] `client/src/pages/Watch.tsx:474-480` — the fullscreen "Snapshot" rail button is a proper 54×54px box, good — but it's the ONLY item in a `flex-col` rail. If a future Talk/Listen button gets re-added here (the code comment says it's coming back), make sure whoever does it keeps 8px+ gaps — I've seen apps cram a second button in at the last minute and ruin a good thing.

## Category B — I can't read that (6 findings)

> "Look, I've got bifocals. Don't make me squint."

[B1] `client/src/pages/Watch.tsx:833` — the fullscreen rail button's text label ("Snapshot"/"Saving…") is `text-[8.5px]`. That is smaller than the fine print on a pill bottle. I get that it's a secondary caption under a big icon, but 8.5px is below anything I can read without my glasses AND my glasses. **Fix:** bump to at least `text-[11px]`.

[B2] `client/src/pages/Watch.tsx:799` — the fullscreen hour-scrubber's "12 AM / 6 AM / 12 PM / NOW" labels are `text-[9px]` white-on-black. Same problem — I can see there ARE labels, I cannot read what they say without squinting hard.

[B3] `client/src/components/BottomNav.tsx:125` — when I turn my phone sideways, the bottom nav becomes a left-hand rail and the tab labels shrink to `text-[9px]` (`landscape-phone:text-[9px]`). I get that landscape is tight on space, but this is the app's primary navigation, and it's now smaller than a receipt.

[B4] `client/src/components/EventHeatmap.tsx:279` — the little detection-count number inside each calendar day cell is `text-[9px]`. I can see the day number fine (that's `text-sm`), but the count next to it — "was that a 3 or an 8?" — I genuinely cannot tell at a glance.

[B5] `client/src/components/LiveStats.tsx:338-350` — this "Frame rate / Inference / Last frame / Disk free" panel uses `text-[9px] text-white/55` labels — 9px AND low-opacity white. I checked and this component doesn't seem to render anywhere in the current app (nobody wires it up), so no user sees it today — but if a future iter resurrects it as a debug overlay, it needs a contrast and size pass before it ships. Flagging it now so it doesn't sneak out half-baked.

[B6] Overall: this is a genuinely well-lit app. I went looking for gray-on-gray text (`text-neutral-500` on `text-neutral-900`, the classic sin) and found ZERO instances outside test comments — somebody already swept that. Good. My complaints above are all about SIZE, not contrast — the colors are fine, the print is just too small in a handful of spots.

## Category C — Where the hell is that thing (2 findings)

> "I can't find the close button. I can't find the back button. I can't find anything."

[C1] Nothing here on modals — I went looking for a trap (a modal with no visible close-X, a dead-end screen) and couldn't find one. ClipModal has ESC + backdrop-click + a visible Close button (`client/src/components/ClipModal.tsx:904`), and the confirm dialog does too (`client/src/lib/confirm-impl.tsx`). Both restore keyboard focus to whatever I tapped to open them. That's the kind of detail I don't expect from a hobby project.

[C2] Minor, not a real gripe but worth a note: the "Review" nav tab (training queue) is hidden from the bottom nav on portrait phones — it only shows up as a rail item in landscape, or one tap inside "Faces" on portrait (`client/src/components/BottomNav.tsx:32`, documented as deliberate). That's a fine call — I wouldn't want a 5th icon squeezed onto my home-screen nav bar — but if my wife ever needs to correct a mis-identified face, she has to know to go to Faces first. Not hidden exactly, just one tap further than the other three things she does daily.

## Category D — Speak English, please (1 finding — and I mean it)

> "Why does my camera app talk to me like a textbook?"

I grepped this whole client for WHEP, VAPID, RTSP, NVENC, ICE, bbox, websocket — all the greasy engineer words — and they do NOT leak into anything I, the user, would ever read. "Confidence threshold" is now "Sensitivity" with a plain-English qualifier ("Loose: more events" / "Balanced" / "Strict: fewer events") right next to the number (`client/src/pages/settings/DetectionSection.tsx:44-48`). "VAPID keys and push subscriptions" got swept into "Saves your accounts, notification setup, detection settings, and camera zones" (`client/src/pages/settings/DangerZone.tsx:97`). "Two-way audio" is "Talk through the camera." The reboot button used to say "Reboot Jetson" — now it says "Restart the camera box," and the confirm dialog spells out exactly what breaks (in-flight recording, open Live tabs need reconnecting) instead of a vague "will be unavailable."

[D1] The one thing I'd still push on: `client/src/pages/settings/DetectionSection.tsx` still has section headers "Watching," a tab called "Watching" in the sidebar, AND a "Sensitivity" slider all living together, plus a separate DangerZone section literally called "Danger zone." None of these are jargon exactly, but a first-time visitor scanning the Settings rail sees "Alerts / Watching / Account & System" and has to guess which one has the "turn off notifications between midnight and 6am" toggle (it's in Alerts, correctly, but nothing on the tab strip hints at "schedule"). Not a blocker — just note it if you ever do a second copy pass.

## Category E — When something breaks I'm on my own (1 finding, mostly praise)

[E1] Every error path I checked (Login, Events, Settings, ClipModal, the video tile itself) pairs its error message with a concrete next step and a real Retry/Reconnect button — not a dead "Something went wrong." The one generic ErrorBoundary fallback ("Something went wrong in X. Try again first. If it does not recover, Reload app below usually fixes it.") is actually the RIGHT kind of generic — it's the last-resort catch-all, it still gives me two buttons (Try again / Reload app), and it says which one to press first. I have no real complaint here. If I'm forced to nitpick: the video tile's error states use five different amber/red pills with subtly different meanings (worker offline vs. low memory vs. thermal vs. stream stale vs. paused) — that's a LOT of pill vocabulary for one video. I only found this comprehensible because I read the code comments explaining the precedence ladder. My wife will just see "a yellow thing changed" and move on, which honestly might be fine, but it's worth knowing the pill system is built for someone who reads release notes, not someone glancing at a phone.

## Category F — Empty screens look broken (0 findings)

Nothing here. Every empty state I found (Watch's "All quiet so far," Events' filtered-to-zero hint that explains WHICH filter to clear, the push-notification "no devices signed up yet — flip the toggle" line) tells me what's going on and what to do about it. Whoever built the `CatEmptyState` component and made it the ONLY empty-state primitive in the app deserves a beer for that discipline — I didn't find a single screen that goes blank and just sits there.

## Category G — Too many taps (1 finding)

[G1] Minor: turning off overnight alerts requires Settings → Alerts tab → scroll to schedule fields → type two times. That's fine, it's a set-once thing. My only actual gripe is upstream of this: on first open, Settings lands on the Alerts tab by default (a deliberate, documented, GOOD choice — that's where 90% of visits go), but there's no visible hint on the tab strip itself that a Schedule/quiet-hours control lives inside "Watching" vs "Alerts" — I had to open both tabs to find it. See D1 above; same root issue.

## Category H — One-click "ruin your day" buttons (0 findings)

I went hunting hard for this one — it's usually where apps fail me — and struck out entirely. Sign out requires a confirm ("You'll need your password to sign back in," `client/src/pages/settings/AccountSection.tsx:23-31`). Restart-the-camera-box, Install-updates, and Restore-from-backup are all in a visually separate red-bordered "Danger zone" card, all destructive-styled buttons (outline red, not the same pill as the blue "Back up" button next to them), and every single one gets a confirm dialog that tells me EXACTLY what I'm about to lose ("Any clip currently being recorded will be lost. Open Live tabs will need to tap Reconnect."). Bulk-delete on Events tells me how many events and asks me to type nothing but confirms with a red button that's visually distinct from the gray Cancel next to it. I could not find a single accidental-delete trap in this whole app. That's rare.

## Category I — Things my wife couldn't do without calling me (1 finding — a real one)

[I1] The Wife Test, run honestly: I walked through "open app → see who's at the door" (instant, the video's right there, camera name pill tells you which camera), "check what happened today" (Watch's home screen leads with "Today at home" + a plain-language "N sightings" glance card), "watch a clip" (tap the row, video opens with a big Close X), "rotate the phone" (the docked tile becomes a proper two-pane landscape layout, not a squished portrait page — somebody clearly tested this on a real phone), and "get a notification and act on it" (the permission-denied banner has step-by-step per-platform instructions for turning notifications back on, written for someone who doesn't know what a "service worker" is). She'd be fine on all of those — genuinely, no complaints. Where she'd get stuck: if her phone's browser has silently revoked notification permission (which happens more than you'd think — an OS update, a "clear site data," whatever), the app can't tell her until she opens Settings and sees the red banner — there's no proactive nudge anywhere else in the app (no badge on the Alerts tab, nothing on the Watch home screen) telling her "hey, you stopped getting alerts 3 days ago." She'd only find out the hard way — a stranger showed up and she never heard about it — and THEN she'd call me. **Fix:** surface a small "Alerts are off" chip on the Watch home screen (or a badge on the Settings nav icon) when `permissionDenied` is true, instead of only showing it once she's already inside Settings → Alerts.

## What I actually liked

I want to be straight with you: I came into this expecting to find the usual disaster — gray text on gray backgrounds, delete buttons that look like save buttons, "confidence threshold: 0.55" sliders with no explanation, a Sign Out button one fat-finger away from the thing I actually wanted to tap. None of that is here. Somebody — and I can see from the code comments it was more than one somebody, across a LOT of iterations — has clearly sat a non-technical person down in front of this app before and taken notes. The confirm dialogs read what's about to happen in plain language. The destructive buttons are visually distinct from the safe ones. The empty states tell you what to do next instead of just being blank. Jargon got systematically hunted down and replaced — "Sensitivity" instead of "confidence threshold" is exactly the kind of fix I'd have demanded, and it's already done. The touch targets are 44px basically everywhere except the four spots I found above. That's an unusually good hit rate.

The one thing that impressed me most: the reboot/update/restore confirm dialogs don't just say "are you sure" — they tell you specifically that an in-flight recording clip will be lost and that open tabs need reconnecting. That's the kind of honesty that actually earns trust, instead of the vague "this action cannot be undone" boilerplate every other app ships.

## Top 3 fixes I'd do first if I were the developer

1. **Fix the fullscreen exit button.** `client/src/pages/Watch.tsx:435` — bump `w-9 h-9` to `w-11 h-11` so the one button I need most in landscape mode isn't the one button in the app that's too small to hit reliably.
2. **Bump the clip-player Speed/Repeat controls to 44px.** `client/src/components/VideoPlayer.tsx:152,166` — this is the screen my wife opens most often (checking who was at the door), and its secondary controls fall below the touch-target floor the rest of the app respects.
3. **Surface a passive "Alerts are off" signal outside of Settings.** When `permissionDenied` is true (`client/src/pages/settings/NotificationsSection.tsx:91`), put a small badge or chip on the Watch home screen or the Settings nav icon — right now the only way to discover a silently-revoked notification permission is to go looking for it, and a missed alert means a missed visitor.
