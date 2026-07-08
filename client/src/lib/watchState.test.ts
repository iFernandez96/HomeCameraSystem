import { describe, expect, it } from 'vitest'
import {
  WATCH_STATE_LABEL,
  watchStateDotClass,
  watchStateOf,
  watchStateTextClass,
  type WatchStateKind,
} from './watchState'

const ALL_KINDS: WatchStateKind[] = [
  'offline',
  'armed',
  'reconnecting',
  'off-duty',
  'checking',
]

describe('watchStateOf — shared armed-state vocabulary (overhaul W1 item 2)', () => {
  it('Given status confirms the worker is dead, When classified, Then it is offline regardless of video', () => {
    // arrange
    const input = {
      statusKnown: true,
      workerAlive: false,
      detectionActive: true,
      videoPlaying: true,
    }
    // act
    const kind = watchStateOf(input)
    // assert — status-confirmed-down always wins (status-truth fix).
    expect(kind).toBe('offline')
  })

  it('Given a healthy armed worker, When classified, Then it is armed', () => {
    // arrange / act
    const kind = watchStateOf({
      statusKnown: true,
      workerAlive: true,
      detectionActive: true,
    })
    // assert
    expect(kind).toBe('armed')
  })

  it('Given the status API is unreachable but video confirms frames, When classified, Then it is the low-alarm reconnecting state', () => {
    // arrange / act
    const kind = watchStateOf({
      statusKnown: false,
      workerAlive: null,
      detectionActive: null,
      videoPlaying: true,
    })
    // assert
    expect(kind).toBe('reconnecting')
  })

  it('Given the status API is unreachable and video confirms the WHEP path is dead, When classified, Then both channels dark means offline', () => {
    // arrange / act
    const kind = watchStateOf({
      statusKnown: false,
      workerAlive: null,
      detectionActive: null,
      videoPlaying: false,
    })
    // assert
    expect(kind).toBe('offline')
  })

  it('Given the status API is unreachable and video has not resolved, When classified, Then it stays neutral checking (cold-mount guard: never flash danger)', () => {
    // arrange / act
    const kind = watchStateOf({
      statusKnown: false,
      workerAlive: null,
      detectionActive: null,
    })
    // assert
    expect(kind).toBe('checking')
  })

  it('Given detection is switched off with a live worker, When classified, Then it is off-duty', () => {
    // arrange / act
    const kind = watchStateOf({
      statusKnown: true,
      workerAlive: true,
      detectionActive: false,
    })
    // assert
    expect(kind).toBe('off-duty')
  })

  it('Given status is loaded but detection_active is still null, When classified, Then it is checking', () => {
    // arrange / act
    const kind = watchStateOf({
      statusKnown: true,
      workerAlive: true,
      detectionActive: null,
    })
    // assert
    expect(kind).toBe('checking')
  })
})

describe('watch state maps — one word / one color per state', () => {
  it('Given every state kind, When labels are read, Then each has the single canonical user-facing name', () => {
    // arrange / act / assert
    expect(WATCH_STATE_LABEL).toEqual({
      offline: 'Camera offline',
      armed: 'On watch',
      reconnecting: 'Reconnecting…',
      'off-duty': 'Off duty',
      checking: 'Checking…',
    })
  })

  it('Given every state kind, When dot and text classes are read, Then each resolves to a non-empty tokenized class (no raw palette classes)', () => {
    // arrange / act / assert
    for (const kind of ALL_KINDS) {
      expect(watchStateDotClass(kind)).toMatch(/var\(--color-/)
      expect(watchStateTextClass(kind)).toMatch(/var\(--color-/)
    }
  })

  it('Given the armed state, When the dot class is read, Then it carries the calm success pulse (matches the pre-extraction ribbon treatment)', () => {
    // arrange / act / assert
    expect(watchStateDotClass('armed')).toBe(
      'bg-[var(--color-success)] animate-[pulse_2s_ease-in-out_infinite]',
    )
  })
})
