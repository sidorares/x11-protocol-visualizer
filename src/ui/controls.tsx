// @jsxRuntime automatic
// @jsxImportSource react
/**
 * The small control set the whole UI is built from.
 *
 * Everything here exists so the same idea looks the same everywhere: one
 * control height, one corner radius, one padding scale. Before this, buttons
 * were ad-hoc boxes with whatever padding the call site felt like, which is
 * what made the interface read as assembled rather than designed.
 *
 * Variants follow the usual vocabulary:
 *   solid    a filled, committing action (one per group at most)
 *   default  the ordinary bordered button
 *   outline  bordered, transparent — for secondary actions
 *   ghost    no chrome until hovered — for icon affordances inside dense rows,
 *            like the link that jumps to a resource's creator
 */

import type { ReactNode } from 'react';
import { Button as CoreButton } from 'react-x11';
import { Icon } from './icons.js';

/**
 * x11vis's palette, as a **react-x11 theme** rather than a private lookup
 * table.
 *
 * It used to be a bare object of hexes that only this app's own `<box>`es
 * read. That left two palettes in one window: core's widgets (`MenuBar`,
 * `Select`, `Button`, `Dialog`) and every `@react-x11/components` widget
 * resolve against the *desktop's* theme, so on a light desktop they came up
 * light inside a shell pinned to `#0b0e14`. `scripts/screenshot.tsx` and the
 * workbench stories each pinned `colorScheme: 'dark'` to paper over it; the
 * shipping app pinned nothing.
 *
 * So the names here are react-x11's token names wherever one exists — that is
 * the whole mechanism: `<ThemeProvider value={PALETTE}>` in `App.tsx` hands
 * this to core, and `'$textMuted'` in any style resolves against it. The last
 * block is the handful of tokens core has no name for; a `$token` is a plain
 * lookup on the theme object, so those resolve exactly the same way.
 *
 * Anything not named here comes from core's built-in `DarkTheme`, which is
 * already a coherent dark palette — the derived ones especially (the pressed
 * step of each fill, the ink that goes on it) are better computed than typed.
 */
export const PALETTE = {
  // The ground, and the things raised off it. Two tokens because a panel at
  // the window's own colour is a panel you cannot see.
  background: '#0b0e14',
  surface: '#11161f',
  surfaceHover: '#1c2532',
  surfaceActive: '#243044',

  // Ink. `textMuted` is a caption, a placeholder, a disabled label — by far
  // the most-used colour in the app, because most of a protocol dump is
  // secondary detail.
  text: '#c8d3e0',
  textMuted: '#7a8798',

  // Lines: the hairline between panels, and the heavier one a slider or a
  // switch draws its track with.
  border: '#232a36',
  track: '#313d4f',

  // What a screen has to be able to *say*. These are also the four category
  // colours the packet list paints with (`CAT_COLOR` in App.tsx), which is
  // why `success` is here even though nothing calls a reply a success: a
  // reply is the green one, and there should be exactly one green.
  danger: '#ff5c5c',
  warning: '#e3b341',
  success: '#3ecf8e',
  info: '#4aa3ff',
  link: '#4aa3ff',

  // The accent, and the row highlight cut from it. `hoverBackground` is the
  // desaturated blue a selected packet row sits on.
  accent: '#4aa3ff',
  accentHover: '#6db4ff',
  hoverBackground: '#16324d',
  borderFocus: '#4aa3ff',
  focusRing: '#4aa3ff',

  // The two faces. `monoFamily` is not decoration here: the hex dump lays
  // one `<text>` per byte in a flex row, so the columns line up only if
  // every glyph pair has the same advance. Said once, on the theme, because
  // the hex view is not the only thing that needs it.
  fontFamily: 'sans-serif',
  monoFamily: 'monospace',

  radius: 4,

  // ---- x11vis's own, for which core has no token ----------------------
  /** A panel recessed *into* the ground rather than raised off it — a well
   *  for a tree, an editor, a hex dump. */
  panelAlt: '#0e131b',
  /** Attention without alarm: the active byte span, an unusual filter. The
   *  same yellow as `warning`, under the name the call sites mean. */
  hot: '#e3b341',
  /** The ground under a paused-at-a-breakpoint bar — `warning` mixed most of
   *  the way into `background`, so the bar reads as lit without shouting. */
  held: '#2a1f16',
  /** Behind an image preview, so alpha reads as transparency and not as
   *  black ink. */
  imageMat: '#20262f',
  /** One control height for inputs, selects and buttons. */
  control: 26,
  controlSm: 22,
  radiusPill: 10,
  padXsm: 7,
} as const;

/**
 * The short name the call sites use. Same object — the palette is the theme
 * is the lookup table, so a colour cannot be named twice and drift.
 */
export const T = PALETTE;

export type Variant = 'solid' | 'default' | 'outline' | 'ghost';

export interface ButtonProps {
  label?: string;
  icon?: string;
  variant?: Variant;
  /** Tints the icon. Core owns the label's ink. */
  accent?: string;
  small?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}

/**
 * A button — react-x11's own `<Button>`, all four variants.
 *
 * This used to hand-draw `outline` and `ghost` because core had neither, which
 * meant two sources of truth for one control. react-x11#369 added `variant`
 * and `size`, and made the resolved ink reach element children, so the icon
 * inside now takes the button's colour (disabled included) without being told.
 */
export function Button({ label, icon, variant = 'default', accent, small, disabled, onClick }: ButtonProps) {
  return (
    <CoreButton
      variant={variant === 'default' ? undefined : variant === 'solid' ? 'solid' : variant}
      primary={variant === 'solid'}
      size={small ? 'small' : undefined}
      disabled={disabled}
      onPress={onClick}
      style={accent ? { color: accent } : undefined}
    >
      {icon ? (
        <box style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
          <Icon name={icon} size={small ? 12 : 13} color={accent} />
          {label && <text style={{ textWrap: 'nowrap' }}>{label}</text>}
        </box>
      ) : (
        label
      )}
    </CoreButton>
  );
}

/**
 * An icon-only button. Ghost by default, for dense rows.
 *
 * The accent defaults to the *text* token, not the dim one: a lucide glyph is a
 * 1px stroke at these sizes, and dim grey on a dark panel reads as disabled
 * even when the control is live. Dim is for decoration sitting beside dim text.
 */
export function IconButton({ icon, variant = 'ghost', accent = T.text, small, disabled, onClick }: ButtonProps & { icon: string }) {
  return <Button icon={icon} variant={variant} accent={accent} small={small} disabled={disabled} onClick={onClick} />;
}

/**
 * A pill — a compact, solid, rounded token. Used for anything that reads as a
 * tag: category counts, active filters, intercept rules.
 */
export function Pill({ label, color = T.text, icon, muted, onClick, onRemove }: {
  label: string;
  color?: string;
  icon?: string;
  muted?: boolean;
  onClick?: () => void;
  onRemove?: () => void;
}) {
  return (
    <box
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        height: T.controlSm,
        paddingLeft: T.padXsm,
        paddingRight: onRemove ? 4 : T.padXsm,
        borderRadius: T.radiusPill,
        backgroundColor: muted ? T.panelAlt : T.surfaceHover,
        borderWidth: 1,
        borderColor: muted ? T.border : 'transparent',
      }}
    >
      <box
        onClick={onClick}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 5, cursor: onClick ? 'pointer' : undefined }}
      >
        {icon && <Icon name={icon} size={11} color={muted ? T.textMuted : color} />}
        <text style={{ color: muted ? T.textMuted : color, textWrap: 'nowrap' }}>{label}</text>
      </box>
      {onRemove && <IconButton icon="x" small onClick={onRemove} />}
    </box>
  );
}

/** A text input with the shared control metrics. */
export function TextField({ value, placeholder, width, onChange }: {
  value: string;
  placeholder?: string;
  width?: number;
  onChange: (v: string) => void;
}) {
  return (
    <textinput
      value={value}
      placeholder={placeholder}
      onChange={(ev: { value: string }) => onChange(ev.value)}
      style={{
        width,
        height: T.control,
        backgroundColor: T.panelAlt,
        borderColor: T.border,
        borderWidth: 1,
        borderRadius: T.radius,
        paddingLeft: T.padXsm,
        paddingRight: T.padXsm,
        color: T.text,
      }}
    />
  );
}

/** A label above a control, so forms line up. */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <box style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      <text style={{ color: T.textMuted, textWrap: 'nowrap' }}>{label}</text>
      {children}
    </box>
  );
}

/** A horizontal rule for separating toolbar groups. */
export function Divider() {
  return <box style={{ width: 1, height: 16, backgroundColor: T.border }} />;
}
