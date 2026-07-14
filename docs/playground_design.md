# Playground page — design (2026-07-11)

A rich interactive cat playground at `/playground`: Neko Atsume-style autonomous
yard + four user verbs (laser, yarn toss, treat drop, petting). Three cats keep
their established personalities. Assets are codex-generated 512px chroma-green
masters exported to `client/public/cats/playground/`.

## Architecture (approved blueprint)

Fork the state machine, share the data + render primitives:

- Shared as-is: `catAnimSequences.ts`, `catMoodBadges.ts`, `CatParticles.tsx`.
- Extracted shared modules (re-exported from CatLayer so its tests stay green):
  `catEngineCore.ts` (transition tables, frameFromSteps/transitionFrame/
  uniqueFrames, generalized animationPlanFor, rand/weighted-roll/anti-repeat),
  `catPerfGates.ts` (reduced-motion/data/battery hooks), `catImageCache.ts`
  (URL-keyed preload cache).
- Playground-only (all under `src/playground/`, lazy-loaded chunk):
  `PlaygroundScene.tsx` (rAF owner + pointer input via refs), `sceneModel.ts`
  (anchors/layout, pure), `playgroundState.ts` (types), `stepPlayground.ts`
  (single step fn, CatLayer bail-out discipline), `catBrain.beats.ts` +
  `catBrain.verbs.ts` (pre-split so slices B/C don't collide), `toyPhysics.ts`
  (pure), `playgroundAssets.ts` (URL manifest, 2 preload waves),
  `playgroundSequences.ts` (bat_bout/eat_bout/purr_hold), `PlaygroundCat.tsx`,
  `PlaygroundProps.tsx`.
- DOM structure per cat copies CatLayer's nested wrappers VERBATIM in spirit:
  entrance animation on its own wrapper (filled CSS animations override inline
  transforms forever — the Panther-mirror bug), flip div separate, bob div
  separate, no CSS transition on per-frame transforms.

Build order: A extraction+scaffolding (alone) → B autonomous yard ∥ C toys+verbs
→ D polish/perf. B owns `catBrain.beats.ts`, C owns `catBrain.verbs.ts`.

## Research addendum (103-agent deep research, all claims verified)

1. **Shimeji two-layer model** (validates our design): actions table = WHAT
   (sprite sequences), per-cat behaviors table = WHEN (weights/conditions).
   All cats share one action set; personality lives ONLY in the weights.
2. **Verticality is the #1 catification rule** (Jackson Galaxy): cats own
   territory floor-to-ceiling. Upgrade the layout from 2 depth lanes to
   **3 vertical tiers**: floor (rug, bowls, tunnel, litter, cozy nook),
   mid (cat tree platforms, hammock), high (**shelf superhighway** — the
   wall_shelf_set forms a traversable elevated route with on/off ramps via
   the tree, and rest-stop cushions; multiple cats can occupy different
   shelves without colliding).
3. **Personality-to-zone mapping** (Galaxy's dweller taxonomy):
   - Panther = **Tree Dweller**: home zone is the high shelves/tree top;
     judges from altitude.
   - Coco = **Bush Dweller**: low semi-concealed spots; the tunnel and a
     cozy nook are HER territory; naps there by default.
   - Mushu = **Beach Dweller**: open floor, near the toys, first responder.
4. **Window = "Cat TV"**: pair the window perch with the bird feeder; birds
   visiting the feeder are a destination event — cats travel to the perch to
   watch, chatter (fast tailflick), tail-twitch.
5. **Game feel (Swink)**: the TOY layer must respond instantly and
   deterministically (laser dot, wand tip, yarn impulse, pet ripple — zero
   latency, zero randomness). The charm-randomness lives ONLY in the cat's
   DECISION to engage (delays, ignores, personality rolls). Never randomize
   the input→toy mapping.
6. **Stylized > realistic** (Little Kitty Big City): limited expression set
   reads MORE authentic than realism. Our mood-badge + pose system is the
   right grain; don't chase micro-realism.
7. **Emotional contract**: no failure, no punishment, no time pressure, no
   currencies, no collection meters, no wait-timers (KleptoCats' punish-timer
   is the canonical anti-pattern; Neko Atsume's health comes from optional
   discovery, not obligation). Discovery = catching cats doing rare beats
   (pooped, tunnel dive, bird chatter), never a checklist UI.
8. **Small cheap affection verbs carry charm** (KleptoCats): petting and
   treats are high-affection, low-cost — polish those first among verbs.

## Verb/personality matrix (from blueprint, tuned by research)

| Stimulus | Mushu (Beach) | Panther (Tree) | Coco (Bush) |
|---|---|---|---|
| Laser | reacts ~300ms, chase/pounce loop | 40% ignore-with-judge; else delayed chase, then SITS ON the dot 5s | sleeps through unless dot passes <60px twice → slow bat, gives up |
| Yarn | first responder, bat bouts | joins only in her zone, 1-2 dignified bats | watches with tailflick; bats if it rests beside her |
| Treat | runs to it | walks, waits if crowded | ALWAYS wakes (her only high-energy trigger) |
| Pet (hold) | purr immediately + hearts | tolerates ~2s, then grump + walk-off, 8s cooldown | purr + max hearts, extends nap |

Petting always preempts other stimuli (direct touch); otherwise a cat commits
to one focus target for the beat duration.

## Perf & gates

Single rAF loop, dt clamp 33ms, same-ref bail-out, memo everything, pointer
input via refs (no render per pointermove), entity caps (1 yarn, 3 treats,
1 ambient), 2-wave lazy preload inside the chunk, reduced-motion/data/battery
→ static diorama. Target 60fps mid-range phone.
