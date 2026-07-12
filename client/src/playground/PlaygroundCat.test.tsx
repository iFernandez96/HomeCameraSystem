import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { PlaygroundCat, spriteRenderHeightPx } from './PlaygroundCat'
import { buildHomeCat, type PlayCat } from './playgroundState'

const W = 800
const H = 400

function catFor(over: Partial<PlayCat> = {}): PlayCat {
  return { ...buildHomeCat('panther', 1000, W, H, () => 0.5), ...over }
}

describe('PlaygroundCat wrapper structure (the Panther-mirror pin, same as CatLayer.test.tsx)', () => {
  it('Given a rendered cat, When the wrappers are inspected, Then the rAF translate, any entrance animation slot, and the direction flip live on SEPARATE nested elements', () => {
    // arrange — a filled CSS animation overrides inline transforms on
    // its own element FOREVER; the flip div must never share an element
    // with either the positioned translate or an entrance animation.
    const cat = catFor({ direction: 'R' })

    // act
    render(<PlaygroundCat cat={cat} onPetStart={() => {}} onPetEnd={() => {}} />)

    // assert — positioned container owns the inline translateX
    const container = screen.getByTestId('playground-cat-panther')
    expect(container.style.transform).toContain('translateX(')
    expect(container.style.animation).toBe('')
    // the entrance wrapper is a DISTINCT child (animation slot), and the
    // flip element is nested inside it — never the container itself
    const entrance = screen.getByTestId('playground-cat-entrance-wrapper')
    expect(entrance.parentElement).toBe(container)
    const flip = screen.getByTestId('playground-cat-direction-flip')
    expect(flip.parentElement).toBe(entrance)
    // the flip carries ONLY the facing scaleX — no translate, no animation
    expect(flip.style.transform).toBe('scaleX(-1)')
    expect(flip.style.transform).not.toContain('translate')
    expect(flip.style.animation).toBe('')
  })

  it('Given a left-facing cat, When rendered, Then the flip element carries no scaleX (shared PNGs face left natively)', () => {
    // arrange
    const cat = catFor({ direction: 'L' })

    // act
    render(<PlaygroundCat cat={cat} onPetStart={() => {}} onPetEnd={() => {}} />)

    // assert
    expect(screen.getByTestId('playground-cat-direction-flip').style.transform).toBe('')
  })

  it('Given a walking cat, When rendered, Then the bob animation sits on the innermost wrapper, not on the flip or positioned elements', () => {
    // arrange
    const cat = catFor({ activity: 'walk', previousActivity: 'walk' })

    // act
    render(<PlaygroundCat cat={cat} onPetStart={() => {}} onPetEnd={() => {}} />)

    // assert
    const flip = screen.getByTestId('playground-cat-direction-flip')
    const bob = flip.firstElementChild as HTMLElement
    expect(bob.style.animation).toContain('cat-walk-bob')
    expect(flip.style.animation).toBe('')
    expect(screen.getByTestId('playground-cat-panther').style.animation).toBe('')
  })
})

describe('PlaygroundCat sprite render (RESIDUAL A 2026-07-11: fixed BODY SCALE, not a fixed contain box)', () => {
  function spriteFor(cat: PlayCat): HTMLElement {
    render(<PlaygroundCat cat={cat} onPetStart={() => {}} onPetEnd={() => {}} />)
    return screen.getByTestId('playground-cat-sprite')
  }

  it('Given a narrow walk frame and a WIDE eat frame, When rendered, Then both pin the SAME rendered body height with width:auto (a wide canvas can never shrink the cat) and hang bottom-centered on the cat x', () => {
    // arrange — a walking cat (shared anim frame) and an eating cat
    // (playground eat_a is a 165×128 canvas: contain-fitting it into the
    // 44px box was the "cat gets smaller while eating" size complaint)
    const walking = catFor({ activity: 'walk', previousActivity: 'walk' })
    // Frames-30 wave 2c: eat now opens with a 700ms sniff_prelude entry,
    // so sample the sprite 1s into the bout where the chew frames run.
    const eatingBase = catFor({ activity: 'eat', previousActivity: 'eat' })
    const eating = { ...eatingBase, phaseTime: eatingBase.activityStartedAt + 1000 }

    // act
    const first = render(
      <PlaygroundCat cat={walking} onPetStart={() => {}} onPetEnd={() => {}} />,
    )
    const walkImg = screen.getByTestId('playground-cat-sprite')
    const walkRender = {
      height: walkImg.style.height,
      width: walkImg.style.width,
      left: walkImg.style.left,
      bottom: walkImg.style.bottom,
      transform: walkImg.style.transform,
    }
    first.unmount()
    render(<PlaygroundCat cat={eating} onPetStart={() => {}} onPetEnd={() => {}} />)
    const eatImg = screen.getByTestId('playground-cat-sprite')

    // assert — the playground frame comes from the playground set…
    expect(eatImg.getAttribute('src')).toContain('/cats/playground/panther/eat_')
    // …and renders at the IDENTICAL body height, aspect-free width,
    // anchored bottom-CENTER (may overflow the layout box horizontally)
    expect({
      height: eatImg.style.height,
      width: eatImg.style.width,
      left: eatImg.style.left,
      bottom: eatImg.style.bottom,
      transform: eatImg.style.transform,
    }).toEqual(walkRender)
    expect(walkRender.height).toBe('53px') // = CAT_HEIGHT_PX (128-tall canvas)
    expect(walkRender.width).toBe('auto')
    expect(walkRender.left).toBe('50%')
    expect(walkRender.transform).toBe('translateX(-50%)')
    // no legacy contain-fit remnants
    expect(eatImg.getAttribute('width')).toBeNull()
    expect(eatImg.style.objectFit).toBe('')
  })

  it('Given a 160-tall-canvas pose (climb), When rendered, Then the sprite is proportionally TALLER at the same body scale (spriteRenderHeightPx), never squashed into the 53px box', () => {
    // arrange — a climbing cat renders climb_a via the climbing override
    const climbingCat = catFor({
      activity: 'walk',
      previousActivity: 'walk',
      climbing: true,
    })

    // act
    const img = spriteFor(climbingCat)

    // assert — 53 × 160/128 = 66px; the taller canvas is real pose height
    expect(img.getAttribute('data-anim-frame')).toBe('climb_a')
    expect(img.style.height).toBe(`${spriteRenderHeightPx('climb_a')}px`)
    expect(img.style.height).toBe('66px')
    expect(spriteRenderHeightPx('seated')).toBe(53)
  })

  it('Given a right-facing cat with the centered sprite, When rendered, Then the flip still carries ONLY scaleX(-1) so mirroring stays around the box center', () => {
    // arrange
    const cat = catFor({ direction: 'R', activity: 'eat', previousActivity: 'eat' })

    // act
    render(<PlaygroundCat cat={cat} onPetStart={() => {}} onPetEnd={() => {}} />)

    // assert — flip div unchanged; the img centers itself inside it, so
    // scaleX about the box center keeps the sprite centered either way
    const flip = screen.getByTestId('playground-cat-direction-flip')
    expect(flip.style.transform).toBe('scaleX(-1)')
    const img = screen.getByTestId('playground-cat-sprite')
    expect(img.style.left).toBe('50%')
    expect(img.style.transform).toBe('translateX(-50%)')
  })

  it('Given wide/tall sprites can overflow the 44×53 layout box, When rendered, Then the petting hit area is oversized beyond the box so it still covers the visual sprite', () => {
    // arrange
    const cat = catFor({ activity: 'eat', previousActivity: 'eat' })

    // act
    render(<PlaygroundCat cat={cat} onPetStart={() => {}} onPetEnd={() => {}} />)

    // assert — extends past every overflowing edge, still floor-anchored
    const hit = screen.getByTestId('playground-cat-hit-panther')
    expect(hit.style.left).toBe('-16px')
    expect(hit.style.right).toBe('-16px')
    expect(hit.style.top).toBe('-14px')
    expect(hit.style.bottom).toBe('0px')
  })

  it('Given a back-lane depth blend, When rendered, Then the container scale follows laneBlend (cross-fade), not a lane boolean', () => {
    // arrange — mid-fade toward the back lane
    const cat = catFor({ lane: 'back', laneBlend: 0.5 })

    // act
    render(<PlaygroundCat cat={cat} onPetStart={() => {}} onPetEnd={() => {}} />)

    // assert — 1 - (1 - 0.85) * 0.5 = 0.925
    const container = screen.getByTestId('playground-cat-panther')
    expect(container.style.transform).toContain('scale(0.9250)')
  })
})

describe('PlaygroundCat ground shadow (live burst audit 2026-07-11: floating cats)', () => {
  it('Given a visible cat, When rendered, Then a ground-shadow ellipse sits inside the positioned container but OUTSIDE the entrance wrapper (never inherits flip/bob transforms)', () => {
    // arrange
    const cat = catFor()

    // act
    render(<PlaygroundCat cat={cat} onPetStart={() => {}} onPetEnd={() => {}} />)

    // assert
    const shadow = screen.getByTestId('playcat-ground-shadow')
    expect(shadow.parentElement).toBe(screen.getByTestId('playground-cat-panther'))
    const entrance = screen.getByTestId('playground-cat-entrance-wrapper')
    expect(entrance.contains(shadow)).toBe(false)
  })

  it('Given a cat hidden inside the tunnel, When rendered, Then no ground shadow renders (nothing casts one)', () => {
    // arrange
    const cat = catFor({ activity: 'tunnel', previousActivity: 'tunnel' })

    // act
    render(<PlaygroundCat cat={cat} onPetStart={() => {}} onPetEnd={() => {}} />)

    // assert
    expect(screen.queryByTestId('playcat-ground-shadow')).toBeNull()
  })
})

describe('PlaygroundCat turn-around pivot render (2026-07-11: the flip must be instant on the frontal frame)', () => {
  const T = 1000

  function pivotCat(phaseTime: number): PlayCat {
    return catFor({
      activity: 'walk',
      previousActivity: 'walk',
      activityStartedAt: T - 5000,
      direction: 'R', // destination facing, set at pivot start
      turn: { startedAt: T, from: 'L', to: 'R' },
      phaseTime,
    })
  }

  it('Given a pivot before its frontal midpoint, When rendered, Then the OLD facing shows with the pivot frame and the flip transition is disabled', () => {
    // arrange — 60ms in: frames-30 ladder runs 30ms steps, so this is
    // the turn_1b midpoint rung; still facing the old way
    const cat = pivotCat(T + 60)

    // act
    render(<PlaygroundCat cat={cat} onPetStart={() => {}} onPetEnd={() => {}} />)

    // assert
    const flip = screen.getByTestId('playground-cat-direction-flip')
    expect(flip.style.transform).toBe('') // from='L' → no mirror yet
    expect(flip.style.transition).toBe('none')
    // wave 5: 60ms into the 19-rung ladder is the turn_n3 level-2 rung
    expect(screen.getByTestId('playground-cat-sprite').getAttribute('data-anim-frame')).toBe('turn_n3')
  })

  it('Given a pivot at its frontal midpoint, When rendered, Then the NEW facing shows on the symmetric stand frame (the invisible seam)', () => {
    // arrange — 165ms = duration/2, inside the centered stand step
    const cat = pivotCat(T + 165)

    // act
    render(<PlaygroundCat cat={cat} onPetStart={() => {}} onPetEnd={() => {}} />)

    // assert
    const flip = screen.getByTestId('playground-cat-direction-flip')
    expect(flip.style.transform).toBe('scaleX(-1)') // to='R'
    expect(flip.style.transition).toBe('none')
    expect(screen.getByTestId('playground-cat-sprite').getAttribute('data-anim-frame')).toBe('stand')
  })

  it('Given a completed pivot, When rendered, Then the gait plan and cat.direction take back over with the 220ms transition restored', () => {
    // arrange — past the 330ms pivot
    const cat = pivotCat(T + 400)

    // act
    render(<PlaygroundCat cat={cat} onPetStart={() => {}} onPetEnd={() => {}} />)

    // assert
    const flip = screen.getByTestId('playground-cat-direction-flip')
    expect(flip.style.transform).toBe('scaleX(-1)') // cat.direction='R'
    expect(flip.style.transition).toBe('transform 220ms ease-in-out')
    expect(
      screen.getByTestId('playground-cat-sprite').getAttribute('data-anim-frame'),
    ).toMatch(/^walk_/)
  })
})

describe('PlaygroundCat behavior', () => {
  it('Given a cat hidden inside the tunnel, When rendered, Then the sprite is invisible (the tunnel rustle carries the beat)', () => {
    // arrange
    const cat = catFor({ activity: 'tunnel', previousActivity: 'tunnel' })

    // act
    render(<PlaygroundCat cat={cat} onPetStart={() => {}} onPetEnd={() => {}} />)

    // assert
    expect(screen.getByTestId('playground-cat-panther').style.visibility).toBe('hidden')
  })

  it('Given the petting hit area, When pressed and released, Then the pet reporters fire with the cat id and never bubble to the scene', () => {
    // arrange
    const onPetStart = vi.fn()
    const onPetEnd = vi.fn()
    const sceneDown = vi.fn()
    render(
      <div onPointerDown={sceneDown}>
        <PlaygroundCat cat={catFor()} onPetStart={onPetStart} onPetEnd={onPetEnd} />
      </div>,
    )

    // act
    const hit = screen.getByTestId('playground-cat-hit-panther')
    fireEvent.pointerDown(hit)
    fireEvent.pointerUp(hit)

    // assert
    expect(onPetStart).toHaveBeenCalledWith('panther')
    expect(onPetEnd).toHaveBeenCalledWith('panther')
    expect(sceneDown).not.toHaveBeenCalled()
  })
})
