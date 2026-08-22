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

/** Colour and spacing tokens. */
export const T = {
  bg: '#0b0e14',
  panel: '#11161f',
  panelAlt: '#0e131b',
  border: '#232a36',
  borderStrong: '#313d4f',
  text: '#c8d3e0',
  dim: '#7a8798',
  hot: '#e3b341',
  warn: '#e3b341',
  err: '#ff5c5c',
  ok: '#3ecf8e',
  chip: '#1c2532',
  chipStrong: '#243044',
  link: '#4aa3ff',
  linkSoft: '#16324d',

  /** One control height for inputs, selects and buttons. */
  control: 26,
  controlSm: 22,
  radius: 4,
  radiusPill: 10,
  padX: 10,
  padXsm: 7,
  gap: 8,
} as const;

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
        backgroundColor: muted ? T.panelAlt : T.chip,
        borderWidth: 1,
        borderColor: muted ? T.border : 'transparent',
      }}
    >
      <box
        onClick={onClick}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 5, cursor: onClick ? 'pointer' : undefined }}
      >
        {icon && <Icon name={icon} size={11} color={muted ? T.dim : color} />}
        <text style={{ color: muted ? T.dim : color, textWrap: 'nowrap' }}>{label}</text>
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
      <text style={{ color: T.dim, textWrap: 'nowrap' }}>{label}</text>
      {children}
    </box>
  );
}

/** A horizontal rule for separating toolbar groups. */
export function Divider() {
  return <box style={{ width: 1, height: 16, backgroundColor: T.border }} />;
}
