// @jsxRuntime automatic
// @jsxImportSource react
/**
 * "Break on…" — the biggest composition in the app: the protocol catalog as a
 * tree, a condition builder over the selected message's real parameters, and a
 * script tab for what a form cannot say. Both tabs write the same rule.
 *
 * It renders through core's `<Dialog>`, which is a *managed popup* — a real
 * window the window manager knows is a dialog. So this story opens beside the
 * workshop rather than inside the story frame; that is the component working,
 * not the preview failing.
 *
 * The `open` knob force-closes it (a knob edit is a new prop, not a remount,
 * so it cannot re-open state the dialog's own Cancel has cleared); the story's
 * "Break on…" button is what opens it again — which is the button the app's
 * intercept bar uses too.
 */

import { useState } from 'react';
import { story } from '@react-x11/workbench/story';
import { BreakOnDialog } from '../src/ui/BreakOnDialog.js';
import { Button, T } from '../src/ui/controls.js';
import type { Rule } from '../src/core/rules.js';
import { describeRule } from '../src/core/rules.js';
import { Ground } from './ground.js';

export default { title: 'Break on… dialog', theme: 'dark', size: { width: 420, height: 220 } };

/** The atoms a short session has interned, for the atom picker. */
const ATOMS = ['WM_NAME', 'WM_PROTOCOLS', 'RESOURCE_MANAGER', 'STRING', 'UTF8_STRING', '_NET_WM_NAME'];

export const breakOn = story(
  (args: { open: boolean }) => {
    const [open, setOpen] = useState(args.open);
    const [created, setCreated] = useState<Omit<Rule, 'id' | 'hits'>[]>([]);
    // Either can close it: the knob, or the dialog's own Cancel.
    const shown = open && args.open;

    return (
      <Ground width={400}>
        <text style={{ color: T.dim }}>
          {shown ? 'The dialog is open — it is its own window.' : 'Closed:'}
        </text>
        <box style={{ flexDirection: 'row', gap: 8 }}>
          <Button icon="circle-plus" label="Break on…" onClick={() => setOpen(true)} disabled={shown} />
        </box>
        {created.length > 0 && (
          <box style={{ flexDirection: 'column', gap: 4 }}>
            <text style={{ color: T.dim }}>Rules this story has created:</text>
            {created.map((r, i) => (
              <text key={i} style={{ color: T.warn }}>
                {describeRule({ ...r, id: i + 1, hits: 0 })}
              </text>
            ))}
          </box>
        )}
        <BreakOnDialog
          open={shown}
          atoms={ATOMS}
          onClose={() => setOpen(false)}
          onCreate={(rule) => setCreated((prev) => [...prev, rule])}
        />
      </Ground>
    );
  },
  { args: { open: true } },
);
