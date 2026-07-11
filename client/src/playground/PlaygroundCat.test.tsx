import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { PlaygroundCat } from './PlaygroundCat'
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

describe('PlaygroundCat sprite box (USER REPORT 1: every frame renders at the same size)', () => {
  it('Given anim-set and playground-set frames, When rendered, Then both use the SAME fixed sprite box (objectFit contain, bottom-anchored) so aspect-ratio differences can never change the cat size or feet line', () => {
    // arrange — a walking cat (shared anim frame) and an eating cat
    // (playground-only frame from the area-normalized export set)
    const walking = catFor({ activity: 'walk', previousActivity: 'walk' })
    const eating = catFor({ activity: 'eat', previousActivity: 'eat' })

    // act
    const first = render(
      <PlaygroundCat cat={walking} onPetStart={() => {}} onPetEnd={() => {}} />,
    )
    const walkImg = screen.getByTestId('playground-cat-sprite')
    const walkBox = {
      width: walkImg.getAttribute('width'),
      height: walkImg.getAttribute('height'),
      fit: walkImg.style.objectFit,
      position: walkImg.style.objectPosition,
    }
    first.unmount()
    render(<PlaygroundCat cat={eating} onPetStart={() => {}} onPetEnd={() => {}} />)
    const eatImg = screen.getByTestId('playground-cat-sprite')

    // assert — the playground frame comes from the playground set…
    expect(eatImg.getAttribute('src')).toContain('/cats/playground/panther/eat_')
    // …and renders in the IDENTICAL fixed box as the anim set
    expect({
      width: eatImg.getAttribute('width'),
      height: eatImg.getAttribute('height'),
      fit: eatImg.style.objectFit,
      position: eatImg.style.objectPosition,
    }).toEqual(walkBox)
    expect(walkBox.width).toBe('44')
    expect(walkBox.fit).toBe('contain')
    expect(walkBox.position).toBe('center bottom')
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
