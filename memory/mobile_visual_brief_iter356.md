---
name: Mobile visual identity brief — iter-356 (Aiko)
description: Senior-brand-designer brief for the HomeCam PWA mobile surface. Translates the iter-356.57 "Watchpost at Dusk" dark-den system + the cat-trio identity into concrete typography, color, depth, illustration, and motion rules an implementer can ship without guessing.
type: project
---

> Authored by **Aiko** (mobile visual identity designer persona). Read-only audit of `client/src/index.css`, `client/index.html`, `client/vite.config.ts`, `client/src/components/CatIcons.tsx`, `client/src/components/CatEmptyState.tsx`, `client/src/lib/sentryCat.ts`, `client/src/pages/Live.tsx`, `Events.tsx`, `Settings.tsx`, `memory/cat_mascot_spec.md`.

## 1. Tone (one paragraph)

HomeCam at 360–430 px should feel **den-quiet and hearth-warm** — a *handcrafted watchpost*, not a SaaS dashboard. The emotional register is what you feel checking on the cats at 11 pm with the lights off: amber candle-glow, leather-bound surfaces, parchment text, the steady breathing of an animal on duty by the door. Calm, watchful, low-key proud. NOT "sleek," NOT "modern," NOT "pro" — those are nothing words and they are how the iter-356.25 cream theme drifted into Linear-clone territory before iter-356.57 dragged it back. The dark "Watchpost at Dusk" palette in `client/src/index.css:42-92` already encodes this; the job of this brief is to keep every mobile surface *honoring* it instead of leaking generic-app patterns back in.

## 2. Type scale (mobile, 360–430 px)

Tokens are already declared (`client/src/index.css:162-167`); the missing layer is *what role each one plays*. Pin:

| Role        | Token         | px / line  | Family                          | Weight | Used for                                                                 |
| ----------- | ------------- | ---------- | ------------------------------- | ------ | ------------------------------------------------------------------------ |
| display     | `--text-2xl`  | 28 / 1.1   | `--font-display` (Fraunces)     | 700    | Page titles + camera label on Live (`Live.tsx:170`); brand wordmark.     |
| headline    | `--text-xl`   | 22 / 1.2   | `--font-display` (Fraunces)     | 600    | Day-headers in Events; "Panther on watch" sentry headline; modal titles. |
| section     | `--text-lg`   | 18 / 1.3   | `--font-sans` (Inter)           | 600    | `CatEmptyState` heading (`CatEmptyState.tsx:108`); card titles.          |
| body        | `--text-base` | 15 / 1.5   | `--font-sans` (Inter)           | 400    | Event-card descriptions; form fields; settings rows.                     |
| meta        | `--text-sm`   | 13 / 1.4   | `--font-sans` (Inter, tabular)  | 400    | Timestamps, counts, hints, secondary labels (`Events.tsx:738`).          |
| micro       | `--text-xs`   | 11 / 1.4   | `--font-sans` (Inter, tabular)  | 500    | Pill labels, badge captions, status chips ONLY. Never running prose.     |

Hard rules:

- **Display + headline = serif (Fraunces) only on h1 / h2 / wordmark.** Body, controls, security copy stay Inter — `client/src/index.css:155-160` calls this out and it is correct. Never set a button or input in Fraunces; it kills scan-speed.
- **Tabular numerics on every count/timestamp.** `font-feature-settings: 'tnum'` (or just rely on the body's `'cv11', 'ss03'` plus `tabular-nums` utility). Event timestamps in lists currently rely on the body inheritance; pin `tabular-nums` on the time column so digits don't dance row-to-row.
- **No `text-xs` (11 px) for instructional copy.** `CatEmptyState.tsx:114` already promotes hints to `text-sm`. Hold that line everywhere — 11 px is for chips and badges only.
- **Letter-spacing is taken care of in CSS** (`index.css:312-318`); don't override per-component.

## 3. Color usage matrix

For each token in `client/src/index.css:48-119`, exactly which mobile element should use it:

| Token                       | Use exactly here                                                                                                                        | Don't use for                                              |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `--color-bg`                | `<body>`, page wrappers, BottomNav backdrop. Anywhere a thumb might rest.                                                               | Cards, modals, video field (those have their own surfaces).|
| `--color-surface`           | Cards (`card-paper`), modal sheet, settings rows, event-list row when *not* selected.                                                  | Page bg, BottomNav, ribbon — those stay `--color-bg`.      |
| `--color-surface-raised`    | Hover/pressed state on rows, input field bg, nav-tab inactive bg, slider track (`index.css:513`).                                       | A second tier of cards — mobile gets ONE card depth.       |
| `--color-surface-overlay`   | Modal/Drawer/Sheet bg. Same value as surface intentionally — modals lift via shadow, not hue.                                          | Toasts (those use semantic-bg tokens).                     |
| `--color-border-subtle`     | Section dividers between rows; the bottom rule under a sticky header (`Events.tsx:719`).                                                | Card outlines — those need `--color-border`.               |
| `--color-border`            | Card outlines, input outlines, default chip border.                                                                                    | Hover/focus state — that's `--color-border-strong`.        |
| `--color-border-strong`     | Hover-card border, "Filter active" chip border, the active-affordance border on focusable rows.                                        | Always-on emphasis — overuse and the leather stitch shouts.|
| `--color-text-primary`      | Headings, body copy, card titles, primary numbers.                                                                                     | Timestamps, metadata, hints — too loud at full parchment.  |
| `--color-text-secondary`    | Card subtitles, "Last frame 3 s ago," "All quiet — no events yet" body copy.                                                            | Disabled state.                                            |
| `--color-text-tertiary`     | Timestamps, count chips ("12 events"), captions, hints under empty-state body.                                                          | Anything a user must read to decide an action.             |
| `--color-text-disabled`     | Disabled buttons, greyed nav items.                                                                                                     | Static low-priority labels — those are tertiary.           |
| `--color-accent-default`    | Primary CTA fills, focus ring, paw-mark on active nav (`index.css:419,438`), text-selection (`index.css:350`), sentry-cat headline glyph.| Borders on neutral cards (would scream "selected"); large text fills (use only on small icons / pills).|
| `--color-accent-bright`     | Hover state on accent fills; "Resume" / "Pause" action label inside `DetectionStatusToggle` (`Live.tsx:357`).                            | Static labels — reads as a perpetual hover.                |
| `--color-accent-subtle`     | Selected-chip bg, active filter-tab bg, "active settings tab" bg (`Settings.tsx:244`).                                                  | Empty-state surfaces (cream-on-charcoal, not warm enough). |
| `--color-accent-muted`      | Pressed-state on `ActionButton` only.                                                                                                   | Anything else — keep it scarce.                            |
| `--color-accent-bg/-border` | Inline-info callouts that are accent-themed (filter-active strip in Events). Pre-tokenized so opacity-on-var bug doesn't recur (`index.css:91-119`).| Persistent layout — they're for *moments*, not always-on chrome.|
| `--color-brass-default`     | The *one* per-page "On <Cat>'s watch" sigil glyph; Login wordmark underline; SideNav family-sigil mark.                                  | Anything else. Brass is a **scarce** accent — one element per screen, max two.|
| `--color-brass-bright`      | Hover on the sigil only.                                                                                                                | General hover states — that's accent-bright's job.         |
| `--color-success`           | Armed-dot, face-match badge, success toast text + dot.                                                                                  | "Save" buttons (those are accent — Stroop violation).      |
| `--color-warning`           | Thermal/paused badge, "off duty" text in `DetectionStatusToggle` (`Live.tsx:370`), warning-toast accents.                                | A neutral "info" channel.                                  |
| `--color-danger`            | Destructive icon glyphs, danger-toast text, "Delete" link tint.                                                                         | Borders on danger *containers* (use `--color-danger-border`).|
| `--color-danger-strong`     | Filled "Delete forever" CTA only (white text on red).                                                                                   | Inline text — too saturated to read against parchment.     |
| `--color-danger-muted`      | "Danger zone" group-container border in Settings.                                                                                       | Anything outside a confirm/destructive surface.            |
| `--color-info`              | Info-toast accent, neutral helper notice.                                                                                               | Status pills — those are success/warning/danger only.      |
| `--color-*-bg / -border`    | Tinted callout surfaces (success/warning/danger/info/accent). Use the `*-bg` for the fill and `*-border` for the 1px outline.            | Always-on chrome. They're for *moments*, like accent-bg.   |

**Code-level catches (anywhere this brief overrides what's currently shipped):**

- `client/vite.config.ts:51-52` — manifest `theme_color` and `background_color` are `#faf6ee` (the dropped iter-356.25 cream). On install, the Android adaptive-icon background and iOS splash paint cream while the running app is charred-oak. **Flip to `#1e1710`** to match `--color-bg`. The `index.html` `theme-color` meta is also still on `#e8d4ac` (cream-deeper toasted-wheat, line 28-29) — that one is intentional for the *status bar* (warm-light reads as warmer than the body bg behind it), but the manifest values must match the page bg, not the status bar. **Two different surfaces, two different rules; right now both are wrong.**
- `Live.tsx:333` — "Panther's off duty" hardcoded copy. The iter-356.64 sentry-cat rotation in `client/src/lib/sentryCat.ts:114` already exposes `sentryOffDutyLabel(cat)` for exactly this. Wire it up when this redesign lands or the rotation feature visibly contradicts the headline.
- `Events.tsx:1175-1176` — face-match selected chip uses `--color-success-bg` for "match" and `--color-accent-subtle` for "any other selected." That's correct (success = positive identity, accent = active-filter), but the *visual weight* is too similar at 360 px. Increase the selected chip's ring to `ring-2` so success-vs-accent reads at thumb distance.
- Don't reintroduce raw hex anywhere. Every raw hex outside `index.css` is a token leak.

## 4. Depth + elevation (two tiers, that's it)

Mobile gets exactly **two elevation tiers**:

1. **Page** — `--color-bg`, no shadow, no border. The "leather table the watchpost sits on."
2. **Card / sheet** — `.card-paper` (`index.css:236-241`): `--color-surface` fill, `--color-border` 1 px, `--radius-2xl` (20 px), shadow stack `var(--shadow-card), var(--shadow-card-inset)`. The inset top-edge highlight at `rgb(240 230 208 / 0.06)` is the load-bearing trick — it's what makes the surface read "physical object under candlelight" instead of "flat div." Don't drop it.

Modals lift one notch further via `--shadow-overlay` only (no extra border), per `index.css:189`. **There is no third tier on mobile.** If a screen seems to need one, you have too much in it.

Radii — pin at point of use:

- `--radius-sm` (4 px): inline numeric badges only.
- `--radius-md` (8 px): video-overlay confidence pills.
- `--radius-lg` (12 px): standard buttons + form fields.
- `--radius-xl` (16 px): inline cards inside scrolling lists.
- `--radius-2xl` (20 px): top-level page cards + sheets (matches `.card-paper`).
- `--radius-pill`: pills, chips, status badges, the armed-badge on Live (`Live.tsx:282`).

Mobile must not ship glassmorphism on neutral chrome. The video field's `bg-black/55 backdrop-blur` overlays (`Live.tsx:282, 352`) are the **only** legitimate use — they sit on a real photographic background where the blur reads as a darkroom safelight. Do not add `backdrop-blur` to a `--color-surface` card; on a flat charred-oak bg the blur dissolves into a fuzzy grey rectangle.

## 5. Illustration deployment plan

There are 7 sprite poses in `CatIcons.tsx` (`walk`, `walk2`, `sit`, `sit2`, `sleep`, `hiss`, `groom`, `stretch`, `play` — 9 actually, see `cat_mascot_spec.md:23-33`) plus three face icons and one `SleepingCatIllustration`. Deploy strategy on mobile:

| Pose / asset                | Where it appears                                                                                                       | Size      | Reduced-motion alternative                                                |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------- |
| `SleepingCatIllustration`   | Default `CatEmptyState` `mood='calm'` (`CatEmptyState.tsx:86`). Events empty, Notifications empty.                      | 96 px     | Already static SVG. Z's animate via opacity — reduced-motion clamps to 0.01ms via global @media (`index.css:471`). Single Z visible. Done. |
| `TuxedoSprite state="sit"`  | `CatEmptyState` `mood='curious'`: People page empty, Training onboarding card.                                          | 96 px     | Static. No motion.                                                        |
| `BombaySprite state="sit"`  | `CatEmptyState` `mood='watching'`: Review queue empty, Live "stream stalled" recovery state.                            | 96 px     | Static.                                                                   |
| `CatTrioMark` (3 face icons)| Login screen ONLY, and the SideNav header on desktop. Not on mobile chrome.                                              | 28–32 px  | Static raster from sprite sheet (`CatIcons.tsx:101-105`). No motion.      |
| Face icon (single sentry)   | The Live page's "watch panel" header + the sentry-cat headline on the BottomNav-adjacent armed strip (when wired).      | 24 px     | Static raster. The *rotation* is a 30-min server-tick (`sentryCat.ts:32`), not animation — reduced-motion has nothing to suppress. |
| Side-profile sprite (any)   | `CatLayer` ambient walker only.                                                                                          | 36–72 px  | `CatLayer` already respects `prefers-reduced-motion` via the global @media; sprite freezes on its current frame. **CRITICAL** (`CLAUDE.md`): no CSS `transition` on per-frame `transform`, `dt` clamp 33 ms, `willChange: transform` — non-negotiable. |
| `hiss`, `play`, `stretch`   | Reserved for `CatLayer` ambient choreography. **Do not place in static UI.** Hiss in a corner of a settings card reads as bug, not personality. | n/a       | n/a                                                                       |
| `PawMark` glyph             | Active-nav indicator only — handled via CSS mask in `index.css:404-445`. Not a React component on mobile.                | 14 px     | Static.                                                                   |

**Cap the mascot density.** A mobile screen should show **at most one cat** at any time, except:

1. The `CatTrioMark` on Login (intentional ensemble shot).
2. The `CatLayer` ambient walker (which is *already* one cat at a time, capped by `MAX_CATS` in the layer).

If a screen shows the sentry-cat headline AND the Live watch-panel face AND a `CatLayer` walker AND an empty state, the user is being shouted at. Pick one ambient + one functional, never more. The Maya brief flagged this exact failure mode — "you sprinkled them on every card."

## 6. Motion guidelines

The dark-den theme cannot tolerate bouncy motion. Springs that feel right on a Google-Material light theme read as "cheap" against parchment-on-leather. Tokens already at `index.css:195-199`:

- `--duration-fast` (80 ms): pressed-state colour change, focus-ring appearance, slider thumb scale (`index.css:529`).
- `--duration-base` (160 ms): toast slide-in (`index.css:282`), modal fade, sheet entry, BottomNav tab swap.
- `--duration-slow` (280 ms): Login entrance only (`index.css:260`).
- `--ease-out` for entries; `--ease-in-out` for state changes that round-trip.

The **only** animations on mobile:

1. **Modal / sheet entry** — fade + 8 px translate-up over `--duration-base`, ease-out. ConfirmDialog, ClipModal, SnapshotPreview.
2. **Pull-to-refresh** on Events list — native browser pull. Don't custom-animate; the platform spinner is part of the trust register.
3. **Sentry-cat rotation flip** — when `sentryCatAt(now)` returns a new cat, fade the headline glyph + name with a 160 ms cross-fade. No slide. The flip is a *change of season*, not a flourish.
4. **`CatLayer` ambient walk** — already implemented; constraints in CLAUDE.md are load-bearing (`dt` clamp 33 ms, no `transition` on `transform`, `willChange: transform`). Don't touch.
5. **Toast in/out** — `animate-toast-in` (`index.css:282`). Out is unanimated (immediate hide on dismiss).
6. **Paw-spinner** for loading (`index.css:488-498`) — the only acceptable spinner. Don't reintroduce a generic ring spinner anywhere.

What does NOT animate on mobile:

- Card hover (no hover on touch).
- Tab swaps in nav (instant).
- Filter chips (instant).
- Page transitions (no router transitions — they fight the back-swipe gesture on iOS).
- Numbers ticking up (parchment is calm; ticker animations are casino).
- The video field. Ever.

`prefers-reduced-motion` is already globally honored (`index.css:471-480`). Don't add per-component guards.

## 7. Don't-do list (specific patterns the codebase has flirted with)

1. **Cream-on-dark surface fills.** Pre-iter-356.57 the danger/warning tints used `color-mix(... 10%, transparent)` — invisible on charred oak. The fix at `index.css:104-119` raises them to 18–28%. Don't lower them again "for subtlety"; that was the bug.
2. **Blue focus rings.** Eliminated. `index.css:217` mandates `--color-accent-default` (ember) for every focus ring. CLAUDE.md pins `text-blue-XXX` as banned. Don't reintroduce — not even on form inputs.
3. **Glassmorphism on `--color-surface`.** Allowed only on the video field (real photographic backdrop). Anywhere else, blur on a flat den-colored panel reads as smudge.
4. **Gradients without intent.** The Live bottom-edge gradient (`Live.tsx:167`) is the ONE gradient on mobile — it solves a real legibility problem (white text on variable video pixels). Don't add gradient borders to cards, gradient fills to buttons, or gradient text. Parchment is solid.
5. **Pasted-on cats.** Mascots on every card was the iter-356.22 mistake Maya flagged. Cats live in: Login (trio), CatLayer (ambient), CatEmptyState (mood-driven), sentry headline (rotating one). Nowhere else.
6. **Neon greens.** `--color-success` is `#4ade80` (emerald-400 glow) — bright but warmed by the bg context. Don't introduce additional greens. No `text-green-500`, no `bg-emerald-300`.
7. **Token leaks via raw hex.** Every component file outside `index.css` should reference `var(--color-*)` only. CI would catch this; reviewer eyeballs should too.
8. **Tailwind v4 var syntax.** `bg-[var(--color-x)]`, never `bg-[--color-x]`. `Events.tsx` and `Settings.tsx` are clean; preserve that on every new line.
9. **Manifest cream / status-bar mismatch.** `vite.config.ts:51-52` cream values must flip to `#1e1710` (manifest = page bg) while `index.html:28-29` `#e8d4ac` stays (status bar = warmer than page so the chrome doesn't disappear). Two surfaces, two rules.
10. **Hardcoded sentry name.** `Live.tsx:333` says "Panther's off duty." Replace with `sentryOffDutyLabel(useSentryCat())` when the rotation wires up. Hardcoded strings will silently contradict the active sentry within 30 minutes of any session.
11. **`text-xs` for instructional copy.** `CatEmptyState.tsx:114` uses `text-sm`. Hold that floor. 11 px is for chips/badges only.
12. **Decorative borders shouting "selected."** Don't apply `--color-accent-default` as a 1 px border on neutral chrome — every user reads it as "this row is currently selected." Accent-as-border is reserved for *actual* selected states.

---

## Executive summary

The iter-356.57 "Watchpost at Dusk" token system in `client/src/index.css` is the right foundation — dark warm-charred-oak page bg, parchment text, ember accent, brass scarce sigil, leather-stitch borders, two elevation tiers — and it's already wired through `Live.tsx`, `Events.tsx`, `Settings.tsx`, `CatEmptyState.tsx`. What this brief pins down is *which token goes where* on a 360–430-px viewport so future PRs don't drift back toward generic-SaaS treatments: serif (Fraunces) on h1/h2/wordmark only, Inter on everything else, two elevation tiers (`--color-bg` + `.card-paper`), brass strictly scarce, mascots at one-cat-on-screen with the sentry rotation driving the headline, motion limited to six named cases (modal entry, pull-to-refresh, sentry flip, CatLayer walk, toast, paw-spinner) and nothing else. Three concrete fixes the implementer should land alongside the redesign: `vite.config.ts:51-52` PWA manifest still ships the dropped cream `#faf6ee` (must flip to `#1e1710`), `Live.tsx:333` hardcodes "Panther's off duty" instead of calling `sentryOffDutyLabel` from the new rotation lib, and the face-match success-vs-accent chip pair on `Events.tsx:1175-1176` need a `ring-2` weight bump to read at thumb distance. Everything else in this brief codifies what the tokens already say but the codebase hasn't yet promised in writing — the don't-do list (#1–#12) is the load-bearing artifact for the next 50 component PRs.
