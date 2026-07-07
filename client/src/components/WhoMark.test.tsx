import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { identityOf, identityForName } from '../lib/identity'
import { BrandMarkRow, WhoMark } from './WhoMark'

describe('WhoMark', () => {
  it('GIVEN a cat identity WHEN rendered THEN an eared img labeled as a cat', () => {
    // arrange / act
    render(<WhoMark identity={identityOf({ label: 'cat', person_name: null, person_names: null })} />)
    // assert
    const img = screen.getByRole('img', { name: 'A cat' })
    expect(img.querySelectorAll('polygon')).toHaveLength(2) // the ears
  })

  it('GIVEN a named person WHEN rendered THEN a circle labeled with the name and no ears', () => {
    // arrange / act
    render(<WhoMark identity={identityForName('Israel')} />)
    // assert
    const img = screen.getByRole('img', { name: 'Israel' })
    expect(img.querySelectorAll('polygon')).toHaveLength(0)
    expect(img.querySelector('circle')).not.toBeNull()
  })

  it('GIVEN an "other" kind identity (dog, car, package) WHEN rendered THEN a plain un-eared square, not a cat silhouette', () => {
    // arrange / act
    render(<WhoMark identity={identityOf({ label: 'dog', person_name: null, person_names: null })} />)
    // assert
    const img = screen.getByRole('img', { name: 'Something else' })
    expect(img.querySelectorAll('polygon')).toHaveLength(0) // no ears
    expect(img.querySelector('circle')).toBeNull() // not a person
    expect(img.querySelector('rect')).not.toBeNull() // plain square
  })
})

describe('BrandMarkRow', () => {
  // Landscape pass Task 3: the brand trio (Home header, Login, People
  // header) swaps from the geometric eared-square glyph to the three
  // real cat-face photos — event-identity marks (above) keep the
  // geometric glyph since those must render an unknown subject.
  it('GIVEN the brand trio WHEN rendered THEN three real cat-face photos, one per named house cat', () => {
    // arrange / act
    render(<BrandMarkRow />)
    // assert
    const trio = screen.getByRole('img', { name: 'Panther, Mushu and Coco' })
    const imgs = trio.querySelectorAll('img')
    expect(imgs.length).toBe(3)
    expect(Array.from(imgs).map((i) => i.getAttribute('src'))).toEqual([
      '/cats/panther-face.png',
      '/cats/mushu-face.png',
      '/cats/coco-face.png',
    ])
  })
})
