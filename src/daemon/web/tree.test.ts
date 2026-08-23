import { describe, expect, it } from 'vitest'
import type { FileView } from './pages.js'
import { buildTree, type TreeDirectory, type TreeNode } from './tree.js'

const at = (path: string): FileView => ({ path }) as FileView

/** A compact shape to assert against: "name" for a file, "name/[...]" for a directory. */
function outline(nodes: TreeNode[]): unknown[] {
  return nodes.map((node) =>
    node.kind === 'file' ? node.name : { [`${node.name}/`]: outline(node.children) },
  )
}

describe('building the tree', () => {
  it('nests files under the directories that hold them', () => {
    const tree = buildTree([at('src/a.ts'), at('src/b.ts'), at('README.md')])

    expect(outline(tree)).toEqual([{ 'src/': ['a.ts', 'b.ts'] }, 'README.md'])
  })

  // Three nested nodes each holding only the next tell the reader nothing and
  // indent the one node that matters three times.
  it('collapses a run of directories with a single child', () => {
    const tree = buildTree([at('src/daemon/web/layout.ts')])

    expect(outline(tree)).toEqual([{ 'src/daemon/web/': ['layout.ts'] }])
  })

  it('stops collapsing where the paths diverge', () => {
    const tree = buildTree([at('src/daemon/web/a.ts'), at('src/ctl/b.ts')])

    expect(outline(tree)).toEqual([
      { 'src/': [{ 'ctl/': ['b.ts'] }, { 'daemon/web/': ['a.ts'] }] },
    ])
  })

  it('does not collapse past a directory that holds a file of its own', () => {
    const tree = buildTree([at('src/index.ts'), at('src/web/page.ts')])

    expect(outline(tree)).toEqual([{ 'src/': [{ 'web/': ['page.ts'] }, 'index.ts'] }])
  })

  it('puts directories before files and sorts each by name', () => {
    const tree = buildTree([at('z.ts'), at('a.ts'), at('lib/one.ts'), at('bin/two.ts')])

    expect(outline(tree)).toEqual([
      { 'bin/': ['two.ts'] },
      { 'lib/': ['one.ts'] },
      'a.ts',
      'z.ts',
    ])
  })

  it('counts every file at or below a directory', () => {
    const tree = buildTree([at('src/a.ts'), at('src/web/b.ts'), at('src/web/deep/c.ts')])
    const src = tree[0] as TreeDirectory

    expect(src.fileCount).toBe(3)
    expect((src.children[0] as TreeDirectory).fileCount).toBe(2)
  })

  it('keeps a file at the root a file', () => {
    expect(outline(buildTree([at('LICENSE')]))).toEqual(['LICENSE'])
  })

  it('survives a path with a trailing or doubled separator', () => {
    expect(outline(buildTree([at('src//a.ts')]))).toEqual([{ 'src/': ['a.ts'] }])
  })

  it('has nothing to show for no files', () => {
    expect(buildTree([])).toEqual([])
  })
})
