# iOS Web Push readiness (checked 2026-07-07)

Verdict: the code is already iOS-ready; no client or server changes needed.
What iOS (16.4+) requires and where we stand:

- App must be installed to the home screen (push is unavailable in tab
  Safari). Our manifest has `display: 'standalone'` (vite.config.ts:137) and
  `apple-touch-icon` links shipped in iter-356.66, so Add to Home Screen
  produces a real install.
- Push must use standard Web Push (VAPID) via PushManager: `lib/push.ts`
  does, with `userVisibleOnly`.
- Permission prompt must come from a user gesture: ours is the Alerts toggle
  in Settings.

Untestable here: nobody in the household carries an iPhone right now, so
this has never been verified on real hardware. When one shows up:
Safari → share → Add to Home Screen → open the installed app → Settings →
Alerts → toggle on → trigger a detection. If the OS drops the thumbnail,
remember the push daemon fetches `image:` without cookies — only the
`^thumb_[0-9]+\.jpg$` carve-out is unauthenticated, which is already the
shipped shape.
