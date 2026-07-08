**Fresh-Eyes UI/UX Critique**

Scope read: `client/src` pages and shared UI. Note: there is no current `Live.tsx`; the app routes `/` to `Watch` and redirects `/live` there in [App.tsx](/media/israel/Drive/Projects/Android/HomeCameraSystem/client/src/App.tsx:23).

1. **Critical: Home/Watch has three competing status systems on one camera surface.**  
   [Watch.tsx](/media/israel/Drive/Projects/Android/HomeCameraSystem/client/src/pages/Watch.tsx:425) overlays camera name/status, [VideoTile.tsx](/media/israel/Drive/Projects/Android/HomeCameraSystem/client/src/components/VideoTile.tsx:654) adds a connection pill, [Watch.tsx](/media/israel/Drive/Projects/Android/HomeCameraSystem/client/src/pages/Watch.tsx:505) adds “Watching/Paused” glance cards, and fullscreen adds another rail/scrubber in [Watch.tsx](/media/israel/Drive/Projects/Android/HomeCameraSystem/client/src/pages/Watch.tsx:466). This reads patched, not premium.  
   **Fix:** make the video overlay the single live-state source: top-left `Live · Front Door`, bottom-right controls only. Move “Watching/Paused/Offline” into one compact status card below, and remove duplicated state language from fullscreen except critical errors.

2. **Critical: landscape Home is functional but visually split-brain.**  
   The landscape layout hard-switches to `58%_1fr` in [Watch.tsx](/media/israel/Drive/Projects/Android/HomeCameraSystem/client/src/pages/Watch.tsx:302), with the tiny “Home” header spanning both columns in [Watch.tsx](/media/israel/Drive/Projects/Android/HomeCameraSystem/client/src/pages/Watch.tsx:312). The result is a camera pane plus a cramped utility column, not an intentional landscape product view.  
   **Fix:** in landscape phone, drop the visible “Home” header entirely, let video occupy left 62-65%, and make the right pane a dense “Today” stack with one status row, then timeline. Brand can live in the left rail or video scrim, not a top strip.

3. **Critical: Events has no visible page title and opens as a control strip.**  
   The visible “Watch log” label was removed and only an `sr-only` h1 remains in [Events.tsx](/media/israel/Drive/Projects/Android/HomeCameraSystem/client/src/pages/Events.tsx:980). Sighted users land on “Showing the last N”, Select, calendar, filters, then “Today’s log” later. It feels like a missing header, not minimalist.  
   **Fix:** add a compact visible header: `Events` plus a secondary line like `Recent motion and clips`. Keep it 40-48px tall, not a hero.

4. **High: navigation IA is inconsistent across orientations.**  
   Portrait BottomNav has four visible tabs and hides Review except landscape in [BottomNav.tsx](/media/israel/Drive/Projects/Android/HomeCameraSystem/client/src/components/BottomNav.tsx:28), while desktop SideRail always has five in [SideRail.tsx](/media/israel/Drive/Projects/Android/HomeCameraSystem/client/src/components/SideRail.tsx:54). Users rotating the same phone should not see a new primary destination appear.  
   **Fix:** either include Review consistently as a fifth item with shorter labels/icons, or keep it inside Faces everywhere. Orientation should change layout, not IA.

5. **High: BottomNav landscape rail feels like a workaround, not a designed nav.**  
   The same bottom nav component becomes a left rail via a dense class pile in [BottomNav.tsx](/media/israel/Drive/Projects/Android/HomeCameraSystem/client/src/components/BottomNav.tsx:79), with `text-[9px]` labels in [BottomNav.tsx](/media/israel/Drive/Projects/Android/HomeCameraSystem/client/src/components/BottomNav.tsx:123). That is very “CSS rescue.”  
   **Fix:** create a dedicated `MobileLandscapeRail` component: icon-only, 56-64px wide, long-press/title tooltip, no 9px labels. Keep labels in portrait only.

6. **High: Events row density is overloaded on phones.**  
   Each row includes a time column, axis dot, WhoMark, thumbnail, confidence pill, play pill, title, relative time, face chips, and delete affordance across [EventList.tsx](/media/israel/Drive/Projects/Android/HomeCameraSystem/client/src/components/EventList.tsx:196) and [EventList.tsx](/media/israel/Drive/Projects/Android/HomeCameraSystem/client/src/components/EventList.tsx:518). It is information-rich but visually noisy.  
   **Fix:** mobile rows should choose two anchors: thumbnail + title/time. Move confidence and identity chips into the detail modal or a second-line expandable state. Keep the timeline axis only on wider layouts.

7. **High: Settings looks quieter than before, but still reads as nested admin UI.**  
   The desktop layout adds a 48-wide section rail in [Settings.tsx](/media/israel/Drive/Projects/Android/HomeCameraSystem/client/src/pages/Settings.tsx:317), then card sections via [parts.tsx](/media/israel/Drive/Projects/Android/HomeCameraSystem/client/src/pages/settings/parts.tsx:62). The problem is hierarchy: every section card has similar weight, so “Alerts” and dangerous maintenance can feel equally important.  
   **Fix:** add section-level priority: top “Alerts” or “Watching” summary card, then grouped secondary panels. Danger/System rows should be visually quarantined with more spacing and a muted heading, not just another card.

8. **Medium: typography rhythm is inconsistent and sometimes arbitrary.**  
   The theme declares a tight scale in [index.css](/media/israel/Drive/Projects/Android/HomeCameraSystem/client/src/index.css:199), but components use one-off values like `text-[12.5px]` in [Watch.tsx](/media/israel/Drive/Projects/Android/HomeCameraSystem/client/src/pages/Watch.tsx:519), `text-[13.5px]` in [EventRow.tsx](/media/israel/Drive/Projects/Android/HomeCameraSystem/client/src/components/EventRow.tsx:40), and `text-[9px]` in [BottomNav.tsx](/media/israel/Drive/Projects/Android/HomeCameraSystem/client/src/components/BottomNav.tsx:125). That reads amateur in polish passes.  
   **Fix:** add tokens for `--text-caption`, `--text-row-title`, `--text-nav-compact` if needed, then use them consistently. No fractional ad hoc sizes in product UI.

9. **Medium: the display font utility contradicts the stated Playroom Modern rules.**  
   `.font-display` applies negative letter spacing in [index.css](/media/israel/Drive/Projects/Android/HomeCameraSystem/client/src/index.css:366). The owner’s grammar says Bricolage display, but the actual utility tightens all display text globally, which can look cramped and homemade at small sizes like landscape “Home” in [Watch.tsx](/media/israel/Drive/Projects/Android/HomeCameraSystem/client/src/pages/Watch.tsx:313).  
   **Fix:** set display letter spacing to `0`; if large wordmarks need optical tightening, apply a separate `brand-title` class only there.

10. **Medium: Login is polished but too card-bound for a first impression.**  
   The login uses a centered card in [Login.tsx](/media/israel/Drive/Projects/Android/HomeCameraSystem/client/src/pages/Login.tsx:123) and p-10 max-w-sm form in [Login.tsx](/media/israel/Drive/Projects/Android/HomeCameraSystem/client/src/pages/Login.tsx:138). It is clean, but generic auth SaaS. The cat identity is small relative to the page.  
   **Fix:** keep the form compact, but make the brand first-viewport signal larger: bigger cat trio, `HomeCam` as the page anchor, form below with less card padding on landscape. Add a subtle full-width brand band or image-backed top area using the existing cat assets.

11. **Medium: ClipModal is powerful but too much of a split-pane command center on mobile.**  
   The modal stacks video, action buttons, and an evidence pane in [ClipModal.tsx](/media/israel/Drive/Projects/Android/HomeCameraSystem/client/src/components/ClipModal.tsx:822), with action row wrap in [ClipModal.tsx](/media/israel/Drive/Projects/Android/HomeCameraSystem/client/src/components/ClipModal.tsx:952) and evidence aside in [ClipModal.tsx](/media/israel/Drive/Projects/Android/HomeCameraSystem/client/src/components/ClipModal.tsx:1013). On a phone it will feel long and procedural.  
   **Fix:** mobile modal should be video-first: title overlay, player, one primary action row, then a collapsed “Details” drawer. Keep the desktop split pane.

12. **Medium: browser-default controls leak through.**  
   Native `input type="time"` appears in Events day filtering [Events.tsx](/media/israel/Drive/Projects/Android/HomeCameraSystem/client/src/pages/Events.tsx:1283) and settings [parts.tsx](/media/israel/Drive/Projects/Android/HomeCameraSystem/client/src/pages/settings/parts.tsx:190). This is pragmatic, but it visually breaks the pill/1.5px grammar, especially across iOS/Android.  
   **Fix:** wrap native time inputs in a custom pill shell with icon, label, and consistent height. Keep the native input invisible or visually normalized enough that platform chrome does not dominate.

13. **Low: Cat brand identity is simultaneously underused and over-engineered.**  
   `CatLayer` is huge, animated, personality-rich, but currently unmounted per [App.tsx](/media/israel/Drive/Projects/Android/HomeCameraSystem/client/src/App.tsx:334). Meanwhile the visible brand is mostly tiny face chips in [WhoMark.tsx](/media/israel/Drive/Projects/Android/HomeCameraSystem/client/src/components/WhoMark.tsx:65).  
   **Fix:** do not resurrect ambient cats over content. Instead use brand deliberately: one strong cat trio mark in headers/login/empty states, no random mascot layer unless there is actual floor space.

14. **Low: comments reveal design churn and the UI reflects it.**  
   Many components carry long histories of “fix” comments, and the rendered result has the same feeling: lots of edge-case corrections, not enough final editorial restraint. Examples: [App.tsx](/media/israel/Drive/Projects/Android/HomeCameraSystem/client/src/App.tsx:167), [Watch.tsx](/media/israel/Drive/Projects/Android/HomeCameraSystem/client/src/pages/Watch.tsx:361), [BottomNav.tsx](/media/israel/Drive/Projects/Android/HomeCameraSystem/client/src/components/BottomNav.tsx:61).  
   **Fix:** after functional fixes, run a visual simplification pass: remove duplicate chips, reduce one-off classes, collapse control variants, and write a short visual contract for nav, cards, video overlays, and list rows.

**Bottom line:** the app is far past “default React/Tailwind,” but it is not yet effortlessly professional. The main issue is not lack of styling; it is excess local styling. The best next pass is subtraction: one status model, one navigation IA, one row density model per viewport, and fewer one-off type/control exceptions.
