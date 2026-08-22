/**
 * Extension registry, keyed by the name QueryExtension returns.
 *
 * To add an extension: write `<name>.ts` exporting an `ExtensionSpec`, then add
 * one line here. The connection engine (connection.ts) resolves an extension's
 * major opcode → name → spec and dispatches request/event/error decoding.
 */
import type { ExtensionSpec } from './types.js';
import { RENDER } from './render.js';
import { XINPUT } from './xinput.js';
import {
  XFIXES, SHAPE, DAMAGE, COMPOSITE, SYNC, PRESENT, RANDR,
  XTEST, XC_MISC, DPMS, SCREENSAVER, BIG_REQUESTS,
} from './common.js';

export const EXTENSIONS: Record<string, ExtensionSpec> = {
  RENDER,
  XInputExtension: XINPUT,
  XFIXES,
  SHAPE,
  DAMAGE,
  Composite: COMPOSITE,
  SYNC,
  Present: PRESENT,
  RANDR,
  XTEST,
  'XC-MISC': XC_MISC,
  DPMS,
  'MIT-SCREEN-SAVER': SCREENSAVER,
  'BIG-REQUESTS': BIG_REQUESTS,
};

export type { ExtensionSpec, Def, Decoded, DecodeCtx } from './types.js';
