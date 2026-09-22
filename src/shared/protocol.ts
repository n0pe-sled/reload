/**
 * Wire protocol of the `/dsh-reload/events` channel, shared by both halves of
 * this package. The frames still cross a real wire boundary, so the browser
 * half parses them as untrusted JSON; sharing the type keeps the two ends from
 * drifting, it does not make the parse trusted.
 */

/** One frame pushed to browser clients. */
export type ReloadEventFrame = {
  /** Frame kind. Only `reload` exists; the union leaves room without a breaking change. */
  type: 'reload'
  /** When the host broadcast this frame (epoch milliseconds), for logging. */
  at: number
}

/**
 * Endpoint of the reload channel (wire protocol constant).
 *
 * Deliberately not `/plugins/events`: that channel belongs to dsh-client-hmr,
 * whose browser half ignores frame types it does not know. A dedicated path
 * keeps this plugin working whether or not the HMR row is mounted.
 */
export const RELOAD_ENDPOINT = '/dsh-reload/events'
