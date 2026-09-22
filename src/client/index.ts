/**
 * Browser half of dsh-reload: the piece that actually refreshes the page.
 *
 * Two ways in, one action:
 *
 * - The host's reload channel. A `reload` frame (sent by the `/reload` command)
 *   refreshes this page, so one command from the composer refreshes every open
 *   tab.
 * - The General settings row. The Reload button reloads the tab the user is
 *   looking at, with no round trip to the host.
 *
 * Two details worth knowing:
 *
 * - The latch. A reload does not stop this JavaScript; the page keeps running
 *   until navigation commits, so two frames in quick succession would queue
 *   two reloads. The latch collapses them into one.
 * - The channel reconnects by itself. EventSource retries after a drop, so a
 *   page that is open when the host restarts re-attaches on its own and can
 *   then be reloaded by a later `/reload`. A failed reconnect is expected
 *   while the host is down, so it is logged at debug level, not as an error.
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: carries the settings.general.item SlotMap entry this half registers into.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: carries ctx.slots and the slot prop types.
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { ReloadRow } from './ReloadRow.tsx'
import type { ReloadRowInjected } from './ReloadRow.tsx'
import { RELOAD_ENDPOINT } from '../shared/protocol.ts'
import type { ReloadEventFrame } from '../shared/protocol.ts'

export { RELOAD_ENDPOINT } from '../shared/protocol.ts'
export type { ReloadEventFrame } from '../shared/protocol.ts'
export type { ReloadRowInjected, ReloadRowProps } from './ReloadRow.tsx'

/** Cordis plugin name (same as the node half: one package, one row). */
export const name = 'reload'

/** Required services: the slot registry (the settings row). */
export const inject = ['slots']

/**
 * Open the reload channel for this page.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  /** Set once a reload is under way, so duplicate frames cannot queue another. */
  let reloading = false

  /**
   * Reload this page. Shared by the channel and the settings row, so both go
   * through the same latch: the first caller wins and later ones are no-ops.
   * The latch lives here and nowhere else — setting it at a call site as well
   * would make this guard reject the caller that just set it.
   */
  const reload = (): void => {
    if (reloading) return
    reloading = true
    // Plain reload: client bundles are served no-cache, so the browser
    // revalidates them and a rebuilt bundle is picked up. No cache-busting
    // query is needed, and adding one would litter the URL.
    window.location.reload()
  }

  const handle = (frame: ReloadEventFrame): void => {
    if (frame.type !== 'reload' || reloading) return
    ctx.logger.info(`reload: refreshing this page at the host's request (${String(frame.at)})`)
    reload()
  }

  ctx.effect(() => {
    const source = new EventSource(RELOAD_ENDPOINT)
    source.addEventListener('message', (event: MessageEvent<string>) => {
      let frame: ReloadEventFrame
      try {
        // Wire boundary: this payload is untrusted JSON like any other.
        frame = JSON.parse(event.data) as ReloadEventFrame
      } catch {
        ctx.logger.warn(`reload: unparseable frame: ${event.data}`)
        return
      }
      handle(frame)
    })
    source.addEventListener('error', () => {
      // EventSource reports the reconnect attempt itself; a host that is down
      // or restarting is the normal cause, so this stays quiet.
      ctx.logger.debug('reload: channel dropped, waiting to reconnect')
    })
    return () => { source.close() }
  }, 'reload: event source')

  // The General settings row. `slots.inject` tolerates the slot declaration
  // arriving later and cleans up with this fiber; a bare register at apply time
  // could run before the General section exists. Wrapped in ctx.effect so the
  // registration belongs to this plugin's fiber and unwinds with it.
  ctx.effect(() => ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item',
    id: 'reload',
    order: 30,
    inject: (): ReloadRowInjected => ({ reload }),
  }, ReloadRow)), 'reload: settings row')
}
