import { EventEmitter } from 'node:events'
import type { Verdict } from '../protocol.js'

/**
 * In-process notification for the long-poll behind `reviewd wait`.
 *
 * One daemon process holds every connection, so an EventEmitter is the whole
 * mechanism. The indirection is here to keep the wait handler out of the web
 * layer's connection list, not as a seam for another transport.
 */

export type ReviewEvent =
  | { kind: 'submission'; reviewId: string; verdict: Verdict; at: number }
  | { kind: 'released'; reviewId: string; at: number }
  // One agent message, published as it lands rather than batched like a
  // submission. The reviewer is a person looking at a page, and making them
  // wait for a batch that will never come is how the page went stale.
  | { kind: 'thread'; reviewId: string; threadId: string; at: number }

export class Bus {
  private readonly emitter = new EventEmitter()

  constructor() {
    // A wait per review plus a few browsers is well under Node's default of
    // ten, but a busy day should not print a leak warning at a reviewer.
    this.emitter.setMaxListeners(0)
  }

  publish(event: ReviewEvent): void {
    this.emitter.emit(event.reviewId, event)
  }

  /** Resolves on the first event for this review, or on timeout. */
  wait(reviewId: string, timeoutMs: number, signal?: AbortSignal): Promise<ReviewEvent | null> {
    return new Promise((resolve) => {
      const done = (event: ReviewEvent | null): void => {
        clearTimeout(timer)
        this.emitter.off(reviewId, onEvent)
        signal?.removeEventListener('abort', onAbort)
        resolve(event)
      }

      const onEvent = (event: ReviewEvent): void => done(event)
      const onAbort = (): void => done(null)

      const timer = setTimeout(() => done(null), timeoutMs)
      // A held-open request should never keep the process alive on its own.
      timer.unref?.()

      this.emitter.on(reviewId, onEvent)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }
}
