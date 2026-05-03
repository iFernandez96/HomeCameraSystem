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
