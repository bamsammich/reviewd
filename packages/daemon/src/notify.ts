import type { ResolvedConfig } from './config.js'

/**
 * Optional outbound notification, off unless a webhook is configured.
 *
 * One backend, because Pushover, Telegram, Slack, and ntfy are the same POST
 * with a different body. A template string covers the difference without the
 * daemon modelling any of them.
 */

export interface NotifyPayload {
  title: string
  /** Built from public_url, so it opens on the device that receives it. */
  url: string
  threadsAwaitingYou: number
}

export type Fetcher = (input: string, init: RequestInit) => Promise<Response>

/**
 * Sends a notification, swallowing failures.
 *
 * A push that does not arrive should never fail the snapshot that triggered it:
 * the review exists either way, and the agent already holds the link.
 */
export async function notify(
  config: ResolvedConfig,
  payload: NotifyPayload,
  fetcher: Fetcher = fetch,
  log: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): Promise<boolean> {
  const webhook = config.notify.webhook_url
  if (!webhook) return false

  const { body, contentType } = render(config.notify.template, payload)

  try {
    const response = await fetcher(webhook, {
      method: 'POST',
      headers: { 'content-type': contentType },
      body,
    })

    if (!response.ok) {
      log(`reviewd notify: ${webhook} answered ${response.status}`)
      return false
    }

    return true
  } catch (error) {
    log(`reviewd notify: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

/**
 * A template turns the payload into plain text, which is what ntfy and most
 * push bridges want. With no template the payload goes as JSON.
 */
export function render(
  template: string | null,
  payload: NotifyPayload,
): { body: string; contentType: string } {
  if (!template) {
    return {
      body: JSON.stringify({
        title: payload.title,
        url: payload.url,
        threads_awaiting_you: payload.threadsAwaitingYou,
      }),
      contentType: 'application/json',
    }
  }

  const body = template
    .replaceAll('{{title}}', payload.title)
    .replaceAll('{{url}}', payload.url)
    .replaceAll('{{threads}}', String(payload.threadsAwaitingYou))

  return { body, contentType: 'text/plain' }
}
