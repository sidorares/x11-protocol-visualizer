// @jsxRuntime automatic
// @jsxImportSource react
/**
 * The control set — `src/ui/controls.tsx`, the vocabulary every panel in the
 * app is built from. One control height, one radius, one padding scale; if a
 * new piece of UI needs something that is not here, it belongs here first.
 *
 * All four button variants are react-x11's own `<Button variant size>`, so
 * these stories double as a check on core: hover, press, focus and the
 * disabled ink are core's, and an icon child inherits the button's colour
 * rather than being told what to paint.
 */

import { useState } from 'react';
import { story } from '@react-x11/workbench/story';
import { Button, Divider, Field, IconButton, Pill, T, TextField, type Variant } from '../src/ui/controls.js';
import { Icon } from '../src/ui/icons.js';
import { Ground, Specimen } from './ground.js';

export default { title: 'Controls', theme: 'dark' };

const VARIANTS: Variant[] = ['solid', 'default', 'outline', 'ghost'];

/** Every variant in every state — the sheet to check a core upgrade against. */
export const buttons = () => (
  <Ground>
    <Specimen label="variants">
      {VARIANTS.map((v) => <Button key={v} variant={v} label={v} />)}
    </Specimen>
    <Specimen label="with an icon — the glyph takes the button's ink">
      {VARIANTS.map((v) => <Button key={v} variant={v} icon="play" label={v} />)}
    </Specimen>
    <Specimen label="disabled">
      {VARIANTS.map((v) => <Button key={v} variant={v} icon="play" label={v} disabled />)}
    </Specimen>
    <Specimen label="small — the size dense rows use">
      {VARIANTS.map((v) => <Button key={v} variant={v} icon="play" label={v} small />)}
    </Specimen>
    <Specimen label="accented — tints the icon; core owns the label's ink">
      <Button icon="corner-down-right" label="response #12" variant="outline" accent={T.link} small />
      <Button icon="skip-forward" label="Skip" variant="outline" accent={T.danger} small />
      <Button icon="arrow-right" label="GetProperty — 6.0 ms" variant="ghost" accent={T.link} small />
    </Specimen>
  </Ground>
);

/** The knob-driven one: a single button with every prop exposed. */
export const button = story(
  (args: { label: string; icon: string; variant: Variant; small: boolean; disabled: boolean }) => (
    <Ground>
      <Button
        label={args.label}
        icon={args.icon || undefined}
        variant={args.variant}
        small={args.small}
        disabled={args.disabled}
      />
    </Ground>
  ),
  {
    args: { label: 'Continue', icon: 'play', variant: 'solid' as Variant, small: false, disabled: false },
    controls: { variant: VARIANTS },
  },
);

/**
 * Icon-only buttons. Ghost by default and accented with the *text* token, not
 * the dim one: a lucide glyph is a 1px stroke at this size, and dim grey on a
 * dark panel reads as disabled even when the control is live.
 */
export const iconButtons = () => (
  <Ground>
    <Specimen label="ghost (the default), small and full size">
      <IconButton icon="x" />
      <IconButton icon="search" />
      <IconButton icon="filter-x" />
      <IconButton icon="x" small />
      <IconButton icon="search" small />
    </Specimen>
    <Specimen label="other variants, and disabled">
      <IconButton icon="play" variant="default" />
      <IconButton icon="play" variant="outline" />
      <IconButton icon="play" variant="solid" />
      <IconButton icon="play" disabled />
    </Specimen>
  </Ground>
);

/**
 * Pills — anything that reads as a tag: the category counts in the toolbar,
 * the active filters, the intercept rules. `muted` is the "this filter is
 * hiding something" state; `onRemove` adds the ✕ that lifts it.
 */
export const pills = () => (
  <Ground>
    <Specimen label="category counts, as the toolbar shows them">
      <Pill label="request 17" color={T.info} />
      <Pill label="reply 4" color={T.success} />
      <Pill label="event 1" color={T.warning} />
      <Pill label="error 1" color={T.danger} />
    </Specimen>
    <Specimen label="muted — the category is hidden, and says so">
      <Pill label="event 1" color={T.warning} muted icon="eye-off" />
      <Pill label="error 1" color={T.danger} muted icon="eye-off" />
    </Specimen>
    <Specimen label="removable — a filter chip, and a rule that threw">
      <Pill label="“GetProperty”" color={T.text} onRemove={() => {}} />
      <Pill label="uses 0x04800001" color={T.link} onRemove={() => {}} />
      <Pill label="break RENDER:Composite ·3" color={T.warning} onRemove={() => {}} />
      <Pill label="drop MapWindow" color={T.danger} icon="triangle-alert" onRemove={() => {}} />
    </Specimen>
  </Ground>
);

/** The text input, with the shared control metrics. Stateful: type in it. */
export const textField = story(
  (args: { placeholder: string; width: number }) => {
    const [value, setValue] = useState('');
    return (
      <Ground>
        <Specimen label="empty, then whatever you type">
          <Icon name="search" size={13} color={T.textMuted} />
          <TextField value={value} placeholder={args.placeholder} width={args.width} onChange={setValue} />
        </Specimen>
        <Specimen label="value">
          <text style={{ color: T.textMuted }}>{value ? `“${value}”` : '(empty)'}</text>
        </Specimen>
      </Ground>
    );
  },
  {
    args: { placeholder: 'Filter name/summary…', width: 220 },
    controls: { width: { type: 'number', min: 80, max: 400, step: 10 } },
  },
);

/**
 * The group: a toolbar-shaped row of the whole set. This is the composition
 * the app's own bars are, and the reason the set exists — before it, every
 * bar was ad-hoc boxes with whatever padding the call site felt like.
 */
export const controlSet = () => {
  const [query, setQuery] = useState('GetProperty');
  return (
    <Ground padding={0}>
      <box style={{
        flexDirection: 'row', alignItems: 'center', gap: 12,
        paddingLeft: 10, paddingRight: 10, paddingTop: 6, paddingBottom: 6,
        backgroundColor: T.surface, borderColor: T.border, borderWidth: 1,
      }}>
        <text style={{ fontWeight: 'bold', color: T.text }}>x11vis</text>
        <text style={{ color: T.textMuted }}>25 msgs · 1 conns</text>
        <Divider />
        <Pill label="request 17" color={T.info} />
        <Pill label="reply 4" color={T.success} />
        <box style={{ flexGrow: 1 }} />
        <Field label="Filter">
          <TextField value={query} placeholder="name/summary…" width={180} onChange={setQuery} />
        </Field>
        <IconButton icon="filter-x" small />
        <Divider />
        <Button icon="circle-plus" label="Break on…" small />
        <Button icon="play" label="Continue" variant="solid" accent={T.link} small />
      </box>
    </Ground>
  );
};
