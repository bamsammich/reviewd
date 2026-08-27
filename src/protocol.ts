import { z } from 'zod'

/**
 * Wire contract shared by the daemon and the client.
 *
 * Every schema here is the single definition of a shape that crosses the
 * network. The daemon parses inbound bodies with it and the client parses
 * responses with it, so a drift between the two shows up as a test failure
 * rather than as a runtime surprise on someone's phone.
 */

// ---------------------------------------------------------------------------
// enums
// ---------------------------------------------------------------------------

export const reviewStatus = z.enum(['open', 'approved'])
export type ReviewStatus = z.infer<typeof reviewStatus>

export const threadState = z.enum(['active', 'resolved', 'outdated'])
export type ThreadState = z.infer<typeof threadState>

export const author = z.enum(['human', 'agent'])
export type Author = z.infer<typeof author>

/** Which role owes the next message. Derived from the last message, never stored. */
export const turn = z.enum(['human', 'agent'])
export type Turn = z.infer<typeof turn>

export const verdict = z.enum(['comment', 'changes_requested', 'approved'])
export type Verdict = z.infer<typeof verdict>

export const changeType = z.enum(['added', 'modified', 'deleted', 'renamed', 'binary'])
export type ChangeType = z.infer<typeof changeType>

export const side = z.enum(['old', 'new'])
export type Side = z.infer<typeof side>

export const vcs = z.enum(['git', 'none'])
export type Vcs = z.infer<typeof vcs>

// ---------------------------------------------------------------------------
// review creation
// ---------------------------------------------------------------------------

export const sourceSpec = z.object({
  /** Absolute path on the client machine. The daemon stores it and never resolves it. */
  path: z.string().min(1),
  /** HEAD, a branch, a sha, or omitted for a plain file set. */
  base: z.string().min(1).optional(),
  label: z.string().min(1).optional(),
})
export type SourceSpec = z.infer<typeof sourceSpec>

export const createReviewRequest = z.object({
  title: z.string().min(1),
  sources: z.array(sourceSpec).min(1),
  createdBy: z.string().default(''),
  notify: z.boolean().default(false),
})
export type CreateReviewRequest = z.infer<typeof createReviewRequest>

export const sourceSummary = z.object({
  id: z.string(),
  label: z.string(),
  rootPath: z.string(),
  vcs,
  baseRef: z.string().nullable(),
  approved: z.boolean(),
})
export type SourceSummary = z.infer<typeof sourceSummary>

export const reviewSummary = z.object({
  reviewId: z.string(),
  title: z.string(),
  status: reviewStatus,
  /** Always built from public_url. Clients never assemble this themselves. */
  url: z.string(),
  createdAt: z.number().int(),
  lastActivityAt: z.number().int(),
  ageSeconds: z.number().int(),
  snapshotSeq: z.number().int(),
  /**
   * Files in the current revision. Under git that is the changed files; a
   * source with no base to compare against puts its whole tree in a revision,
   * so this counts what a reviewer has to read rather than what moved.
   */
  fileCount: z.number().int(),
  threadsAwaitingAgent: z.number().int(),
  threadsAwaitingHuman: z.number().int(),
  /**
   * When the reviewer last submitted, or 0.
   *
   * The review page polls on this. Neither of the counts above can stand in
   * for it: a reviewer's own note makes it the agent's turn, so it moves the
   * agent count rather than the human one, and a second note on a thread that
   * was already the agent's moves neither. A page open in another browser saw
   * nothing until an agent happened to write.
   *
   * `lastActivityAt` cannot stand in for it either. Opening a review stamps
   * that, and the refresh is itself a GET on the page, so a page keyed on it
   * would refresh forever.
   */
  lastSubmissionAt: z.number().int(),
  sources: z.array(sourceSummary),
})
export type ReviewSummary = z.infer<typeof reviewSummary>

// ---------------------------------------------------------------------------
// snapshots
// ---------------------------------------------------------------------------

export const fileChangeSpec = z.object({
  sourceId: z.string(),
  path: z.string().min(1),
  changeType,
  oldPath: z.string().nullable().default(null),
  /**
   * The blob the daemon holds, or null when the bytes were not uploaded.
   *
   * Binary and oversize content is described rather than stored, so these are
   * null for it while the hashes below are not. Rendering follows the blob ids;
   * the approval follows the hashes.
   */
  oldBlobId: z.string().nullable().default(null),
  newBlobId: z.string().nullable().default(null),
  /**
   * sha256 of the content on each side, set whether or not the bytes were
   * uploaded. This is what the fingerprint is built from, so a file the
   * reviewer could not be shown still moves the approval when it changes.
   */
  oldHash: z.string().nullable().default(null),
  newHash: z.string().nullable().default(null),
  isBinary: z.boolean().default(false),
  truncated: z.boolean().default(false),
})
export type FileChangeSpec = z.infer<typeof fileChangeSpec>

/**
 * No fingerprint on the wire.
 *
 * The daemon derives it from these rows, because a fingerprint the client sends
 * is a claim about bytes rather than a fact about them: a client could upload
 * one change set for the reviewer to read and name the hash of a different one.
 */
export const snapshotManifest = z.object({
  files: z.array(fileChangeSpec),
})
export type SnapshotManifest = z.infer<typeof snapshotManifest>

export const snapshotResult = z.object({
  seq: z.number().int(),
  /** Files in this revision, on the same terms as `reviewSummary.fileCount`. */
  fileCount: z.number().int(),
  threadsMoved: z.number().int(),
  threadsOutdated: z.number().int(),
  url: z.string(),
})
export type SnapshotResult = z.infer<typeof snapshotResult>

/** Blob ids the daemon is missing, answered before an upload round. */
export const blobCheckRequest = z.object({ ids: z.array(z.string()) })
export const blobCheckResponse = z.object({ missing: z.array(z.string()) })

// ---------------------------------------------------------------------------
// threads
// ---------------------------------------------------------------------------

export const message = z.object({
  id: z.string(),
  seq: z.number().int(),
  author,
  body: z.string(),
  createdAt: z.number().int(),
  submittedAt: z.number().int().nullable(),
})
export type Message = z.infer<typeof message>

export const thread = z.object({
  id: z.string(),
  sourceId: z.string(),
  sourceLabel: z.string(),
  path: z.string(),
  side,
  line: z.number().int(),
  /** Last line of a range, or null when the comment is on one line. */
  endLine: z.number().int().nullable().default(null),
  state: threadState,
  origin: author,
  turn,
  drifted: z.boolean(),
  messages: z.array(message),
})
export type Thread = z.infer<typeof thread>

export const createThreadRequest = z
  .object({
    sourceId: z.string().optional(),
    path: z.string().min(1),
    line: z.number().int().positive(),
    /** Last line of a range. Omit for a comment on one line. */
    endLine: z.number().int().positive().optional(),
    side: side.default('new'),
    body: z.string().min(1),
  })
  // A range that ends before it starts is a caller mistake worth naming rather
  // than quietly reordering, and one that ends where it starts is one line.
  .refine((request) => request.endLine === undefined || request.endLine >= request.line, {
    message: 'endLine must not be before line',
    path: ['endLine'],
  })
/**
 * Authorship is not on the wire.
 *
 * It is decided by which route a message arrived on — the review page is the
 * reviewer, the API is the agent — so a caller cannot label its own words as
 * the other party's. On a tool whose job is recording what the human said,
 * a spoofable byline defeats the purpose.
 */
export type CreateThreadRequest = z.infer<typeof createThreadRequest> & { author: Author }

export const replyRequest = z.object({
  body: z.string().min(1),
})
export type ReplyRequest = z.infer<typeof replyRequest>

export const submitRequest = z.object({ verdict })
export type SubmitRequest = z.infer<typeof submitRequest>

export const submissionResult = z.object({
  submissionId: z.string(),
  verdict,
  messageCount: z.number().int(),
  submittedAt: z.number().int(),
})
export type SubmissionResult = z.infer<typeof submissionResult>

// ---------------------------------------------------------------------------
// gate
// ---------------------------------------------------------------------------

export const gateOpenThread = z.object({
  path: z.string(),
  line: z.number().int(),
  excerpt: z.string(),
})

export const gateRequest = z.object({
  root: z.string().min(1),
  fingerprint: z.string().min(1),
  /**
   * The tree this reading would commit, and the commit it would sit on.
   *
   * Both are what `reviewd observe` compares against afterwards, and both are
   * optional so an older client still gates. A gate call that carries neither
   * leaves the approval unable to answer what landed, which observe reports as
   * unknown rather than as clean.
   */
  tree: z.string().min(1).nullish(),
  head: z.string().min(1).nullish(),
})
export type GateRequest = z.infer<typeof gateRequest>

// ---------------------------------------------------------------------------
// observe
// ---------------------------------------------------------------------------

export const observeRequest = z.object({
  root: z.string().min(1),
  /** HEAD as it stands now, after whatever the command did. */
  head: z.string().min(1),
  /** The tree that HEAD records. */
  tree: z.string().min(1),
})
export type ObserveRequest = z.infer<typeof observeRequest>

/**
 * What the daemon can say about a commit after the fact.
 *
 * `ungated` is a commit no approval was consumed for: the gate never saw it.
 * `altered` is a commit the gate cleared whose tree is not the tree that was
 * approved, which is what a command editing files before committing produces.
 */
export const observeResponse = z.object({
  finding: z.enum(['clean', 'ungated', 'altered', 'unknown']),
  reason: z.string(),
  reviewUrl: z.string().nullable(),
})
export type ObserveResponse = z.infer<typeof observeResponse>

export const gateResponse = z.object({
  decision: z.enum(['allow', 'deny']),
  reason: z.string(),
  reviewUrl: z.string().nullable(),
  warnings: z.array(z.string()),
  openThreads: z.array(gateOpenThread),
})
export type GateResponse = z.infer<typeof gateResponse>

// ---------------------------------------------------------------------------
// wait
// ---------------------------------------------------------------------------

export const wakeReason = z.enum(['submission', 'released', 'timeout'])
export type WakeReason = z.infer<typeof wakeReason>

export const waitResult = z.object({
  wokeOn: wakeReason,
  verdict: verdict.nullable(),
  threadsAwaitingAgent: z.number().int(),
  url: z.string().nullable(),
})
export type WaitResult = z.infer<typeof waitResult>

/**
 * Exit codes for `reviewd wait`.
 *
 * A verdict is not a failure. These used to carry the verdict itself — 2 for
 * changes requested, 3 for released — and every harness that runs a command in
 * the background reads a non-zero exit as something having gone wrong. Asking
 * for changes reported itself as a broken command, which is both alarming and
 * untrue.
 *
 * So any answer at all exits 0 and the verdict goes to stdout, which is where
 * the caller was reading it from anyway. Non-zero now means what it means
 * everywhere else: the command could not do its job.
 */
export const WAIT_EXIT = {
  /** A verdict arrived. Which one is the first line of stdout. */
  answered: 0,
  /** Nobody answered before the deadline. */
  timeout: 124,
  /** The daemon could not be reached, or the review is not there. */
  failed: 1,
} as const

// ---------------------------------------------------------------------------
// misc
// ---------------------------------------------------------------------------

export const releaseRequest = z.object({ force: z.boolean().default(false) })

export const releaseResult = z.object({
  released: z.boolean(),
  reason: z.string().optional(),
})
export type ReleaseResult = z.infer<typeof releaseResult>

/**
 * What the daemon can actually do.
 *
 * `openInEditor` and `fileWatch` were here and were both answered `true`
 * whenever the daemon shared a disk with the code. Neither existed: there is no
 * watcher, no watcher dependency, and no editor-opening code anywhere. A client
 * written against that contract would build a feature that silently did
 * nothing, which is worse than the feature being absent.
 *
 * Anything added back here has to be something the daemon does.
 */
export const capabilities = z.object({
  version: z.string(),
  /** True when the daemon shares a filesystem with the reviewed code. */
  local: z.boolean(),
})
export type Capabilities = z.infer<typeof capabilities>
