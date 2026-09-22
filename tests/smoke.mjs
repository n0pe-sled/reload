/**
 * Host-half smoke check for dsh-reload (no test framework): stubs the injected
 * services, calls apply(), and asserts the `/reload` registration plus the
 * reload channel's real behavior over HTTP — a connected page receives one
 * frame, and the same-origin fence and method gate refuse everything else.
 *
 * The channel is served from a real node:http server on loopback, and the
 * "browser" is a real fetch reading the SSE stream, because the interesting
 * failure modes here (a frame that never flushes, a fence that lets a
 * cross-origin page through) do not exist against a fake.
 *
 * Run with: node tests/smoke.mjs (after `pnpm build`; imports lib/index.js)
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { apply, name, inject, RELOAD_ENDPOINT } from '../lib/index.js'

/** Commands the plugin registered, in registration order. */
const registered = []
/** Route the plugin registered, captured so the server can serve it. */
let route = null
/** Teardown callbacks collected from ctx.effect, run at the end. */
const disposers = []

/** Run a ctx.effect body: a generator yields disposers, a function returns one. */
function runEffect(body) {
  const iterator = body()
  if (typeof iterator === 'function') {
    disposers.push(iterator)
    return
  }
  assert.ok(iterator != null && typeof iterator.next === 'function', 'effect must be a generator or function')
  for (const disposer of iterator) {
    if (typeof disposer === 'function') disposers.push(disposer)
  }
}

const logger = {
  info: () => {},
  warn: () => {},
  debug: () => {},
  error: () => {},
}

/** Minimal host context: effect + inject + logger + the command registry. */
const ctx = {
  logger,
  effect: runEffect,
  commands: {
    register(definition) {
      registered.push(definition)
      return () => {}
    },
  },
  inject(services, callback) {
    assert.deepEqual(services, ['webServer'])
    callback(ctx)
  },
  webServer: {
    register(definition) {
      route = definition
      return () => {}
    },
  },
}

assert.equal(name, 'reload')
assert.deepEqual(inject, ['commands'])

apply(ctx)

// --- registration ---------------------------------------------------------
assert.equal(registered.length, 1, 'exactly one command registers')
const command = registered[0]
assert.equal(command.name, 'reload')
assert.equal(typeof command.handler, 'function')
assert.ok(command.description.length > 0, 'description is non-empty')

assert.ok(route !== null, 'the channel route registered')
assert.equal(route.kind, 'exact')
assert.equal(route.path, RELOAD_ENDPOINT)

/** Invoke the command handler the way the registry does. */
const invoke = (rawInput) => command.handler({
  commandId: 'cmd-test',
  agent: {},
  rawInput,
  attachments: [],
  signal: new AbortController().signal,
})

// --- the command's own outcomes -------------------------------------------
assert.deepEqual(invoke(' now'), { kind: 'error', text: 'Usage: /reload (no arguments)' })

const disconnected = invoke('')
assert.equal(disconnected.kind, 'error', 'no connected page is reported, not silently swallowed')
assert.match(disconnected.text, /no dsh web page is connected/)
assert.match(disconnected.text, /restart of `dsh web`/, 'the host-half limit is stated in the failure')

// --- the channel over real HTTP -------------------------------------------
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://127.0.0.1').pathname
  if (path === RELOAD_ENDPOINT) {
    route.handler(req, res)
    return
  }
  res.writeHead(404)
  res.end()
})

await new Promise(resolve => { server.listen(0, '127.0.0.1', resolve) })
const port = server.address().port
const origin = `http://127.0.0.1:${port}`

try {
  // A page connects and reads the stream until it has one reload frame.
  const controller = new AbortController()
  const response = await fetch(`${origin}${RELOAD_ENDPOINT}`, { signal: controller.signal })
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /text\/event-stream/)
  assert.match(response.headers.get('cache-control'), /no-cache/)

  const frames = (async () => {
    const decoder = new TextDecoder()
    let buffer = ''
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true })
      const match = /^data: (.*)$/m.exec(buffer)
      if (match) return JSON.parse(match[1])
    }
    return null
  })()

  // Connected now: the command reports the page count and schedules the frame.
  const connected = invoke('')
  assert.equal(connected.kind, 'success', 'a connected page makes /reload succeed')
  assert.match(connected.text, /Reloading 1 open page\./)
  assert.match(connected.text, /restart of `dsh web`/)

  const frame = await frames
  assert.deepEqual(Object.keys(frame).sort(), ['at', 'type'])
  assert.equal(frame.type, 'reload')
  assert.equal(typeof frame.at, 'number')
  controller.abort()

  // --- fences --------------------------------------------------------------
  const post = await fetch(`${origin}${RELOAD_ENDPOINT}`, { method: 'POST' })
  assert.equal(post.status, 405, 'non-GET is refused')
  await post.text()

  const crossOrigin = await fetch(`${origin}${RELOAD_ENDPOINT}`, {
    headers: { origin: 'https://evil.example' },
  })
  assert.equal(crossOrigin.status, 403, 'a cross-origin page cannot open the channel')
  await crossOrigin.text()

  const sameOrigin = await fetch(`${origin}${RELOAD_ENDPOINT}`, {
    headers: { origin },
  })
  assert.equal(sameOrigin.status, 200, 'a same-origin page is allowed')
  assert.equal(sameOrigin.headers.get('content-type'), 'text/event-stream')
  await sameOrigin.body.cancel()

  // --- disconnect ----------------------------------------------------------
  // Give the closed channels a beat to be reaped, then confirm the count is honest.
  await new Promise(resolve => setTimeout(resolve, 50))
  const afterDisconnect = invoke('')
  assert.equal(afterDisconnect.kind, 'error', 'a closed page stops counting as connected')
  assert.match(afterDisconnect.text, /no dsh web page is connected/)
} finally {
  for (const dispose of disposers) dispose()
  await new Promise(resolve => { server.close(resolve) })
}

console.log('dsh-reload host smoke: ok')
