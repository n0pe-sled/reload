/**
 * End-to-end check for dsh-reload: the REAL host half, the REAL built client
 * bundle, and a REAL browser, wired the way the harness wires them.
 *
 * - Host: a genuine cordis Context with the real command registry and the real
 *   web server plugin, on port 0 (never the port the running GUI uses).
 * - Page: served from that same origin through the web server's fallback seat,
 *   so the bundle's channel URL resolves to the plugin's real route with no
 *   proxy and no rewriting.
 * - Browser: Chromium loads the built `lib/client.js` through a stand-in
 *   `window.__ModuleLoader__` (the real one exists only inside the GUI shell),
 *   materializes it, and applies it with a minimal client context. The
 *   subscribing and the reloading are the plugin's own code; nothing here
 *   reimplements the browser half.
 * - Trigger: an HTTP POST that dispatches `/reload` through the real registry,
 *   which is the path the composer's slash command takes.
 *
 * The assertion is the feature: after `/reload`, the page really navigates, the
 * navigation follows the plugin's own "refreshing this page" log line, and two
 * frames in quick succession still produce one navigation (the latch).
 *
 * Ordering note, and the bug this test caught the first time: the plugin must
 * be loaded BEFORE the page connects. An EventSource that reaches a route which
 * does not exist yet gets a 404 and backs off for seconds, so a page that
 * connects too early looks connected to nobody.
 *
 * Needs a Chromium build matching the installed Playwright; without one the
 * test SKIPS rather than failing, because a browser is a test dependency, not a
 * product one.
 *
 * Run with: node tests/e2e-browser.mjs (after `pnpm build`)
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import webserver from '@deepseek-ai/dsh-host-webserver'
import commands from '@deepseek-ai/dsh-commands'
import { chromium } from 'playwright'
import * as plugin from '../lib/index.js'

const BUNDLE = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8')

/**
 * React for the page, built from the installed packages: the UMD global build,
 * plus the CommonJS jsx-runtime wrapped in the two lines of CJS preamble it
 * needs. The real shell supplies these through its module table; the test page
 * has no module table, so it gets them as globals the require shim hands back.
 */
const REACT_SHIM = [
  readFileSync(fileURLToPath(new URL('../node_modules/react/umd/react.development.js', import.meta.url)), 'utf8'),
  ';window.React = React;',
  ';(function(){ var module = { exports: {} }; var exports = module.exports;',
  readFileSync(fileURLToPath(new URL('../node_modules/react/cjs/react-jsx-runtime.development.js', import.meta.url)), 'utf8'),
  ';window.ReactJSXRuntime = module.exports; })();',
].join('\n')

/**
 * The page: a module-loader stand-in, the real bundle, a minimal client
 * context. `window.location.reload` is NOT stubbed — it cannot be, it is
 * non-configurable — so the test asserts on the navigation itself.
 */
const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>dsh-reload e2e</title></head>
<body>
<script src="/react.js"></script>
<script>
  window.__dshTest = { registered: [], errors: [], applied: false, logs: [], slotEntries: [] }
  // Stand-in for the shell's loader: registering is all a bundle script does.
  window.__ModuleLoader__ = {
    load: ({ id, factory }) => { window.__dshTest.registered.push({ id, factory }) },
  }
</script>
<script src="/client.js"></script>
<script>
  ;(async () => {
    const registered = window.__dshTest.registered[0]
    if (registered === undefined) {
      window.__dshTest.errors.push('the bundle registered no factory')
      return
    }
    if (registered.id !== 'dsh-reload') {
      window.__dshTest.errors.push('unexpected bundle id: ' + registered.id)
    }
    const ctx = {
      logger: {
        // The log line the plugin writes just before reloading is the evidence
        // that the plugin, not something else, caused the navigation. It has to
        // survive the navigation, so it goes to sessionStorage as well.
        info: (message) => {
          window.__dshTest.logs.push('info: ' + message)
          if (message.startsWith('reload:')) sessionStorage.setItem('dshTestReloadLog', message)
        },
        warn: (message) => { window.__dshTest.logs.push('warn: ' + message) },
        debug: (message) => { window.__dshTest.logs.push('debug: ' + message) },
        error: (message) => { window.__dshTest.logs.push('error: ' + message) },
      },
      effect: (body) => { const dispose = body(); if (typeof dispose === 'function') dispose },
      // Stand-in for the slot registry: the plugin registers its General
      // settings row here, and the test records what it registered.
      slots: {
        inject: (slot, register) => {
          window.__dshTest.slotEntries.push({ slot, entry: register() })
        },
        register: (options, component) => {
          window.__dshTest.slotEntries.push({ options, component })
          return () => {}
        },
      },
    }
    try {
      // Materialize the factory as the loader does. The bundle's only runtime
      // externals are React and its jsx runtime, which the real module table
      // supplies; the shim serves them from the page's own React build.
      const exports = registered.factory((specifier) => {
        if (specifier === 'react') return window.React
        if (specifier === 'react/jsx-runtime') return window.ReactJSXRuntime
        throw new Error('unexpected require: ' + specifier)
      })
      exports.apply(ctx)
      window.__dshTest.applied = true
    } catch (error) {
      window.__dshTest.errors.push(String((error && error.message) || error))
    }
  })()
</script>
</body></html>`

/** A session stub: the registry appends `command/run` and `command/done` to it. */
const session = { append: () => ({}) }

/** Dispatch /reload through the real registry, as the composer does. */
async function fireReload() {
  const executed = await ctx.commands.execute({ session }, '/reload', [], new AbortController().signal)
  return executed?.result ?? null
}

const ctx = new Context()
let browser
let gui

try {
  try {
    browser = await chromium.launch()
  } catch (error) {
    console.log(`dsh-reload browser e2e: SKIPPED (no Chromium for playwright: ${String(error.message).split('\n')[0]})`)
    process.exit(0)
  }

  await ctx.plugin(webserver, { host: '127.0.0.1', port: 0 })
  gui = ctx.webServer
  const origin = `http://127.0.0.1:${gui.port}`

  // The page and the trigger live on the fallback seat, which the plugin's own
  // exact route takes precedence over.
  gui.registerFallback((req, res) => {
    if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(PAGE)
      return
    }
    if (req.url === '/client.js') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' })
      res.end(BUNDLE)
      return
    }
    if (req.url === '/react.js') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' })
      res.end(REACT_SHIM)
      return
    }
    if (req.url === '/fire' && req.method === 'POST') {
      fireReload()
        .then((result) => {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify(result))
        })
        .catch((error) => {
          res.writeHead(500)
          res.end(String(error))
        })
      return
    }
    if (req.url === '/fire-twice' && req.method === 'POST') {
      // Two commands in the same tick: two frames, and the latch must collapse
      // them into one navigation.
      Promise.all([fireReload(), fireReload()])
        .then((results) => {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify(results))
        })
        .catch((error) => {
          res.writeHead(500)
          res.end(String(error))
        })
      return
    }
    res.writeHead(404)
    res.end()
  })

  // Load the plugin BEFORE any page connects: the channel route must exist when
  // the browser's EventSource first reaches for it.
  await ctx.plugin(commands)
  await ctx.plugin(plugin)

  const page = await browser.newPage()
  const navigations = []
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) navigations.push(frame.url())
  })

  await page.goto(origin, { waitUntil: 'load' })
  await page.waitForFunction(() => window.__dshTest?.applied === true, null, { timeout: 5000 })

  // The browser normalizes the bare origin to a trailing slash; compare against
  // whatever the first navigation settled on.
  const settledUrl = navigations[0]
  assert.ok(settledUrl !== undefined, 'the initial navigation is recorded')

  const initial = await page.evaluate(() => ({ errors: window.__dshTest.errors, logs: window.__dshTest.logs }))
  assert.deepEqual(initial.errors, [], 'the bundle applied with no errors')
  assert.equal(navigations.length, 1, 'no navigation before /reload')

  // The General settings row is registered, into the right slot, with an id.
  const slotEntries = await page.evaluate(() => window.__dshTest.slotEntries.map(entry => ({
    slot: entry.slot,
    options: entry.options === undefined
      ? undefined
      : { id: entry.options.id, order: entry.options.order, name: entry.options.name },
    hasComponent: typeof entry.component === 'function',
  })))
  const row = slotEntries.find(entry => entry.options !== undefined)
  assert.ok(row !== undefined, `the settings row registered: ${JSON.stringify(slotEntries)}`)
  assert.equal(row.slot ?? 'settings.general.item', 'settings.general.item')
  assert.equal(row.options.id, 'reload')
  assert.equal(row.options.name, 'settings.general.item')
  assert.equal(row.hasComponent, true, 'a component came with the registration')

  // Let the EventSource attach before the command counts connected pages.
  await page.waitForTimeout(500)

  // Arm the navigation wait BEFORE firing: the reload can land while the POST's
  // response is still in flight, and a wait started afterwards misses it.
  const reloaded = page.waitForEvent('framenavigated', {
    predicate: frame => frame === page.mainFrame(),
    timeout: 10_000,
  })

  const fired = await page.evaluate(async () => {
    const response = await fetch('/fire', { method: 'POST' })
    return response.json()
  })
  assert.equal(fired.kind, 'success', `expected success from /reload, got: ${JSON.stringify(fired)}`)
  assert.match(fired.text, /Reloading 1 open page\./, 'the host saw exactly the one open page')

  // The page must actually reload.
  await reloaded
  await page.waitForLoadState('load')
  assert.equal(navigations.length, 2, `expected one reload navigation, saw ${navigations.length}`)
  assert.equal(navigations[1], settledUrl, 'the reload returned to the same URL')

  const after = await page.evaluate(() => ({
    errors: window.__dshTest.errors,
    reloadLog: sessionStorage.getItem('dshTestReloadLog'),
  }))
  assert.deepEqual(after.errors, [], 'the reloaded page applied the bundle cleanly too')
  assert.match(
    after.reloadLog ?? '',
    /^reload: refreshing this page at the host's request/,
    'the plugin logged the reload before navigating, so the plugin caused it',
  )
  // Clear the marker so the latch check below cannot pass on this evidence.
  await page.evaluate(() => { sessionStorage.removeItem('dshTestReloadLog') })

  // Latch: two frames in one tick still produce exactly one navigation.
  const before = navigations.length
  const twice = await page.evaluate(async () => {
    const response = await fetch('/fire-twice', { method: 'POST' })
    return response.json()
  })
  assert.equal(twice.length, 2, 'both commands succeeded')
  await page.waitForTimeout(2000)
  assert.equal(navigations.length, before + 1, 'two frames collapse into one reload')

  console.log(`dsh-reload browser e2e: ok (host port ${gui.port}, ${navigations.length - 1} reloads)`)
} finally {
  await browser?.close()
  const dispose = gui?.dispose?.bind(gui)
  if (dispose !== undefined) await dispose()
}
