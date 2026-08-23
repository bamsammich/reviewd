import { describe, expect, it } from 'vitest'
import { basenameOf, displayPath, homeRelative, shortenPath } from './paths.js'

describe('homeRelative', () => {
  it('replaces the home directory with the character people say', () => {
    expect(homeRelative('/Users/t/ghq/github.com/o/repo', '/Users/t')).toBe(
      '~/ghq/github.com/o/repo',
    )
  })

  it('shortens the home directory itself', () => {
    expect(homeRelative('/Users/t', '/Users/t')).toBe('~')
  })

  it('leaves a path outside home alone', () => {
    expect(homeRelative('/var/tmp/scratch', '/Users/t')).toBe('/var/tmp/scratch')
  })

  it('does not match a sibling directory that merely shares a prefix', () => {
    // /Users/travis-old is not inside /Users/travis.
    expect(homeRelative('/Users/travis-old/repo', '/Users/travis')).toBe('/Users/travis-old/repo')
  })

  it('leaves everything alone when home is unknown or the root', () => {
    expect(homeRelative('/a/b', undefined)).toBe('/a/b')
    expect(homeRelative('/a/b', '/')).toBe('/a/b')
  })
})

describe('shortenPath', () => {
  it('leaves a path that already fits', () => {
    expect(shortenPath('~/code/reviewd', 40)).toBe('~/code/reviewd')
  })

  it('keeps the end, which is the part that names the repository', () => {
    const short = shortenPath('/private/var/folders/hr/abcdefgh/T/tmp.XYZ/dotfiles', 40)

    expect(short).toContain('dotfiles')
    expect(short).toContain('…')
    expect(short.length).toBeLessThanOrEqual(40)
  })

  it('elides whole segments, since half a directory name reads as a typo', () => {
    const short = shortenPath('/a/bbbbbbbbbb/cccccccccc/dddddddddd/eeeeeeeeee/target', 30)

    for (const segment of short.split('/')) {
      expect(['a', '…', 'target', ''].includes(segment) || segment.length > 0).toBe(true)
    }
    expect(short.endsWith('target')).toBe(true)
  })

  it('gives up on a path too shallow to elide', () => {
    const path = '/averyveryverylongsinglesegmentnamethatcannotbeshortened'
    expect(shortenPath(path, 20)).toBe(path)
  })
})

describe('displayPath', () => {
  it('applies home first, then shortening', () => {
    const shown = displayPath('/Users/t/ghq/github.com/bamsammich/reviewd', '/Users/t', 30)

    expect(shown.startsWith('~')).toBe(true)
    expect(shown).toContain('reviewd')
  })
})

describe('basenameOf', () => {
  it('names a repository by its directory', () => {
    expect(basenameOf('/Users/t/ghq/github.com/o/reviewd')).toBe('reviewd')
  })

  it('ignores a trailing slash', () => {
    expect(basenameOf('/Users/t/code/thing/')).toBe('thing')
  })
})
