import { describe, expect, it } from 'vitest'
import { buildNotification } from './swPushHandler'

describe('buildNotification push image mapping', () => {
  it('given a payload image, when notification options are built, then options.image is the exact unrewritten image URL', () => {
    // arrange
    const image = '/snapshots/thumb_1700000000.jpg'

    // act
    const { options } = buildNotification({ image })

    // assert
    expect((options as unknown as { image?: string }).image).toBe(image)
  })
})
