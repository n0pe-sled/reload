/**
 * Integration check for dsh-reload against the REAL services (no test
 * framework): a genuine cordis Context with the real command registry
 * (@deepseek-ai/dsh-commands) and the real web server plugin
 * (@deepseek-ai/dsh-host-webserver) listening on a loopback port.
 *
 * The smoke test stubs both services to assert the plugin's own contract. This
 * one asserts the thing the smoke test cannot: that `/reload`, resolved and
 * executed through the actual registry, pushes a frame down a channel served
 * by the actual web server. That is the whole feature, so it is worth the real
 * dependency.
 *
 * The web server binds port 0 (an OS-assigned port), never the port the
 * running GUI uses, so nothing here touches the instance in use.
 *
 * Run with: node tests/integration-real.mjs (after `pnpm build`)
 */

import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
// Both packages export their plugin as the DEFAULT export; the namespace object
// is not itself a plugin.
import webserver from '@deepseek-ai/dsh-host-webserver'
import commands from '@deepseek-ai/dsh-commands'
import * as plugin from '../lib/index.js'

const { RELOAD_ENDPOINT } = plugin

/** Read one SSE `data:` frame from a streaming response, or null at EOF. */
async function readFrame(response) {
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true })
    const match = /^data: (.*)$/m.exec(buffer)
    if (match) return JSON.parse(match[1])
  }
  return null
}

/** A session stub: the registry appends `command/run` and `command/done` to it. */
const session = { append: () => ({}) }

const ctx = new Context()
let controller
let serverFiber

try {
  // Keep the web server's fiber: disposing it runs the plugin's own unload
  // effects, which close the listening socket. Without that the process hangs
  // after a passing test.
  serverFiber = await ctx.plugin(webserver, { host: '127.0.0.1', port: 0 })
  const server = ctx.webServer
  await ctx.plugin(commands)
  await ctx.plugin(plugin)

  const port = server.port
  assert.ok(Number.isInteger(port) && port > 0, 'the web server is listening on a real port')
  const origin = `http://127.0.0.1:${port}`

  // A page opens the channel.
  controller = new AbortController()
  const response = await fetch(`${origin}${RELOAD_ENDPOINT}`, { signal: controller.signal })
  assert.equal(response.status, 200, 'the channel route is served by the real web server')
  assert.match(response.headers.get('content-type'), /text\/event-stream/)

  const framePromise = readFrame(response)

  // `/reload` runs through the real registry, exactly as the UI dispatches it.
  const executed = await ctx.commands.execute({ session }, '/reload', [], new AbortController().signal)
  assert.ok(executed !== undefined, 'the registry resolved /reload')
  assert.equal(executed.result.kind, 'success', `expected success, got: ${JSON.stringify(executed.result)}`)
  assert.match(executed.result.text, /Reloading 1 open page\./)

  const frame = await framePromise
  assert.equal(frame.type, 'reload', 'the connected page received the reload frame')
  assert.equal(typeof frame.at, 'number')
  controller.abort()
  controller = undefined

  console.log(`dsh-reload real-service integration: ok (port ${port})`)
} finally {
  controller?.abort()
  // Disposing the web server's fiber runs its unload effects, which close the
  // listening socket. The service exposes no dispose() of its own, so the fiber
  // is the only handle that does this.
  await serverFiber?.dispose()
}
