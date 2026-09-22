/**
 * Host (Node) half of dsh-reload.
 *
 * Registers the `/reload` slash command and serves the SSE channel that
 * carries the reload instruction to the browser.
 *
 * The command itself cannot refresh a page: it runs here, in the host process,
 * and the pages live in browsers. So the handler's whole job is to push a
 * frame down the open channel; the browser half does the reloading. That split
 * also means `/reload` refreshes EVERY open page, which is the intended
 * behavior for a plugin-change refresh (several tabs, one rebuild).
 *
 * What a browser refresh does and does not pick up:
 *
 * - Client plugin bundles: yes. They are served `cache-control: no-cache` and
 *   the boot graph is re-fetched on load, so a rebuilt `lib/client.js` or a
 *   newly rostered plugin appears.
 * - Host (node) half of a plugin: no. That code runs in the already-running
 *   process; only restarting `dsh web` loads it. `/reload` says so rather than
 *   pretending otherwise.
 *
 * The channel is a control channel, so it is fenced to same-origin GETs: a
 * page on another origin must not be able to make an open dsh tab reload.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: carries the ctx.commands Context merge and the CommandResult union.
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
// Type-only: carries the ctx.webServer Context merge.
import type {} from '@deepseek-ai/dsh-host-webserver'
import { RELOAD_ENDPOINT } from './shared/protocol.ts'
import type { ReloadEventFrame } from './shared/protocol.ts'

export { RELOAD_ENDPOINT } from './shared/protocol.ts'
export type { ReloadEventFrame } from './shared/protocol.ts'

/** Cordis plugin name. */
export const name = 'reload'

/** Required service: the human-command registry. */
export const inject = ['commands']

/**
 * Wait this long after answering the command before pushing the frame, so the
 * `command/done` result renders in the conversation before the page goes away.
 * Long enough for one paint, short enough to still feel immediate.
 */
const RELOAD_DELAY_MS = 400

/** Reject anything but a same-origin page loading the channel. */
function isSameOriginRequest(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  // EventSource sends Origin. A missing one (curl, a test client) is not a
  // cross-site page, and the endpoint is already loopback-bound in a default
  // deployment, so only a PRESENT mismatching Origin is refused.
  if (origin === undefined) return true
  const host = req.headers.host
  if (host === undefined) return false
  let originHost: string
  try {
    originHost = new URL(origin).host
  } catch {
    return false
  }
  return originHost === host
}

/** Serialize one frame as an SSE data line. */
function sseData(frame: ReloadEventFrame): string {
  return `data: ${JSON.stringify(frame)}\n\n`
}

/**
 * Register `/reload` and mount the reload channel.
 * @param ctx - host plugin context carrying the command registry, and the web
 *   server once it is available.
 */
export function apply(ctx: Context): void {
  /** Responses currently holding an open SSE channel, one per browser tab. */
  const channels = new Set<ServerResponse>()
  /** Pending broadcast timers, so teardown leaves none running. */
  const timers = new Set<NodeJS.Timeout>()

  /**
   * Push one reload frame to every connected page.
   * @returns how many pages were told to reload.
   */
  const broadcast = (): number => {
    const frame = sseData({ type: 'reload', at: Date.now() })
    let delivered = 0
    for (const res of channels) {
      if (res.writableEnded || res.destroyed) continue
      try {
        res.write(frame)
        delivered += 1
      } catch (error) {
        // A channel that dies mid-write is normal (tab closed, network gone);
        // its own 'close' handler removes it. Log at debug level only.
        ctx.logger.debug(`reload: dropping a channel that failed to write: ${String(error)}`)
        channels.delete(res)
      }
    }
    return delivered
  }

  /** Answer `/reload`: push the frame after a beat so the result renders first. */
  const handleReload = (invocation: CommandInvocation): CommandResult => {
    if (invocation.rawInput.trim().length > 0) {
      return { kind: 'error', text: 'Usage: /reload (no arguments)' }
    }
    if (channels.size === 0) {
      return {
        kind: 'error',
        text: 'Nothing to reload: no dsh web page is connected to this host. '
          + 'A host-side plugin change needs a restart of `dsh web`; a browser refresh cannot load it.',
      }
    }
    const pages = channels.size
    const timer = setTimeout(() => {
      timers.delete(timer)
      const delivered = broadcast()
      ctx.logger.info(`reload: refreshed ${String(delivered)} of ${String(pages)} connected page(s)`)
    }, RELOAD_DELAY_MS)
    timers.add(timer)
    return {
      kind: 'success',
      text: `Reloading ${String(pages)} open page${pages === 1 ? '' : 's'}. `
        + 'Host-side plugin changes still need a restart of `dsh web`.',
    }
  }

  ctx.effect(function* () {
    yield ctx.commands.register({
      name: 'reload',
      description: 'Reload every open dsh web page so it picks up rebuilt client plugins',
      handler: handleReload,
    })
  }, 'reload: /reload command')

  // The channel needs the web server, which the web profile mounts. A
  // non-browser profile (CLI-only) still gets the command; it just reports
  // that no page is connected.
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      const disposeRoute = webCtx.webServer.register({
        kind: 'exact',
        path: RELOAD_ENDPOINT,
        handler: (req, res) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.writeHead(405)
            res.end()
            return
          }
          if (!isSameOriginRequest(req)) {
            res.writeHead(403)
            res.end('forbidden')
            return
          }
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            'connection': 'keep-alive',
          })
          // A comment line on open, so a client and any proxy between see a
          // live channel even when no reload is ever requested. EventSource
          // frame parsing skips it.
          res.write(': connected\n\n')
          channels.add(res)
          res.on('close', () => { channels.delete(res) })
        },
      })
      return () => {
        disposeRoute()
        for (const timer of timers) clearTimeout(timer)
        timers.clear()
        for (const res of channels) res.destroy()
        channels.clear()
      }
    }, 'reload: channel route')
  })
}
