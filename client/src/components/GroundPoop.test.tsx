import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import {
  GroundPoop,
  POOP_FADE_MS,
  POOP_VISIBLE_JITTER_MS,
  POOP_VISIBLE_MIN_MS,
  groundPoopExpired,
  spawnGroundPoop,
} from './GroundPoop'

describe('spawnGroundPoop (the trailing-edge drop)', () => {
  it('Given a left-facing cat, When the squat completes, Then the poop lands behind it on the RIGHT (trailing edge)', () => {
    // arrange
    const catX = 300
    const catWidth = 44 // size = round(44 * 0.42) = 18

    // act
    const poop = spawnGroundPoop(catX, 'L', catWidth, 1000, () => 0.5)

    // assert — x = 300 + 44 - 18*0.45 = 335.9 → 336, past the cat's right edge midline
    expect(poop.x).toBe(336)
    expect(poop.x).toBeGreaterThan(catX + catWidth / 2)
  })

  it('Given a right-facing cat, When the squat completes, Then the poop lands behind it on the LEFT', () => {
    // act
    const poop = spawnGroundPoop(300, 'R', 44, 1000, () => 0.5)

    // assert — x = 300 - 18*0.55 = 290.1 → 290, before the cat's left edge
    expect(poop.x).toBe(290)
    expect(poop.x).toBeLessThan(300)
  })

  it('Given the jittered visible window, When a poop spawns, Then it stays 6-8 s before fading and expires only after the fade completes', () => {
    // arrange
    const now = 5000

    // act
    const shortest = spawnGroundPoop(0, 'L', 44, now, () => 0)
    const longest = spawnGroundPoop(0, 'L', 44, now, () => 1)

    // assert — visible window bounds
    expect(shortest.fadeAt).toBe(now + POOP_VISIBLE_MIN_MS)
    expect(longest.fadeAt).toBe(now + POOP_VISIBLE_MIN_MS + POOP_VISIBLE_JITTER_MS)
    // lifecycle: alive through the fade, gone after it
    expect(groundPoopExpired(shortest, shortest.fadeAt + POOP_FADE_MS)).toBe(false)
    expect(groundPoopExpired(shortest, shortest.fadeAt + POOP_FADE_MS + 1)).toBe(true)
  })
})

describe('GroundPoop rendering (poop on the ground with stink fumes)', () => {
  it('Given a live poop, When rendered, Then the prop sits at its scene spot with the two alternating fume wisps rising from its top', () => {
    // arrange + act
    render(<GroundPoop x={120} bottom={4} size={18} visibleMs={7000} />)

    // assert — the prop
    const root = screen.getByTestId('ground-poop')
    expect(root.style.left).toBe('120px')
    expect(root.style.bottom).toBe('4px')
    const prop = screen.getByTestId('ground-poop-prop')
    expect(prop.getAttribute('src')).toBe('/cats/props/poop.png')
    // fumes: a drifting wrapper holding the a/b wisp pair
    const fumes = screen.getByTestId('ground-poop-fumes')
    expect(fumes.style.animation).toContain('ground-poop-fume-drift')
    const wisps = fumes.querySelectorAll('img')
    expect(wisps).toHaveLength(2)
    expect(wisps[0].getAttribute('src')).toBe('/cats/props/fume_a.png')
    expect(wisps[1].getAttribute('src')).toBe('/cats/props/fume_b.png')
  })

  it('Given the lifecycle animations, When rendered, Then the container carries opacity-only appear + delayed fade (no transform keyframes on an element with inline transforms)', () => {
    // arrange + act
    render(<GroundPoop x={0} bottom={0} size={18} visibleMs={6500} />)

    // assert — fade starts after the visible window, on the container
    const root = screen.getByTestId('ground-poop')
    expect(root.style.animation).toContain('ground-poop-appear')
    expect(root.style.animation).toContain('ground-poop-fade')
    expect(root.style.animation).toContain('6500ms')
    // the container positions via left/bottom, never inline transform
    expect(root.style.transform).toBe('')
  })

  it('Given the exported art, When the props dir is scanned, Then poop and both fume sprites exist on disk', async () => {
    // arrange
    const { existsSync } = await import('node:fs')
    const { join } = await import('node:path')
    const root = join(__dirname, '..', '..', 'public', 'cats', 'props')

    // act + assert
    for (const file of ['poop.png', 'fume_a.png', 'fume_b.png']) {
      expect(existsSync(join(root, file)), `${file} missing`).toBe(true)
    }
  })
})
