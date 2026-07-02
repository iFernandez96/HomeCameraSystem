import type { PointerEvent as ReactPointerEvent } from 'react'

/**
 * Material-style press ripple (warm-boutique / Android-native slice).
 *
 * Dependency-free: pure DOM append/remove — NO per-frame React state.
 * On pointer-down a circle expands from the touch point (translucent
 * `currentColor` at ~12% opacity, sized to cover the farthest corner),
 * animates ~400ms ease-out (`@keyframes hc-ripple-expand`, index.css)
 * and removes itself on animationend (setTimeout fallback for jsdom /
 * interrupted animations).
 *
 * Containment is the CONSUMER's job: the host element needs
 * `relative overflow-hidden` (or an inner absolutely-positioned
 * `data-ripple-host` overlay when overflow-hidden would clip other
 * absolute children — e.g. the SideRail tooltip flyouts).
 *
 * Reduced motion: hard no-op when
 * `matchMedia('(prefers-reduced-motion: reduce)')` matches — nothing
 * is appended at all (belt) and the global reduced-motion clamp in
 * index.css would zero the animation anyway (suspenders).
 *
 * Usage:
 *   const ripple = useRipple()
 *   <button onPointerDown={ripple} className="relative overflow-hidden …">
 * or directly:
 *   attachRipple(el, ev)
 */

const RIPPLE_DURATION_MS = 400

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

/** Spawn one ripple inside `el`, expanding from the pointer position. */
export function attachRipple(
  el: HTMLElement,
  ev: { clientX: number; clientY: number },
): void {
  if (prefersReducedMotion()) return

  const rect = el.getBoundingClientRect()
  const x = ev.clientX - rect.left
  const y = ev.clientY - rect.top
  // Radius to the FARTHEST corner so scale(1) fully covers the host.
  const radius = Math.max(
    Math.hypot(x, y),
    Math.hypot(rect.width - x, y),
    Math.hypot(x, rect.height - y),
    Math.hypot(rect.width - x, rect.height - y),
  )

  const span = document.createElement('span')
  span.className = 'hc-ripple'
  span.setAttribute('aria-hidden', 'true')
  span.style.width = `${radius * 2}px`
  span.style.height = `${radius * 2}px`
  span.style.left = `${x - radius}px`
  span.style.top = `${y - radius}px`
  el.appendChild(span)

  let removed = false
  const remove = () => {
    if (removed) return
    removed = true
    span.remove()
  }
  span.addEventListener('animationend', remove)
  // Fallback: jsdom never fires animationend, and a mid-animation
  // display:none also swallows it. Small grace past the duration.
  window.setTimeout(remove, RIPPLE_DURATION_MS + 100)
}

/**
 * Shared React pointer-down handler. Ripples into the nearest inner
 * `[data-ripple-host]` overlay if the consumer provides one, else
 * into the event's currentTarget itself.
 */
function rippleOnPointerDown(ev: ReactPointerEvent<HTMLElement>): void {
  const target = ev.currentTarget
  const host = target.querySelector<HTMLElement>('[data-ripple-host]') ?? target
  attachRipple(host, ev.nativeEvent)
}

/**
 * React helper: returns a stable onPointerDown handler (module-level
 * constant — safe in deps arrays, no useCallback needed).
 */
export function useRipple(): (ev: ReactPointerEvent<HTMLElement>) => void {
  return rippleOnPointerDown
}
