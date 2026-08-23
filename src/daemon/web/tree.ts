import type { FileView } from './pages.js'

/**
 * The changed files of one source, as a tree.
 *
 * Paths arrive flat — `src/daemon/web/layout.ts` — so the structure has to be
 * derived. Deriving it is worth doing rather than listing paths: a tree shows
 * segment names, which are short, and a flat list shows whole paths, which are
 * the textbook case of a long token forcing either horizontal overflow or a
 * truncation that hides the part that identifies the file.
 */

export interface TreeFile {
  kind: 'file'
  /** The last segment, which is all a tree needs to show. */
  name: string
  file: FileView
}

export interface TreeDirectory {
  kind: 'directory'
  /** One or more segments: a run of directories with a single child collapses. */
  name: string
  children: TreeNode[]
  /** Files at or below this directory, for a count without walking twice. */
  fileCount: number
}

export type TreeNode = TreeFile | TreeDirectory

/**
 * Builds the tree, collapsing runs of directories that hold nothing else.
 *
 * `src/daemon/web/layout.ts` alone becomes one node reading `src/daemon/web`
 * rather than three nested ones, each indenting the next and none of them
 * telling the reader anything. Splitting only happens where the paths diverge,
 * which is where the structure is the point.
 */
export function buildTree(files: FileView[]): TreeNode[] {
  const root: Mutable = { children: new Map(), files: [] }

  for (const file of files) {
    const segments = file.path.split('/').filter((segment) => segment !== '')
    const name = segments.pop() ?? file.path

    let at = root
    for (const segment of segments) {
      let next = at.children.get(segment)
      if (!next) {
        next = { children: new Map(), files: [] }
        at.children.set(segment, next)
      }
      at = next
    }

    at.files.push({ kind: 'file', name, file })
  }

  return flatten(root)
}

interface Mutable {
  children: Map<string, Mutable>
  files: TreeFile[]
}

function flatten(node: Mutable): TreeNode[] {
  const directories: TreeNode[] = []

  for (const [name, child] of node.children) {
    directories.push(collapse(name, child))
  }

  // Directories first, then files, each alphabetically. The order files arrive
  // in is already sorted by path, which is not the same as sorted by segment
  // once the tree splits them up.
  directories.sort(byName)
  const files = [...node.files].sort(byName)

  return [...directories, ...files]
}

function collapse(name: string, node: Mutable): TreeDirectory {
  let path = name
  let at = node

  // A directory holding exactly one directory and no files of its own is not a
  // level worth drawing; it is a prefix of the level below it.
  while (at.files.length === 0 && at.children.size === 1) {
    const [childName, child] = [...at.children][0] as [string, Mutable]
    path = `${path}/${childName}`
    at = child
  }

  const children = flatten(at)

  return {
    kind: 'directory',
    name: path,
    children,
    fileCount: children.reduce(
      (total, child) => total + (child.kind === 'file' ? 1 : child.fileCount),
      0,
    ),
  }
}

function byName(one: { name: string }, other: { name: string }): number {
  return one.name.localeCompare(other.name)
}
