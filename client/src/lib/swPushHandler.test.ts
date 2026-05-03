import { describe, expect, it, vi } from 'vitest'
import {
  applyBadge,
  buildNotification,
  parsePushData,
  type PushPayload,
} from './swPushHandler'

// iter-282 (test-coverage gap #1+#2): pin the SW push-handler
// behavior. Pre-iter-282 sw.ts was 100% untested even though the
// iter-275 per-event tag + iter-276 setAppBadge logic shipped to
// production. BDD-lite naming + AAA structure.

describe('parsePushData', () => {
  it('given an event with valid JSON data, when parsed, then returns the parsed object', () => {
    // arrange
    const event = {
      data: {
        json: () => ({ title: 'Person detected', body: 'Front Door · 87%' }),
        text: () => 'unused',
      },
    }

    // act
    const data = parsePushData(event)

    // assert
    expect(data.title).toBe('Person detected')
    expect(data.body).toBe('Front Door · 87%')
  })

  it('given an event without data, when parsed, then returns empty object', () => {
    // act
    const data = parsePushData({ data: null })

    // assert
    expect(data).toEqual({})
  })

  it('given event.data.json() throws, when parsed, then falls back to text', () => {
    // arrange
    const event = {
      data: {
        json: () => {
          throw new Error('not JSON')
        },
        text: () => 'plain text payload',
      },
    }

    // act
    const data = parsePushData(event)

    // assert
    expect(data.body).toBe('plain text payload')
  })
})

describe('buildNotification', () => {
  it('given a payload with title and body, when built, then those fields populate showNotification args', () => {
    // act
    const { title, options } = buildNotification({
      title: 'Israel detected',
      body: 'Front Door · 91%',
    })

    // assert
    expect(title).toBe('Israel detected')
    expect(options.body).toBe('Front Door · 91%')
  })

  it('given an empty payload, when built, then defaults to "Home Camera" / "New event" (test-push contract)', () => {
    // act
    const { title, options } = buildNotification({})

    // assert
    expect(title).toBe('Home Camera')
    expect(options.body).toBe('New event')
  })

  it('given a payload with event_id, when built, then tag === event_id (iter-275 per-event)', () => {
    // act
    const { options } = buildNotification({ event_id: 'evt-abc-123' })

    // assert: tag drives Notification.tag → per-event grouping;
    // detection bursts no longer collapse into a single notification.
    expect(options.tag).toBe('evt-abc-123')
  })

  it('given a payload with id but no event_id, when built, then tag falls back to id (iter-275 fallback chain)', () => {
    // act
    const { options } = buildNotification({ id: 'evt-fallback' })

    // assert
    expect(options.tag).toBe('evt-fallback')
  })

  it('given a payload with only data.tag, when built, then tag uses that value (server-supplied tag)', () => {
    // act
    const { options } = buildNotification({ tag: 'detection' })

    // assert
    expect(options.tag).toBe('detection')
  })

  it('given a payload with no event_id/id/tag, when built, then tag defaults to "event"', () => {
    // act
    const { options } = buildNotification({})

    // assert: test-push fallback. Pre-iter-275 every push used
    // this literal — fine for one-shot test pushes; harmful for
    // detection bursts (replace-on-tag suppressed all but last).
    expect(options.tag).toBe('event')
  })

  it('given a payload with image, when built, then options.image is set (iter-188 hero)', () => {
    // act
    const { options } = buildNotification({
      image: '/snapshots/thumb_42.jpg',
    })

    // assert
    expect((options as unknown as { image?: string }).image).toBe(
      '/snapshots/thumb_42.jpg',
    )
  })

  it('given a payload without image, when built, then options.image is absent (not undefined)', () => {
    // act
    const { options } = buildNotification({})

    // assert: iter-188 contract — absent key (vs `image: null`) so
    // DevTools is tidy and the SW spec's optional handling kicks in.
    expect('image' in options).toBe(false)
  })

  it('given any built options, when produced, then renotify: true so the audible alert re-fires (iter-275)', () => {
    // act
    const { options } = buildNotification({ event_id: 'x' })

    // assert
    expect((options as unknown as { renotify?: boolean }).renotify).toBe(true)
  })

  it('given any built options, when produced, then icon and badge URLs are the iter-253 PNG variants', () => {
    // act
    const { options } = buildNotification({})

    // assert: SVG fallback hit Firefox / Safari (browser flame
    // icon). PNG variants ship the brand mark on every browser.
    expect(options.icon).toBe('/icon-192.png')
    expect(options.badge).toBe('/icon-96.png')
  })
})

describe('applyBadge', () => {
  function makeReg() {
    return {
      setAppBadge: vi.fn().mockResolvedValue(undefined),
      clearAppBadge: vi.fn().mockResolvedValue(undefined),
    }
  }

  it('given unread_count > 0, when applyBadge fires, then setAppBadge is called with that count (iter-276)', () => {
    // arrange
    const reg = makeReg()

    // act
    applyBadge(reg, { unread_count: 5 })

    // assert
    expect(reg.setAppBadge).toHaveBeenCalledWith(5)
    expect(reg.clearAppBadge).not.toHaveBeenCalled()
  })

  it('given unread_count === 0, when applyBadge fires, then clearAppBadge is called (iter-276)', () => {
    // arrange
    const reg = makeReg()

    // act
    applyBadge(reg, { unread_count: 0 })

    // assert
    expect(reg.clearAppBadge).toHaveBeenCalled()
    expect(reg.setAppBadge).not.toHaveBeenCalled()
  })

  it('given no unread_count in payload, when applyBadge fires, then neither badge API is called (silent no-op)', () => {
    // arrange
    const reg = makeReg()

    // act
    applyBadge(reg, {})

    // assert: pre-iter-276 server didn't always send unread_count;
    // SW must tolerate absence gracefully, not surface a default 0.
    expect(reg.setAppBadge).not.toHaveBeenCalled()
    expect(reg.clearAppBadge).not.toHaveBeenCalled()
  })

  it('given a registration without setAppBadge (Firefox/Safari), when applyBadge fires, then no error is thrown', () => {
    // arrange: simulate Firefox where the API doesn't exist.
    const reg = {} as Parameters<typeof applyBadge>[0]

    // act + assert
    expect(() => applyBadge(reg, { unread_count: 3 })).not.toThrow()
  })

  it('given setAppBadge rejects, when applyBadge fires, then the rejection is swallowed silently', async () => {
    // arrange
    const reg = {
      setAppBadge: vi.fn().mockRejectedValue(new TypeError('feature disabled')),
    }

    // act
    applyBadge(reg, { unread_count: 2 })
    // Wait one microtask so the rejected promise's catch handler
    // gets a chance to run before the test ends — without this the
    // unhandled-rejection check from the test runner can flag it.
    await Promise.resolve()

    // assert: setAppBadge was attempted; no throw bubbled up.
    expect(reg.setAppBadge).toHaveBeenCalledWith(2)
  })

  it('given a non-numeric unread_count, when applyBadge fires, then no badge API is called (iter-282 input validation)', () => {
    // arrange
    const reg = makeReg()
    const payload: PushPayload = { unread_count: 'three' as unknown }

    // act
    applyBadge(reg, payload)

    // assert
    expect(reg.setAppBadge).not.toHaveBeenCalled()
    expect(reg.clearAppBadge).not.toHaveBeenCalled()
  })
})

// iter-332 (missing-feature #2, Notification Action Buttons):
// inline View / Mark seen action buttons for Android Chrome push
// notifications. iOS 16.4 Safari ignores `actions` silently.

describe('buildNotification — iter-332 actions', () => {
  it('given a payload with event_id, when built, then options.actions carries View + Mark seen entries (iter-332)', () => {
    // arrange
    const data: PushPayload = {
      title: 'Person at front door',
      body: '92%',
      event_id: 'evt-12345',
    }

    // act
    const { options } = buildNotification(data)
    const actions = (options as unknown as { actions?: Array<{ action: string; title: string }> }).actions

    // assert
    expect(actions).toHaveLength(2)
    expect(actions?.[0]).toMatchObject({ action: 'view', title: 'View' })
    expect(actions?.[1]).toMatchObject({ action: 'dismiss', title: 'Mark seen' })
  })

  it('given a payload with event_id, when built, then options.data.event_id is preserved for the click handler (iter-332)', () => {
    // arrange
    const data: PushPayload = { title: 't', body: 'b', event_id: 'evt-deep-link' }

    // act
    const { options } = buildNotification(data)
    const optData = options.data as { event_id?: string; url?: string }

    // assert — sw.ts notificationclick reads event.notification.data.event_id
    // to POST /api/events/{id}/seen on the Mark seen action.
    expect(optData.event_id).toBe('evt-deep-link')
    expect(optData.url).toBe('/events')  // default url
  })

  it('given a payload with event_id, when built, then options.requireInteraction is true (iter-342: keep notification visible long enough for action buttons)', () => {
    // arrange (iter-342 widget-usability C2: Android Chrome auto-
    // dismisses notifications after ~5s; the iter-332 action
    // buttons need requireInteraction to stay visible until the
    // user interacts).
    const data: PushPayload = { title: 't', body: 'b', event_id: 'evt-pin' }

    // act
    const { options } = buildNotification(data)
    const ri = (options as unknown as { requireInteraction?: boolean })
      .requireInteraction

    // assert
    expect(ri).toBe(true)
  })

  it('given a payload WITHOUT event_id (test push or malformed), when built, then NO actions array is emitted (iter-332)', () => {
    // arrange — falls back to literal 'event' tag, which is the
    // sentinel for "can\'t mark seen" — actions would be misleading.
    const data: PushPayload = { title: 'Test push', body: 'pong' }

    // act
    const { options } = buildNotification(data)
    const actions = (options as unknown as { actions?: unknown }).actions

    // assert
    expect(actions).toBeUndefined()
  })
})
