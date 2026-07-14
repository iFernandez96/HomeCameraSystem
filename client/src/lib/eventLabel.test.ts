/**
 * iter-357 (multi-person face-recog) tests for eventTitle +
 * recognizedNames. Pre-iter-357 these helpers were exercised
 * implicitly via EventList/ClipModal tests; the multi-person
 * branches need direct coverage so a future refactor of the title
 * format gets caught at the unit level rather than via a fragile
 * "the card says 'Israel at the front door'" string match three
 * components deep.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  eventTitle,
  humanCameraName,
  recognizedNames,
  registerCameraNames,
} from './eventLabel'
import type { DetectionEvent } from './types'

function makeEvent(over: Partial<DetectionEvent> = {}): DetectionEvent {
  return {
    v: 1,
    type: 'detection',
    id: 'evt-1',
    ts: 1_700_000_000,
    camera_id: 'cam1',
    label: 'person',
    score: 0.91,
    boxes: [],
    ...over,
  }
}

describe('eventTitle', () => {
  it('Given an event with no face match, When title is built, Then it falls back to the capitalized label at the camera', () => {
    // arrange
    const e = makeEvent({ label: 'dog' })

    // act
    const title = eventTitle(e)

    // assert
    expect(title).toBe('Dog at the front door')
  })

  it('Given an event with a single recognized name (legacy person_name only), When title is built, Then it reads "Name at the front door"', () => {
    // arrange — legacy single-person event from a pre-iter-357
    // worker. Sentinel: title format unchanged so the iter-22
    // wire-shape contract holds.
    const e = makeEvent({ person_name: 'israel' })

    // act
    const title = eventTitle(e)

    // assert
    expect(title).toBe('Israel at the front door')
  })

  it('Given an event with a single name in person_names list (no legacy field), When title is built, Then it still reads "Name at the front door"', () => {
    // arrange — server invariant guarantees person_name is set
    // when person_names is, but the helper must not crash if a
    // pathological server skips the derive path.
    const e = makeEvent({ person_names: ['israel'] })

    // act
    const title = eventTitle(e)

    // assert
    expect(title).toBe('Israel at the front door')
  })

  it('Given two recognized names, When title is built, Then it reads "Name1 & Name2 at the front door" (ampersand, no comma)', () => {
    // arrange — iter-357: two-person event. Ampersand reads like a
    // household sentence, not a CSV row.
    const e = makeEvent({
      person_name: 'israel',
      person_names: ['israel', 'sheenal'],
    })

    // act
    const title = eventTitle(e)

    // assert
    expect(title).toBe('Israel & Sheenal at the front door')
  })

  it('Given three recognized names, When title is built, Then it reads "Name1, Name2 & Name3 at the front door" (Oxford-style)', () => {
    // arrange
    const e = makeEvent({
      person_name: 'israel',
      person_names: ['israel', 'sheenal', 'coco'],
    })

    // act
    const title = eventTitle(e)

    // assert
    expect(title).toBe('Israel, Sheenal & Coco at the front door')
  })

  it('Given four-plus recognized names, When title is built, Then it reads "Name1, Name2 & N others" (caps title length to two names + count)', () => {
    // arrange
    const e = makeEvent({
      person_name: 'israel',
      person_names: ['israel', 'sheenal', 'coco', 'mushu'],
    })

    // act
    const title = eventTitle(e)

    // assert
    expect(title).toBe('Israel, Sheenal & 2 others at the front door')
  })

  it('Given five-plus recognized names, When title is built, Then "N others" reflects the actual remaining count', () => {
    // arrange
    const e = makeEvent({
      person_name: 'israel',
      person_names: ['israel', 'sheenal', 'coco', 'mushu', 'panther'],
    })

    // act
    const title = eventTitle(e)

    // assert
    expect(title).toBe('Israel, Sheenal & 3 others at the front door')
  })

  it('Given an event with empty person_names list and no person_name, When title is built, Then it falls back to the label branch (defensive)', () => {
    // arrange — pathological wire shape (server invariant
    // guarantees this won't happen, but the helper must not crash).
    const e = makeEvent({ person_names: [] })

    // act
    const title = eventTitle(e)

    // assert — falls through to label branch.
    expect(title).toBe('Person at the front door')
  })

  it('Given a delivered package event, When title is built, Then package state is human-readable', () => {
    expect(
      eventTitle(
        makeEvent({
          source: 'vision',
          label: 'object_change',
          package_state: 'delivered',
        }),
      ),
    ).toBe('Package delivered at the front door')
  })

  it('Given an audio event, When title is built, Then snake-case detector labels read as a sound', () => {
    expect(
      eventTitle(makeEvent({ source: 'audio', label: 'glass_break' })),
    ).toBe('Glass break sound at the front door')
  })
})

describe('recognizedNames', () => {
  it('Given no person fields, When called, Then returns an empty array', () => {
    // arrange / act
    const out = recognizedNames(makeEvent())

    // assert
    expect(out).toEqual([])
  })

  it('Given only the legacy person_name field, When called, Then returns a single-element array', () => {
    // arrange / act
    const out = recognizedNames(makeEvent({ person_name: 'israel' }))

    // assert
    expect(out).toEqual(['israel'])
  })

  it('Given the new person_names list, When called, Then returns it verbatim (no dedup, no reorder — server invariant)', () => {
    // arrange / act — the server-side Pydantic validator already
    // pinned the invariants (person_names[0] === person_name when
    // both set; per-item bounds; case-insensitive dedup). The
    // helper trusts the wire and just returns the list as-is.
    const names = ['israel', 'sheenal', 'coco']
    const out = recognizedNames(makeEvent({ person_name: 'israel', person_names: names }))

    // assert
    expect(out).toEqual(names)
  })

  it('Given an empty person_names list and a legacy person_name, When called, Then falls back to the legacy field (defensive)', () => {
    // arrange — pathological wire shape: server promises
    // person_names is null when empty, but helper handles []
    // defensively in case a future server returns it.
    const out = recognizedNames(
      makeEvent({ person_name: 'israel', person_names: [] }),
    )

    // assert
    expect(out).toEqual(['israel'])
  })

  it('Given a null person_names value, When called, Then falls back to the legacy field', () => {
    // arrange / act
    const out = recognizedNames(
      makeEvent({ person_name: 'israel', person_names: null }),
    )

    // assert
    expect(out).toEqual(['israel'])
  })
})

// Multicam contract (docs/multicam_contract.md, 2026-07-07): registry-
// driven camera display names. Single-camera copy must stay byte-
// identical; only a >1-camera registry changes what rows say.
describe('humanCameraName + registerCameraNames', () => {
  afterEach(() => {
    // The registry is module-level state — reset so tests stay
    // order-independent.
    registerCameraNames([])
  })

  it('Given no registered cameras, When translating the default ids, Then both cam1 (legacy) and front_door (registry default) read "the front door"', () => {
    // arrange — nothing registered (single-camera deploy)
    // act / assert
    expect(humanCameraName('cam1')).toBe('the front door')
    expect(humanCameraName('front_door')).toBe('the front door')
  })

  it('Given no registered cameras, When translating an unknown id, Then the raw id passes through', () => {
    // arrange / act / assert
    expect(humanCameraName('garage')).toBe('garage')
  })

  it('Given a multi-camera registry, When translating a registered id, Then the display name wins', () => {
    // arrange
    registerCameraNames([
      { id: 'front_door', name: 'Front Door' },
      { id: 'back_yard', name: 'Back Yard' },
    ])

    // act / assert
    expect(humanCameraName('back_yard')).toBe('Back Yard')
    expect(humanCameraName('front_door')).toBe('Front Door')
    // Unregistered ids still pass through raw.
    expect(humanCameraName('mystery')).toBe('mystery')
  })

  it('Given a SINGLE-camera registry, When registered, Then the map stays empty so single-camera copy is unchanged (acceptance bar)', () => {
    // arrange — one camera: registerCameraNames must self-gate.
    registerCameraNames([{ id: 'front_door', name: 'Porch Cam' }])

    // act / assert — still the pre-multicam friendly default, NOT
    // the registry name.
    expect(humanCameraName('front_door')).toBe('the front door')
  })

  it('Given a multi-camera registry, When eventTitle is built, Then the row reads "Name at <camera display name>"', () => {
    // arrange
    registerCameraNames([
      { id: 'front_door', name: 'Front Door' },
      { id: 'back_yard', name: 'Back Yard' },
    ])
    const e = makeEvent({ camera_id: 'back_yard', person_name: 'israel' })

    // act / assert
    expect(eventTitle(e)).toBe('Israel at Back Yard')
  })
})
