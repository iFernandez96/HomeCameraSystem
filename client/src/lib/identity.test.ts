import { describe, expect, it } from 'vitest'
import { identityOf, identityForName } from './identity'

describe('identityOf', () => {
  it('GIVEN a cat event WHEN mapped THEN kind cat with the marmalade hue', () => {
    // arrange
    const e = { label: 'cat', person_name: null, person_names: null }
    // act
    const id = identityOf(e)
    // assert
    expect(id.kind).toBe('cat')
    expect(id.colorVar).toBe('var(--color-id-mushu)')
    expect(id.softVar).toBe('var(--color-id-mushu-soft)')
  })

  it('GIVEN an unrecognized person WHEN mapped THEN kind person with cobalt', () => {
    // arrange
    const e = { label: 'person', person_name: null, person_names: null }
    // act
    const id = identityOf(e)
    // assert
    expect(id.kind).toBe('person')
    expect(id.name).toBeNull()
    expect(id.colorVar).toBe('var(--color-id-person)')
  })

  it('GIVEN a recognized person WHEN mapped THEN named-person with a stable wheel hue', () => {
    // arrange
    const e = { label: 'person', person_name: 'israel', person_names: ['israel'] }
    // act
    const a = identityOf(e)
    const b = identityOf(e)
    // assert
    expect(a.kind).toBe('named-person')
    expect(a.name).toBe('israel')
    expect(a.colorVar).toMatch(/^var\(--color-id-wheel-[1-6]\)$/)
    expect(b.colorVar).toBe(a.colorVar) // deterministic
  })

  it('GIVEN two different names WHEN adjacent in the wheel THEN they usually differ (hash spread)', () => {
    // arrange / act
    const hues = ['israel', 'sheenal', 'ana', 'mateo'].map((n) => identityForName(n).colorVar)
    // assert — at least 2 distinct hues across 4 names (hash isn't degenerate)
    expect(new Set(hues).size).toBeGreaterThanOrEqual(2)
  })

  it('GIVEN a dog event WHEN mapped THEN kind other with panther slate', () => {
    // arrange
    const e = { label: 'dog', person_name: null, person_names: null }
    // act / assert
    expect(identityOf(e).colorVar).toBe('var(--color-id-panther)')
  })
})
