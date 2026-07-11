import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  PLAYGROUND_AMBIENT_URLS,
  PLAYGROUND_CAT_FRAME_URLS,
  PLAYGROUND_FURNITURE_URLS,
  PLAYGROUND_TOY_URLS,
} from './playgroundAssets'

const PUBLIC_ROOT = join(__dirname, '..', '..', 'public')

describe('playground asset manifest', () => {
  it('Given every manifest URL, When the exported asset dir is scanned, Then each PNG exists on disk', () => {
    // arrange — flatten all four manifests into url strings
    const urls: string[] = [
      ...Object.values(PLAYGROUND_FURNITURE_URLS),
      ...Object.values(PLAYGROUND_TOY_URLS),
      ...Object.values(PLAYGROUND_AMBIENT_URLS),
      ...Object.values(PLAYGROUND_CAT_FRAME_URLS).flatMap((byFrame) =>
        Object.values(byFrame as Record<string, string>),
      ),
    ]

    // act
    const missing = urls.filter((url) => !existsSync(join(PUBLIC_ROOT, url)))

    // assert — 37 assets, generated and gated 2026-07-11; a missing file
    // means an export regression, not a generation gap.
    expect(urls.length).toBeGreaterThanOrEqual(37)
    expect(missing).toEqual([])
  })
})
