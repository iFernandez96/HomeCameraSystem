import '@testing-library/jest-dom/vitest'
import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

afterEach(() => {
  cleanup()
})

// jsdom doesn't implement Canvas. VideoTile handles a null 2D context
// gracefully, but jsdom logs a "Not implemented" warning to stderr unless
// we stub getContext explicitly.
if (typeof HTMLCanvasElement !== 'undefined') {
  HTMLCanvasElement.prototype.getContext = (() => null) as unknown as HTMLCanvasElement['getContext']
}

// jsdom intentionally leaves media playback unimplemented. Components call
// play() as they do in browsers, so provide a resolved promise rather than
// flooding otherwise-green test output with "Not implemented" stacks.
if (typeof HTMLMediaElement !== 'undefined') {
  HTMLMediaElement.prototype.play = () => Promise.resolve()
  HTMLMediaElement.prototype.pause = () => undefined
}

// React 19 currently reports this false-positive when a real React.lazy
// module resolves under Vitest even though Testing Library awaited the visible
// Suspense result. Keep every other console error visible.
const originalConsoleError = console.error
console.error = (...args: unknown[]) => {
  const message = typeof args[0] === 'string' ? args[0] : ''
  if (message.includes('A component suspended inside an `act` scope')) return
  originalConsoleError(...args)
}
