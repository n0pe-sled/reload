/**
 * Reload row for the General settings page (`settings.general.item`).
 *
 * One button, one action: reload this page. That is the whole point of the
 * row. A browser refresh re-fetches the shell and the boot graph and reloads
 * every client plugin bundle, so a rebuilt `lib/client.js` or a plugin newly
 * added to the profile shows up. A change to a plugin's HOST half does not,
 * because that code runs in the already-running process; the row says so
 * rather than leaving the user to wonder why nothing changed.
 *
 * The row reloads this tab directly rather than asking the host to broadcast,
 * which is what `/reload` does. Both behaviors are wanted: the command
 * refreshes every open tab from the composer, the button refreshes the tab the
 * user is looking at from inside settings, with no round trip to the host.
 */

import { useState } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

/** Registration-side face: what the row can ask the plugin to do. */
export interface ReloadRowInjected {
  /** Reload the current page. */
  reload: () => void
}

/** Full row props: the runtime share plus the injected face. */
export type ReloadRowProps = PropsRuntime<'settings.general.item'> & InjectFace<ReloadRowInjected>

/** Inline style for the title line (tokens only; this package ships no CSS). */
const titleStyle = {
  fontSize: '14px',
  fontWeight: 400,
  lineHeight: '22px',
  color: 'var(--dsw-alias-label-primary)',
} as const

/** Inline style for the supporting line. */
const hintStyle = {
  fontSize: '12px',
  lineHeight: '18px',
  color: 'var(--dsw-alias-label-tertiary)',
} as const

/** Inline style for the row shell, matching the other General rows. */
const rowStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  padding: '16px 0',
  borderBottom: '1px solid var(--dsw-alias-border-l2)',
} as const

/** Inline style for the text column. */
const textStyle = {
  flex: 1,
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: '4px',
  paddingRight: '48px',
} as const

/**
 * Inline style for the button. A plain button rather than the primitives
 * package's atom, so this bundle requires nothing but React: the row is one
 * button, and the tokens below give it the same look as the other rows'
 * controls without pulling in a module the shell would have to resolve.
 */
const buttonStyle = {
  flex: 'none',
  height: '36px',
  padding: '0 14px',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: '18px',
  background: 'var(--dsw-alias-bg-module-platform)',
  font: 'inherit',
  fontSize: '14px',
  lineHeight: '22px',
  color: 'var(--dsw-alias-label-primary)',
  cursor: 'pointer',
} as const

/** The same button while it is waiting on the navigation it just started. */
const buttonPressedStyle = {
  ...buttonStyle,
  cursor: 'default',
  opacity: 0.6,
} as const

/**
 * Render the reload row.
 * @param props - composed settings slot props.
 * @returns the preference row.
 */
export function ReloadRow({ reload }: ReloadRowProps) {
  const [pressed, setPressed] = useState(false)

  return (
    <div style={rowStyle}>
      <div style={textStyle}>
        <div style={titleStyle}>Reload web UI</div>
        <div style={hintStyle}>
          Refresh this page so rebuilt client plugins are picked up. Changes to a plugin's
          host half need a restart of dsh web.
        </div>
      </div>
      <button
        type="button"
        style={pressed ? buttonPressedStyle : buttonStyle}
        disabled={pressed}
        onClick={() => {
          // The page is about to go away, so this state only ever paints for
          // the moment before navigation. It is still worth setting: it makes
          // the button feel answered, and it blocks a double click.
          setPressed(true)
          reload()
        }}
      >
        {pressed ? 'Reloading...' : 'Reload'}
      </button>
    </div>
  )
}
