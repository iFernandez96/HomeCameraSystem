---
name: Cat mascot spec — iter-356.31
description: Per-cat per-pose mascot spec (Panther / Mushu / Coco × 7 poses) translated into the CatIcons.tsx mascot rewrite.
type: project
---

iter-356.31 mascot spec. Source of truth for the high-detail SVG cats in `client/src/components/CatIcons.tsx`. Replaces the iter-356.4 pixel-art era. No Figma file referenced (not in the repo); spec is authored here.

**Why:** iter-356.27 + iter-356.30 left the cats as 16/24-px pixel sprites that read as "small colored smears" at the 36-72-px display sizes the CatLayer ships. User mandate (this iter): polished, high-detail mascot characters, rounded organic shapes, no pixel grid, no `crispEdges`, no copyrighted style, no emoji as primary expression. Smallest path = inline-SVG components (Option A).

**How to apply:** when adding or modifying cat poses, follow the per-pose anatomy + per-cat coat rules below. Tests in `CatIcons.test.tsx` pin the public API; internal art may evolve.

## Per-cat coat

| Cat     | Body fill          | Belly / chest          | Accent (markings / patches) | Eye color    | Nose       | Personality cue (posture)                              |
| ------- | ------------------ | ---------------------- | --------------------------- | ------------ | ---------- | ------------------------------------------------------ |
| Panther | `#0e0c0a` (Bombay) | `#1a1410` shadow tone  | none (solid)                | `#fde047`    | `#1a1410`  | tall back, ears up + tipped back, half-lidded eyes     |
| Mushu   | `#0e0c0a` (top)    | `#f7f3eb` (white bib)  | bib + 4 white socks + tail tip | `#fde047` | `#fda4af`  | bouncy, alert, ears forward, mouth slightly open       |
| Coco    | `#f7f3eb` (white)  | `#f7f3eb`              | calico orange `#d97706` + black `#1a1410` patches (3-tone) | `#86efac` | `#fda4af` | softer curves, tail loosely curled, eyes more closed   |

## Per-pose anatomy (sprite viewBox `0 0 96 64`, ground = `y=58`)

| Pose      | Body silhouette                                                               | Head           | Eyes          | Tail              | Legs                                  |
| --------- | ----------------------------------------------------------------------------- | -------------- | ------------- | ----------------- | ------------------------------------- |
| `walk`    | low oblong, slight back curve                                                  | up + forward  | open          | low S-curl back  | front-right + back-left forward       |
| `walk2`   | same body; alternated leg phase                                                 | same          | same          | tip slightly up  | front-left + back-right forward       |
| `sit`     | upright haunches, chest forward                                                 | level          | open          | curled around hip| front legs vertical, hind tucked      |
| `sit2`    | same; tail tip flicks 1.5 units higher                                          | same          | same          | tip up           | same                                  |
| `sleep`   | full curl into circle                                                            | tucked into tail| closed line | wraps around body| tucked under                          |
| `hiss`    | deeply arched back, fur spikes along spine, puffed tail                         | low + forward | wide pupils  | straight up + bushy| stiff-legged                         |
| `groom`   | sitting, front paw raised to face                                               | tilted down  | half-closed   | curled at side   | front paw lifted to face             |
| `stretch` | long elongated body, butt up, paws extended forward                             | low + tucked  | half-closed   | level back       | back legs angled, fronts extended    |
| `play`    | front low + back up (play bow), tail high                                       | high + alert | wide          | swooshed up      | front paws low, back paws planted    |

## Face-icon anatomy (viewBox `0 0 64 64`)

Front-facing head + chest only. Used in `CatTrioMark`. Each cat:

- Outer head silhouette: rounded shape with two pointed ears at top.
- Inner ear pink (`#fda4af`) at 0.5 opacity for warmth.
- Eyes: large rounded almonds with vertical-slit pupils for personality. Panther = half-lidded judgey; Mushu = wide round playful; Coco = soft, slightly closed sleepy.
- Whiskers: 3 strands per side, very thin (`stroke-width=0.6`), low opacity (0.6).
- Nose + mouth-Y: a small heart-shape nose then two soft curve segments.
- For Mushu: white muzzle band across the lower face + white chest "V."
- For Coco: orange forehead patch on one side, black patch on the other (asymmetric calico).

## Acceptance gates

- 48 px: silhouette identifies the cat (Panther = solid black, Mushu = black-with-white-bib, Coco = tri-color).
- 64 px: face detail readable; eye color visible.
- 96 px: each cat reads as a polished mascot — no pixel grid, no jagged edges, soft shadows present.
- All 7 poses look posturally distinct.
- Reduced-motion still respected (no per-pose animation introduced).
- Existing CatLayer behavior unaltered.

## What I did NOT use

- Figma MCP (no relevant Figma file in repo — confirmed via grep across `memory/`, `HANDOFF.md`, `CLAUDE.md`).
- Rive runtime (~100 KB JS overhead; overkill for static poses).
- SVG sprite sheet (per-cat palette injection awkward, build pipeline change).
- `shape-rendering="crispEdges"` (mascot art needs anti-aliasing; PawMark glyph kept it).
- Emoji as primary expression (kept for CatLayer mood bubbles only — separate concern).
- Anything resembling Animal Crossing / Neko Atsume / Pusheen / Nintendo characters.
