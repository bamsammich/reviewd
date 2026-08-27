import {
  blobCheckResponse,
  gateResponse,
  observeResponse,
  releaseResult,
  reviewSummary,
  snapshotResult,
  submissionResult,
  thread as threadSchema,
  waitResult,
  type CreateReviewRequest,
  type CreateThreadRequest,
  type GateResponse,
  type ObserveResponse,
  type ReleaseResult,
  type ReviewSummary,
  type SnapshotManifest,
  type SnapshotResult,
  type SubmissionResult,
  type Thread,
  type Verdict,
  type WaitResult,
} from '../protocol.js'
import type { z } from 'zod'

/**
 * HTTP client for the daemon.
 *
 * Responses are parsed with the same schemas the daemon validates against, so
 * a drift between the two shows up here rather than as a confusing shape three
 * layers later.
 */
export class ClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'ClientError'
  }
}

export class Client {
  constructor(
    private readonly baseUrl: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async health(): Promise<boolean> {
    try {
      return (await this.fetcher(`${this.baseUrl}/api/health`)).ok
    } catch {
      return false
    }
  }

  createReview(request: CreateReviewRequest): Promise<ReviewSummary> {
    return this.json('POST', '/api/reviews', reviewSummary, request)
  }

  getReview(reviewId: string): Promise<ReviewSummary> {
    return this.json('GET', `/api/reviews/${reviewId}`, reviewSummary)
  }

  listReviews(query: { status?: string; root?: string } = {}): Promise<ReviewSummary[]> {
    const params = new URLSearchParams()
    if (query.status) params.set('status', query.status)
    if (query.root) params.set('root', query.root)

    return this.json('GET', `/api/reviews?${params.toString()}`, reviewSummary.array())
  }

  async missingBlobs(reviewId: string, ids: string[]): Promise<string[]> {
    const result = await this.json(
      'POST',
      `/api/reviews/${reviewId}/blobs/check`,
      blobCheckResponse,
      { ids },
    )
    return result.missing
  }

  async putBlob(id: string, bytes: Uint8Array): Promise<void> {
    const response = await this.fetcher(`${this.baseUrl}/api/blobs/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      // A Uint8Array is a valid fetch body. Node's BodyInit type is narrower
      // than the runtime accepts, so a Blob keeps the types honest.
      body: new Blob([bytes]),
    })

    if (!response.ok) {
      throw new ClientError(await describe(response), response.status)
    }
  }

  snapshot(reviewId: string, manifest: SnapshotManifest): Promise<SnapshotResult> {
    return this.json('POST', `/api/reviews/${reviewId}/snapshots`, snapshotResult, manifest)
  }

  listThreads(
    reviewId: string,
    query: { state?: string; turn?: string; drafts?: boolean } = {},
  ): Promise<Thread[]> {
    const params = new URLSearchParams()
    if (query.state) params.set('state', query.state)
    if (query.turn) params.set('turn', query.turn)
    if (query.drafts) params.set('drafts', 'true')

    return this.json(
      'GET',
      `/api/reviews/${reviewId}/threads?${params.toString()}`,
      threadSchema.array(),
    )
  }

  async createThread(
    reviewId: string,
    request: CreateThreadRequest,
  ): Promise<{ threadId: string }> {
    return (await this.jsonLoose('POST', `/api/reviews/${reviewId}/threads`, request)) as {
      threadId: string
    }
  }

  // No author here. This client reaches the daemon over the API, and the API
  // route is the agent, so anything it sends is signed as the agent whatever it
  // asks for. A parameter used to say otherwise and was stripped off the wire
  // in silence, which is worse than not offering the choice at all.
  reply(threadId: string, body: string): Promise<unknown> {
    return this.jsonLoose('POST', `/api/threads/${threadId}/replies`, { body })
  }

  setThreadState(threadId: string, state: string, note?: string): Promise<unknown> {
    return this.jsonLoose('PUT', `/api/threads/${threadId}/state`, { state, note })
  }

  submit(reviewId: string, verdict: Verdict): Promise<SubmissionResult> {
    return this.json('POST', `/api/reviews/${reviewId}/submissions`, submissionResult, { verdict })
  }

  release(reviewId: string, force = false): Promise<ReleaseResult> {
    return this.jsonAllowing(
      'POST',
      `/api/reviews/${reviewId}/release`,
      releaseResult,
      { force },
      [409],
    )
  }

  gate(
    root: string,
    fingerprint: string,
    tree: string | null = null,
    head: string | null = null,
  ): Promise<GateResponse> {
    return this.json('POST', '/api/gate', gateResponse, { root, fingerprint, tree, head })
  }

  observe(root: string, head: string, tree: string): Promise<ObserveResponse> {
    return this.json('POST', '/api/observe', observeResponse, { root, head, tree })
  }

  wait(reviewId: string, timeoutMs: number, since = 0): Promise<WaitResult> {
    const params = new URLSearchParams({
      timeout_ms: String(timeoutMs),
      since: String(since),
    })
    return this.json('GET', `/api/reviews/${reviewId}/wait?${params.toString()}`, waitResult)
  }

  // -------------------------------------------------------------------------

  private async json<T>(
    method: string,
    path: string,
    schema: z.ZodType<T>,
    body?: unknown,
  ): Promise<T> {
    return this.jsonAllowing(method, path, schema, body, [])
  }

  private async jsonAllowing<T>(
    method: string,
    path: string,
    schema: z.ZodType<T>,
    body: unknown,
    allowedErrorCodes: number[],
  ): Promise<T> {
    const response = await this.request(method, path, body)

    if (!response.ok && !allowedErrorCodes.includes(response.status)) {
      throw new ClientError(await describe(response), response.status)
    }

    const parsed = schema.safeParse(await response.json())
    if (!parsed.success) {
      throw new ClientError(
        `reviewd answered ${path} with an unexpected shape: ${parsed.error.issues[0]?.message ?? ''}`,
        response.status,
      )
    }

    return parsed.data
  }

  /** For endpoints whose response shape is small enough to not be worth a schema. */
  private async jsonLoose(method: string, path: string, body?: unknown): Promise<unknown> {
    const response = await this.request(method, path, body)
    if (!response.ok) throw new ClientError(await describe(response), response.status)
    return response.json()
  }

  private request(method: string, path: string, body?: unknown): Promise<Response> {
    return this.fetcher(`${this.baseUrl}${path}`, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    })
  }
}

async function describe(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string }
    if (body.error) return body.error
  } catch {
    // Fall through to the status line.
  }
  return `reviewd answered ${response.status}`
}
