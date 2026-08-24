import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Proof that a request came from a rendered review page.
 *
 * The daemon holds no credentials and cannot tell a reviewer from an agent by
 * asking, since both reach it over loopback as the same user. What it can do is
 * refuse anything that did not come from a page it drew: the token below is
 * minted into every form and nowhere else, so acting on a review without
 * opening it means scraping the UI on purpose rather than calling an endpoint.
 *
 * This replaces `Origin` as the thing that actually decides. An origin header
 * answers a weaker question — the browser's word about where a request began —
 * and it is missing or opaque often enough to be unreliable: an in-app webview
 * sends `Origin: null`, and refusing that locked a reviewer out of commenting
 * from their phone while telling them their origin was malformed.
 *
 * This is a real boundary and a modest one. An agent that reads the page can
 * still take a token, and nothing here changes that; the point is that acting
 * on a review stops being a documented call.
 *
 * The key lives in memory and dies with the process. Writing it down would put
 * it in a file the agent can read, which is the thing being avoided, and a
 * restart costing an open page a reload is a fair price.
 */

const KEY = randomBytes(32)

/** Long enough that a page left open over lunch still works. */
const TTL_MS = 12 * 60 * 60 * 1000

function sign(payload: string): string {
  return createHmac('sha256', KEY).update(payload).digest('base64url')
}

/**
 * A token for one review at one revision.
 *
 * The revision travels inside the token rather than being looked up, because
 * the two kinds of request want different things from it. A comment stays valid
 * across a new snapshot — the reviewer is mid-sentence and their words should
 * survive the agent pushing again. A verdict does not: approving code the
 * reviewer never saw is the thing the gate exists to prevent.
 */
export function mintPageToken(reviewId: string, snapshotSeq: number, issuedAt: number): string {
  return `${issuedAt}.${snapshotSeq}.${sign(`${reviewId}:${snapshotSeq}:${issuedAt}`)}`
}

/**
 * Checks a token and reports which revision it was minted against.
 *
 * Returns null when the token is absent, malformed, expired, forged, or was
 * minted for a different review. Callers that care about the revision compare
 * the number themselves, so the reason for a refusal stays theirs to word.
 */
export function readPageToken(
  token: string | undefined,
  reviewId: string,
  now: number,
): { snapshotSeq: number } | null {
  if (!token) return null

  const parts = token.split('.')
  if (parts.length !== 3) return null

  const issuedAt = Number(parts[0])
  const snapshotSeq = Number(parts[1])
  if (!Number.isInteger(issuedAt) || !Number.isInteger(snapshotSeq)) return null

  // A future timestamp would extend the lifetime of a token forever, so a small
  // allowance for clock skew is the most it gets.
  if (now - issuedAt > TTL_MS || issuedAt > now + 60_000) return null

  const expected = Buffer.from(sign(`${reviewId}:${snapshotSeq}:${issuedAt}`))
  const actual = Buffer.from(parts[2] as string)

  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null

  return { snapshotSeq }
}
