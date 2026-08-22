/**
 * X11 core enums and value-mask bit tables, from the core protocol spec.
 * Used to turn semi-encoded parameters (a class number, a gravity, an
 * event-mask, a GC value-list) into human-readable names.
 */
import type { ValueBit } from './valuelist.js';

export const BOOL: Record<number, string> = { 0: 'false', 1: 'true' };
export const WINDOW_CLASS: Record<number, string> = { 0: 'CopyFromParent', 1: 'InputOutput', 2: 'InputOnly' };
export const BACKING_STORE: Record<number, string> = { 0: 'NotUseful', 1: 'WhenMapped', 2: 'Always' };
export const MAP_STATE: Record<number, string> = { 0: 'Unmapped', 1: 'Unviewable', 2: 'Viewable' };

export const BIT_GRAVITY: Record<number, string> = {
  0: 'Forget', 1: 'NorthWest', 2: 'North', 3: 'NorthEast', 4: 'West', 5: 'Center',
  6: 'East', 7: 'SouthWest', 8: 'South', 9: 'SouthEast', 10: 'Static',
};
export const WIN_GRAVITY: Record<number, string> = { ...BIT_GRAVITY, 0: 'Unmap' };

export const GC_FUNCTION: Record<number, string> = {
  0: 'Clear', 1: 'And', 2: 'AndReverse', 3: 'Copy', 4: 'AndInverted', 5: 'NoOp', 6: 'Xor', 7: 'Or',
  8: 'Nor', 9: 'Equiv', 10: 'Invert', 11: 'OrReverse', 12: 'CopyInverted', 13: 'OrInverted', 14: 'Nand', 15: 'Set',
};
export const LINE_STYLE: Record<number, string> = { 0: 'Solid', 1: 'OnOffDash', 2: 'DoubleDash' };
export const CAP_STYLE: Record<number, string> = { 0: 'NotLast', 1: 'Butt', 2: 'Round', 3: 'Projecting' };
export const JOIN_STYLE: Record<number, string> = { 0: 'Miter', 1: 'Round', 2: 'Bevel' };
export const FILL_STYLE: Record<number, string> = { 0: 'Solid', 1: 'Tiled', 2: 'Stippled', 3: 'OpaqueStippled' };
export const FILL_RULE: Record<number, string> = { 0: 'EvenOdd', 1: 'Winding' };
export const SUBWINDOW_MODE: Record<number, string> = { 0: 'ClipByChildren', 1: 'IncludeInferiors' };
export const ARC_MODE: Record<number, string> = { 0: 'Chord', 1: 'PieSlice' };

/** SETofEVENT — the window event mask. */
export const EVENT_MASK: Record<number, string> = {
  0x00000001: 'KeyPress', 0x00000002: 'KeyRelease', 0x00000004: 'ButtonPress', 0x00000008: 'ButtonRelease',
  0x00000010: 'EnterWindow', 0x00000020: 'LeaveWindow', 0x00000040: 'PointerMotion', 0x00000080: 'PointerMotionHint',
  0x00000100: 'Button1Motion', 0x00000200: 'Button2Motion', 0x00000400: 'Button3Motion', 0x00000800: 'Button4Motion',
  0x00001000: 'Button5Motion', 0x00002000: 'ButtonMotion', 0x00004000: 'KeymapState', 0x00008000: 'Exposure',
  0x00010000: 'VisibilityChange', 0x00020000: 'StructureNotify', 0x00040000: 'ResizeRedirect',
  0x00080000: 'SubstructureNotify', 0x00100000: 'SubstructureRedirect', 0x00200000: 'FocusChange',
  0x00400000: 'PropertyChange', 0x00800000: 'ColormapChange', 0x01000000: 'OwnerGrabButton',
};

/** CreateWindow / ChangeWindowAttributes value-list (CW). */
export const CW_BITS: ValueBit[] = [
  { bit: 0x0001, name: 'background-pixmap', type: 'PIXMAP', special: { 0: 'None', 1: 'ParentRelative' } },
  { bit: 0x0002, name: 'background-pixel', pixel: true },
  { bit: 0x0004, name: 'border-pixmap', type: 'PIXMAP', special: { 0: 'CopyFromParent' } },
  { bit: 0x0008, name: 'border-pixel', pixel: true },
  { bit: 0x0010, name: 'bit-gravity', enum: BIT_GRAVITY },
  { bit: 0x0020, name: 'win-gravity', enum: WIN_GRAVITY },
  { bit: 0x0040, name: 'backing-store', enum: BACKING_STORE },
  { bit: 0x0080, name: 'backing-planes' },
  { bit: 0x0100, name: 'backing-pixel' },
  { bit: 0x0200, name: 'override-redirect', enum: BOOL },
  { bit: 0x0400, name: 'save-under', enum: BOOL },
  { bit: 0x0800, name: 'event-mask', bits: EVENT_MASK },
  { bit: 0x1000, name: 'do-not-propagate-mask', bits: EVENT_MASK },
  { bit: 0x2000, name: 'colormap', type: 'COLORMAP', special: { 0: 'CopyFromParent' } },
  { bit: 0x4000, name: 'cursor', type: 'CURSOR', special: { 0: 'None' } },
];

/** CreateGC / ChangeGC value-list (GC). */
export const GC_BITS: ValueBit[] = [
  { bit: 0x000001, name: 'function', enum: GC_FUNCTION },
  { bit: 0x000002, name: 'plane-mask' },
  { bit: 0x000004, name: 'foreground', pixel: true },
  { bit: 0x000008, name: 'background', pixel: true },
  { bit: 0x000010, name: 'line-width' },
  { bit: 0x000020, name: 'line-style', enum: LINE_STYLE },
  { bit: 0x000040, name: 'cap-style', enum: CAP_STYLE },
  { bit: 0x000080, name: 'join-style', enum: JOIN_STYLE },
  { bit: 0x000100, name: 'fill-style', enum: FILL_STYLE },
  { bit: 0x000200, name: 'fill-rule', enum: FILL_RULE },
  { bit: 0x000400, name: 'tile', type: 'PIXMAP' },
  { bit: 0x000800, name: 'stipple', type: 'PIXMAP' },
  { bit: 0x001000, name: 'tile-stipple-x-origin' },
  { bit: 0x002000, name: 'tile-stipple-y-origin' },
  { bit: 0x004000, name: 'font', type: 'FONT' },
  { bit: 0x008000, name: 'subwindow-mode', enum: SUBWINDOW_MODE },
  { bit: 0x010000, name: 'graphics-exposures', enum: BOOL },
  { bit: 0x020000, name: 'clip-x-origin' },
  { bit: 0x040000, name: 'clip-y-origin' },
  { bit: 0x080000, name: 'clip-mask', type: 'PIXMAP', special: { 0: 'None' } },
  { bit: 0x100000, name: 'dash-offset' },
  { bit: 0x200000, name: 'dashes' },
  { bit: 0x400000, name: 'arc-mode', enum: ARC_MODE },
];
