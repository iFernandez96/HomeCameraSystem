import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { Button } from './Button'

// iter-356.2 — pin Button primitive contract:
// - variant + size className composition
// - loading state: disables + spinner + optional loadingText swap
// - fullWidth modifier
// - default type="button" (not "submit") so consumers don't surprise-submit forms
// - forwardRef to native <button> for confirm.tsx focus-restore pattern

describe('Button primitive', () => {
  it('given default props, when rendered, then a type="button" with the ink primary fill + md classes appears (Sunroom redesign)', () => {
    // arrange / act
    render(<Button>Save</Button>)

    // assert
    const btn = screen.getByRole('button', { name: /save/i })
    expect(btn).toHaveAttribute('type', 'button')
    // Sunroom signature: primary = Panther-ink fill; the label uses the
    // on-ink token (white in light, ink on the inverted parchment fill
    // in dark) — a hardcoded text-white would vanish on the dark theme.
    expect(btn.className).toMatch(/bg-\[var\(--color-ink\)\]/)
    expect(btn.className).toMatch(/text-\[var\(--color-on-ink\)\]/)
    // Medium size: 44px min-height.
    expect(btn.className).toMatch(/min-h-\[44px\]/)
  })

  it('given variant="destructive", when rendered, then the danger pill outline (1.5px border + danger text) is applied (Playroom Modern)', () => {
    // arrange / act
    render(<Button variant="destructive">Reboot</Button>)

    // assert — Playroom Modern destructive is a pill OUTLINE: 1.5px
    // border-[var(--color-danger)] + text-[var(--color-danger)] on a
    // transparent fill, not the old solid --color-danger-strong fill.
    const btn = screen.getByRole('button', { name: /reboot/i })
    expect(btn.className).toMatch(/border-\[1\.5px\]/)
    expect(btn.className).toMatch(/border-\[var\(--color-danger\)\]/)
    expect(btn.className).toMatch(/text-\[var\(--color-danger\)\]/)
  })

  it('given variant="ghost", when rendered, then transparent fill class is applied', () => {
    // arrange / act
    render(<Button variant="ghost">Cancel</Button>)

    // assert
    expect(
      screen.getByRole('button', { name: /cancel/i }).className,
    ).toMatch(/bg-transparent/)
  })

  it('given size="sm", when rendered, then 40px min-height applied (Frank A1 touch floor)', () => {
    // arrange / act
    render(<Button size="sm">Chip</Button>)

    // assert
    expect(screen.getByRole('button', { name: /chip/i }).className).toMatch(
      /min-h-\[40px\]/,
    )
  })

  it('given any variant, when rendered, then the base classes carry the active:scale press cue distinct from hover', () => {
    // arrange / act — press feedback must not be identical to hover:
    // base scale cue on all variants, and primary steps active bg back
    // to full ink (one past the ink-hover hover state).
    render(<Button>Press</Button>)

    // assert
    const btn = screen.getByRole('button', { name: /press/i })
    expect(btn.className).toMatch(/active:scale-\[0\.98\]/)
    expect(btn.className).toMatch(/active:bg-\[var\(--color-ink\)\]/)
  })

  it('given size="lg", when rendered, then 48px min-height applied', () => {
    // arrange / act
    render(<Button size="lg">Hero</Button>)

    // assert
    expect(screen.getByRole('button', { name: /hero/i }).className).toMatch(
      /min-h-\[48px\]/,
    )
  })

  it('given fullWidth, when rendered, then w-full class is applied', () => {
    // arrange / act
    render(<Button fullWidth>Wide</Button>)

    // assert
    expect(screen.getByRole('button', { name: /wide/i }).className).toMatch(
      /w-full/,
    )
  })

  it('given loading=true, when rendered, then button is disabled + aria-disabled + aria-busy + sr-only live region announces (iter-356.5 a11y Top 1)', () => {
    // arrange / act — loadingText replaces visible label when loading,
    // so the accessible name becomes "Saving".
    render(<Button loading loadingText="Saving">Save</Button>)

    // assert
    const btn = screen.getByRole('button', { name: 'Saving' })
    expect(btn).toBeDisabled()
    expect(btn).toHaveAttribute('aria-disabled', 'true')
    // iter-356.5 a11y Top 1: aria-busy AND a sr-only role=status live
    // region must announce loadingText. Without these NVDA announces
    // "Save, button, dimmed" then silence — Dana hears no progress.
    expect(btn).toHaveAttribute('aria-busy', 'true')
    const status = screen.getByRole('status')
    expect(status.textContent).toContain('Saving')
  })

  it('given loading=true with loadingText, when rendered, then loadingText replaces children', () => {
    // arrange / act
    render(
      <Button loading loadingText="Signing in…">
        Sign in
      </Button>,
    )

    // assert — only loadingText visible.
    expect(screen.getByRole('button', { name: /signing in/i })).toBeInTheDocument()
    expect(screen.queryByText('Sign in')).toBeNull()
  })

  it('given loading=true without loadingText, when rendered, then children stay visible alongside spinner', () => {
    // arrange / act
    render(<Button loading>Save</Button>)

    // assert — children still rendered (spinner sits inline).
    expect(screen.getByRole('button', { name: /save/i })).toHaveTextContent('Save')
  })

  it('when clicked, then onClick fires (interactive contract)', () => {
    // arrange
    const onClick = vi.fn()

    // act
    render(<Button onClick={onClick}>Tap me</Button>)
    fireEvent.click(screen.getByRole('button', { name: /tap me/i }))

    // assert
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('given disabled=true, when clicked, then onClick is NOT fired', () => {
    // arrange
    const onClick = vi.fn()

    // act
    render(
      <Button disabled onClick={onClick}>
        Frozen
      </Button>,
    )
    fireEvent.click(screen.getByRole('button', { name: /frozen/i }))

    // assert
    expect(onClick).not.toHaveBeenCalled()
  })

  it('given className prop, when rendered, then it appends to the variant+size classes (does not replace)', () => {
    // arrange / act
    render(<Button className="custom-extra">Tap</Button>)

    // assert — both base + extra present.
    const btn = screen.getByRole('button', { name: /tap/i })
    expect(btn.className).toMatch(/bg-\[var\(--color-ink\)\]/)
    expect(btn.className).toMatch(/custom-extra/)
  })

  it('given type="submit" override, when rendered, then submit type is honored', () => {
    // arrange / act
    render(<Button type="submit">Save</Button>)

    // assert
    expect(screen.getByRole('button', { name: /save/i })).toHaveAttribute(
      'type',
      'submit',
    )
  })
})
