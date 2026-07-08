# Live device run-through — SM-S928U1 (Android 16, Firefox), 2026-07-07

Real phone against https://homecam.tail4a6525.ts.net, portrait + landscape. Jetson live, stream playing.

## Portrait (Home)

1. **Last event row hidden behind pebble nav.** "Today at home" list's final visible row renders behind the floating BottomNav (saw "Not recognized · 3m ago" clipped). Scroll container needs bottom padding ≥ nav height + safe-area, or a fade mask.
2. **Storage alert clipped behind nav** on Settings too ("Storage is almost full" peeking from under nav). Same clearance bug, second page — systemic, fix at layout level not per page.
3. **Live tile control cluster (Show-boxes / Snapshot / Fullscreen) floats mid-video**, covering the picture at the vertical center-right. Feels non-professional; controls should hug the bottom edge of the tile.
4. **"Watching / Mushu is on watch · alerts on" card vs "50 today" card**: cream fill vs dark outline = unclear which is stateful/tappable.

## Landscape (all pages)

5. **Side rail nav appears — good — but the rail's last item (Settings) label is clipped** at the container's bottom rounded border. Rail doesn't fit 5 items on 1080px-tall landscape; needs tighter item spacing or scrollable rail.
6. **Nav parity mismatch: portrait bottom nav shows 4 tabs (Home/Events/Faces/Settings), landscape rail shows 5 (incl. Review).** Review exists in portrait? If hidden, that's disorienting on rotate.
7. **Events landscape: filters (TYPE, WHO) stack vertically and consume the whole first viewport; zero events visible above fold; the entire right half of the screen is empty.** Filters should go inline in one row (or move to the right column) in landscape/wide.
8. **Events header row ("Showing the last 100 / Select / calendar") floats far right with a huge empty gap** to the left — reads unanchored.
9. **Faces empty state in landscape: giant mascot sprite centered, headline at very bottom edge, CTA below the fold.** Empty-state should scale illustration down in short viewports (landscape-phone) so headline + CTA fit.
10. **Review empty state: mascot sprite clips under the sticky "On watch" ribbon.** Content top padding doesn't account for ribbon height in landscape.
11. **Settings landscape theme row ("Match device / Sunroom / Lights off") spreads three buttons across the full 2900px content width** — comically stretched. Cap the control group width.

## Copy / making-sense (Frank-adjacent, seen live)

12. **"The box in the closet"** as the Settings system-health section header — cute but opaque. Needs a plain subtitle or rename ("System health").
13. **Three different words for live state at once** (ribbon "On watch", card "Watching", tile "Live") — confirmed visible simultaneously on one screen in landscape Home.
14. **"50 today / 50 person sightings · 0 cat sightings"** — number repeated twice in same card.

## Positive (keep)

- Landscape rail + two-column Home layout already exists and reads well structurally.
- Live stream starts fast; ribbon status is clear; dark theme consistent, no white flashes seen on nav.
- Events hour-by-hour heatmap reads well full-width in landscape.
