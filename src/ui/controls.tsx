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
 * table — and as *two* schemes rather than one.
 *
 * It used to be a bare object of hexes that only this app's own `<box>`es
 * read. That left two palettes in one window: core's widgets (`MenuBar`,
 * `Select`, `Button`, `Dialog`) and every `@react-x11/components` widget
 * resolve against the *desktop's* theme, so on a light desktop they came up
 * light inside a shell pinned to `#0b0e14`. The provider fixed that by
 * pinning the other way — `colorScheme="dark"` — which made the whole app one
 * palette at the price of the app never following the desktop at all.
 *
 * Now `App.tsx` mounts `<ThemeProvider value={PALETTE} dark={DARK}>` and names
 * no scheme, so react-x11's own rule applies: light desktop, light app.
 * `PALETTE` is the light scheme (merged over core's `DefaultTheme`) and `DARK`
 * is what a dark desktop changes about it (merged over core's `DarkTheme`) —
 * the same design in two schemes, not two designs. **`DARK` is the palette
 * this app shipped before there was a light one**, so a dark desktop sees
 * what it saw.
 *
 * The names are react-x11's token names wherever one exists, because that is
 * the whole mechanism: `'$textMuted'` in any style resolves against whichever
 * scheme is in force. The last block is the handful of tokens core has no
 * name for; a `$token` is a plain lookup on the theme object, so those resolve
 * exactly the same way.
 *
 * Anything not named here comes from core's built-in pair, which is already a
 * coherent light and a coherent dark — the derived ones especially (the
 * pressed step of each fill, the ink that goes on it) are better computed than
 * typed, and computing them is how the two schemes stay one design.
 */
export const PALETTE = {
  // The ground, and the things raised off it. Two tokens because a panel at
  // the window's own colour is a panel you cannot see — which is why the
  // light ground is tinted rather than white: it is the surfaces that are
  // white, and they have to be seen against it.
  background: '#f2f4f7',
  surface: '#ffffff',
  surfaceHover: '#e8ecf1',

  // Ink. `textMuted` is a caption, a placeholder, a disabled label — by far
  // the most-used colour in the app, because most of a protocol dump is
  // secondary detail. It clears 4.5:1 on all three grounds above, which is
  // the constraint that picked it.
  text: '#1a2029',
  textMuted: '#5a6672',

  // Lines: the hairline between panels, and the heavier one a slider or a
  // switch draws its track with.
  border: '#d3d9e0',
  track: '#b9c2cc',

  // What a screen has to be able to *say*. These are also the four category
  // colours the packet list paints with (`CAT_COLOR` in App.tsx), which is
  // why `success` is here even though nothing calls a reply a success: a
  // reply is the green one, and there should be exactly one green.
  //
  // The same four hues in both schemes, re-picked for the ground they land
  // on: these clear 4.5:1 on white where `DARK`'s clear it on near-black.
  danger: '#c62828',
  warning: '#8a5a00',
  success: '#0f7a46',
  info: '#1666c8',
  link: '#1666c8',

  // The accent, and the row highlight cut from it. `hoverBackground` is the
  // desaturated blue a selected packet row sits on; `hoverText` is derived
  // from it by `resolveTheme`, so it cannot be the wrong ink for the fill.
  accent: '#1666c8',
  accentHover: '#0f4f9e',
  hoverBackground: '#d6e6fb',
  borderFocus: '#1666c8',
  focusRing: '#1666c8',

  // The two faces. `monoFamily` is not decoration here: the hex dump lays
  // one `<text>` per byte in a flex row, so the columns line up only if
  // every glyph pair has the same advance. Said once, on the theme, because
  // the hex view is not the only thing that needs it.
  fontFamily: 'sans-serif',
  monoFamily: 'monospace',

  radius: 4,

  // ---- x11vis's own, for which core has no token ----------------------
  /** A panel recessed *into* the ground rather than raised off it — a well
   *  for a tree, an editor, a hex dump. A dark scheme recesses by going
   *  darker than the ground; a light one has no room below white, so it
   *  recesses by going a step *greyer* than the surface it is cut into. */
  panelAlt: '#eceff3',
  /** Attention without alarm: the fill behind the active byte span. The one
   *  colour that does not change with the scheme — a highlighter is yellow
   *  on paper and on a screen — so the ink on it is `hotInk` rather than
   *  either scheme's ground. */
  hot: '#e3b341',
  /** The ink that goes on `hot`. Near-black in both schemes, because `hot`
   *  is: 9.9:1, where the light ground on that yellow would be 1.8:1. */
  hotInk: '#0b0e14',
  /** The ground under a paused-at-a-breakpoint bar — `warning` mixed most of
   *  the way into `background`, so the bar reads as lit without shouting. */
  held: '#fdf3d9',
  /** Behind an image preview, so alpha reads as transparency and not as
   *  black ink. */
  imageMat: '#dfe4ea',
  /** One control height for inputs, selects and buttons. */
  control: 26,
  controlSm: 22,
  radiusPill: 10,
  padXsm: 7,
} as const;

/**
 * What a dark desktop changes — layered over `PALETTE` *and* over core's
 * `DarkTheme`, so anything absent here (the pressed steps, the inks on the
 * fills) is core's dark answer rather than a light one carried across.
 *
 * Only colours, and only the ones that have to move: the shape is the design
 * and the design does not have a scheme, so `radius`, `control`, the two font
 * families and the rest of the metrics are named once, above.
 *
 * One value did move. `surfaceActive` — the pressed step under a hovered
 * surface — used to be typed here as `#243044`; it is now derived by
 * `resolveTheme` from the `surface`/`surfaceHover` pair below, which lands on
 * `#273445`. Three units, in a fill that shows for the length of a click, in
 * exchange for a token that can no longer be forgotten in one scheme and
 * remembered in the other.
 */
export const DARK: Partial<typeof PALETTE> = {
  background: '#0b0e14',
  surface: '#11161f',
  surfaceHover: '#1c2532',

  text: '#c8d3e0',
  textMuted: '#7a8798',

  border: '#232a36',
  track: '#313d4f',

  danger: '#ff5c5c',
  warning: '#e3b341',
  success: '#3ecf8e',
  info: '#4aa3ff',
  link: '#4aa3ff',

  accent: '#4aa3ff',
  accentHover: '#6db4ff',
  hoverBackground: '#16324d',
  borderFocus: '#4aa3ff',
  focusRing: '#4aa3ff',

  panelAlt: '#0e131b',
  held: '#2a1f16',
  imageMat: '#20262f',
};

/**
 * What the call sites write. **A colour here is a `'$token'` reference, not a
 * colour** — resolved against whichever scheme is in force at the moment the
 * node is painted, which is the entire point: a hex read out of this module at
 * import time is frozen, and a frozen colour is what made the app dark on a
 * light desktop no matter what the provider said.
 *
 * The split is by type rather than by hand, so it cannot drift: a string token
 * is a colour (or a font family) and becomes `$name`; a number is a metric,
 * has no scheme, and passes through as itself. `height: T.control` is still a
 * number; `color: T.textMuted` is now `'$textMuted'`.
 *
 * Both routes end in the same object. A `$token` resolves against the nearest
 * `theme` prop by walking the *node* tree, and `<ThemeProvider>` plants the
 * merged palette there as well as on React context — so a colour is named
 * once, in `PALETTE`/`DARK`, and cannot be named twice and drift.
 */
type TokenRefs<P> = { [K in keyof P]: P[K] extends string ? `$${K & string}` : P[K] };

export const T = Object.fromEntries(
  Object.entries(PALETTE).map(([k, v]) => [k, typeof v === 'string' ? `$${k}` : v]),
) as TokenRefs<typeof PALETTE>;

export type Variant = 'solid' | 'default' | 'outline' | 'ghost';

export interface ButtonProps {
  label?: string;
  icon?: string;
  variant?: Variant;
  /**
   * The button's ink — label and icon together, since core resolves a
   * `<Button>`'s colour down into its children.
   *
   * **Ignored on `solid`,** where the accent is the *fill* and the ink that
   * goes on it is `accentText`, which `resolveTheme` derives from the fill by
   * contrast. Honouring it there painted `accent={T.link}` blue letters on a
   * blue button — invisible in light, nearly so in dark.
   */
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
  // A solid button's fill *is* the accent, so an ink of the same name is the
  // one thing it cannot wear. Dropping it here rather than at the call sites
  // means the eight `accent={T.link}`s scattered through the app keep saying
  // the same thing — "this is the affirmative one" — and the two variants that
  // draw it as a fill and as letters each read it the right way.
  const ink = variant === 'solid' ? undefined : accent;
  return (
    <CoreButton
      variant={variant === 'default' ? undefined : variant === 'solid' ? 'solid' : variant}
      primary={variant === 'solid'}
      size={small ? 'small' : undefined}
      disabled={disabled}
      onPress={onClick}
      style={ink ? { color: ink } : undefined}
    >
      {icon ? (
        <box style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
          <Icon name={icon} size={small ? 12 : 13} color={ink} />
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
