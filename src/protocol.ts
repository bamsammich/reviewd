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
  includeUntracked: z.boolean().default(true),
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
  filesChanged: z.number().int(),
  threadsAwaitingAgent: z.number().int(),
  threadsAwaitingHuman: z.number().int(),
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
  oldBlobId: z.string().nullable().default(null),
  newBlobId: z.string().nullable().default(null),
  isBinary: z.boolean().default(false),
  truncated: z.boolean().default(false),
})
export type FileChangeSpec = z.infer<typeof fileChangeSpec>

export const snapshotManifest = z.object({
  /** sha256 over the whole normalized change set, computed client-side. */
  fingerprints: z.record(z.string(), z.string()),
  files: z.array(fileChangeSpec),
})
export type SnapshotManifest = z.infer<typeof snapshotManifest>

export const snapshotResult = z.object({
  seq: z.number().int(),
  filesChanged: z.number().int(),
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
  anchorLine: z.string(),
  state: threadState,
  origin: author,
  turn,
  drifted: z.boolean(),
  messages: z.array(message),
})
export type Thread = z.infer<typeof thread>

export const createThreadRequest = z.object({
  sourceId: z.string().optional(),
  path: z.string().min(1),
  line: z.number().int().positive(),
  side: side.default('new'),
  body: z.string().min(1),
  author: author.default('agent'),
})
export type CreateThreadRequest = z.infer<typeof createThreadRequest>

export const replyRequest = z.object({
  body: z.string().min(1),
  author: author.default('agent'),
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
 * Exit codes for `reviewd wait`. The harness reads these instead of parsing
 * output, so the agent knows the verdict before reading a byte.
 */
export const WAIT_EXIT = {
  approved: 0,
  changesRequested: 2,
  gone: 3,
  timeout: 124,
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

export const capabilities = z.object({
  version: z.string(),
  /** True when the daemon shares a filesystem with the reviewed code. */
  local: z.boolean(),
  openInEditor: z.boolean(),
  fileWatch: z.boolean(),
})
export type Capabilities = z.infer<typeof capabilities>
