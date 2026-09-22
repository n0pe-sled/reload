# dsh-reload

Refresh the dsh web UI without restarting the host. A `/reload` slash command and a **Reload** row in **Settings → General**, both of which make the browser pick up rebuilt client plugins.

## What it does

Two entry points, one action:

| Entry point | Scope |
|---|---|
| `/reload` in the composer | Every open dsh web page |
| **Reload** in Settings → General | The page you are looking at |

The command runs on the host, which cannot reach into a browser, so its handler pushes a frame down an SSE channel and each connected page reloads itself. That split is why one command refreshes every tab. The settings row skips the host entirely and reloads the current page, which is what you want when you are already looking at settings.

## What a reload does and does not pick up

**Picks up** a rebuilt client plugin bundle. Client bundles are served `cache-control: no-cache`, and the boot graph is re-fetched on load, so a new `lib/client.js` or a plugin newly added to the profile appears. This works whether or not `pnpm run dev:web` is running: that watcher swaps one plugin live over HMR, and this plugin covers the cases HMR does not, such as a build you produced yourself or a graph that changed.

**Does not pick up** a change to a plugin's host half. That code runs in the already-running node process. Only restarting `dsh web` loads it. The command says so in its result rather than leaving you to wonder why nothing changed:

```
Reloading 2 open pages. Host-side plugin changes still need a restart of `dsh web`.
```

## Install

```bash
dsh plugin --profile web add /path/to/reload
```

Then restart the GUI once. That first restart is unavoidable: the node half has to load before the plugin can do anything. After that, `/reload` and the settings row handle client-side changes without further restarts.

## Use

Type `/reload` in the composer, or open **Settings → General** and press **Reload**.

## Design notes

**A dedicated channel, not `/plugins/events`.** The HMR channel belongs to `dsh-client-hmr`, whose browser half ignores frame types it does not know. Sharing it would mean editing a shipped package, and it would tie this plugin's behavior to whether the HMR row is mounted. A separate endpoint at `/dsh-reload/events` keeps both independent.

**The channel is fenced.** It is a control channel: anything that can open it can make an open dsh tab reload. The route serves same-origin `GET` only and answers `403` to a request whose `Origin` header names another host, so a page on a different origin cannot reload your tab. A request with no `Origin` header at all is allowed, which is what a non-browser client sends; in a default deployment the endpoint is loopback-bound anyway.

**One reload per page per request.** A reload does not stop the page's JavaScript, so two frames in quick succession would queue two reloads. A single latch collapses them, and both entry points share it. The latch lives in one place: setting it at a call site as well would make the guard reject the caller that just set it.

**The row requires nothing but React.** The bundle's only runtime externals are `react` and `react/jsx-runtime`. The button is a plain `<button>` styled with `--dsw-alias-*` tokens rather than the primitives package's atom, so the shell never has to resolve an extra module for one button.

## Tests

```bash
pnpm build
pnpm test
```

Three levels, each covering what the one before it cannot:

- `tests/smoke.mjs` stubs the services and asserts the plugin's own contract: one command registers, `/reload` rejects arguments, an unconnected host reports that rather than failing silently, the channel streams a real frame over real HTTP, and the method gate and same-origin fence refuse what they should.
- `tests/integration-real.mjs` runs a genuine cordis context with the real command registry and the real web server plugin. `/reload` is dispatched through the actual registry and the frame is read off the actual route.
- `tests/e2e-browser.mjs` loads the real built `lib/client.js` in Chromium against the real host half and asserts that `/reload` makes the page navigate, that the navigation follows the plugin's own log line, that two frames produce one reload, and that the settings row registers into `settings.general.item`.

The browser test skips rather than fails when Chromium is not installed for the pinned Playwright version. To run it:

```bash
npx playwright install chromium
```

## Limitations

- **Host-half changes still need a restart.** Nothing in a browser can reload node code that is already running.
- **A page connected before the host restarts reconnects by itself**, because `EventSource` retries. A page that connected while the channel route did not exist yet backs off for a few seconds before it attaches, so a reload requested in that window reports that no page is connected.
- **No failure rollback and no reload history.** The command reports how many pages it told to reload, not what they did afterwards.
