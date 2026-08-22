/**
 * Core X11 protocol name tables.
 *
 * These are the durable, machine-readable *definitions* (opcode/event/error
 * numbers and their names) — the part of node-x11 worth reusing per
 * docs/decoder-and-state.md §2.1. The span-aware reader is written fresh
 * against them; the readers in node-x11 are not reused because they don't
 * thread byte offsets.
 */

/** Core request name by major opcode (1..127). */
export const CORE_REQUESTS: Record<number, string> = {
  1: 'CreateWindow',
  2: 'ChangeWindowAttributes',
  3: 'GetWindowAttributes',
  4: 'DestroyWindow',
  5: 'DestroySubwindows',
  6: 'ChangeSaveSet',
  7: 'ReparentWindow',
  8: 'MapWindow',
  9: 'MapSubwindows',
  10: 'UnmapWindow',
  11: 'UnmapSubwindows',
  12: 'ConfigureWindow',
  13: 'CirculateWindow',
  14: 'GetGeometry',
  15: 'QueryTree',
  16: 'InternAtom',
  17: 'GetAtomName',
  18: 'ChangeProperty',
  19: 'DeleteProperty',
  20: 'GetProperty',
  21: 'ListProperties',
  22: 'SetSelectionOwner',
  23: 'GetSelectionOwner',
  24: 'ConvertSelection',
  25: 'SendEvent',
  26: 'GrabPointer',
  27: 'UngrabPointer',
  28: 'GrabButton',
  29: 'UngrabButton',
  30: 'ChangeActivePointerGrab',
  31: 'GrabKeyboard',
  32: 'UngrabKeyboard',
  33: 'GrabKey',
  34: 'UngrabKey',
  35: 'AllowEvents',
  36: 'GrabServer',
  37: 'UngrabServer',
  38: 'QueryPointer',
  39: 'GetMotionEvents',
  40: 'TranslateCoordinates',
  41: 'WarpPointer',
  42: 'SetInputFocus',
  43: 'GetInputFocus',
  44: 'QueryKeymap',
  45: 'OpenFont',
  46: 'CloseFont',
  47: 'QueryFont',
  48: 'QueryTextExtents',
  49: 'ListFonts',
  50: 'ListFontsWithInfo',
  51: 'SetFontPath',
  52: 'GetFontPath',
  53: 'CreatePixmap',
  54: 'FreePixmap',
  55: 'CreateGC',
  56: 'ChangeGC',
  57: 'CopyGC',
  58: 'SetDashes',
  59: 'SetClipRectangles',
  60: 'FreeGC',
  61: 'ClearArea',
  62: 'CopyArea',
  63: 'CopyPlane',
  64: 'PolyPoint',
  65: 'PolyLine',
  66: 'PolySegment',
  67: 'PolyRectangle',
  68: 'PolyArc',
  69: 'FillPoly',
  70: 'PolyFillRectangle',
  71: 'PolyFillArc',
  72: 'PutImage',
  73: 'GetImage',
  74: 'PolyText8',
  75: 'PolyText16',
  76: 'ImageText8',
  77: 'ImageText16',
  78: 'CreateColormap',
  79: 'FreeColormap',
  80: 'CopyColormapAndFree',
  81: 'InstallColormap',
  82: 'UninstallColormap',
  83: 'ListInstalledColormaps',
  84: 'AllocColor',
  85: 'AllocNamedColor',
  86: 'AllocColorCells',
  87: 'AllocColorPlanes',
  88: 'FreeColors',
  89: 'StoreColors',
  90: 'StoreNamedColor',
  91: 'QueryColors',
  92: 'LookupColor',
  93: 'CreateCursor',
  94: 'CreateGlyphCursor',
  95: 'FreeCursor',
  96: 'RecolorCursor',
  97: 'QueryBestSize',
  98: 'QueryExtension',
  99: 'ListExtensions',
  100: 'ChangeKeyboardMapping',
  101: 'GetKeyboardMapping',
  102: 'ChangeKeyboardControl',
  103: 'GetKeyboardControl',
  104: 'Bell',
  105: 'ChangePointerControl',
  106: 'GetPointerControl',
  107: 'SetScreenSaver',
  108: 'GetScreenSaver',
  109: 'ChangeHosts',
  110: 'ListHosts',
  111: 'SetAccessControl',
  112: 'SetCloseDownMode',
  113: 'KillClient',
  114: 'RotateProperties',
  115: 'ForceScreenSaver',
  116: 'SetPointerMapping',
  117: 'GetPointerMapping',
  118: 'SetModifierMapping',
  119: 'GetModifierMapping',
  120: 'NoOperation', // some servers accept 120..127; 127 is the canonical NoOperation
  127: 'NoOperation',
};

/** Core event name by code (2..35). */
export const CORE_EVENTS: Record<number, string> = {
  2: 'KeyPress',
  3: 'KeyRelease',
  4: 'ButtonPress',
  5: 'ButtonRelease',
  6: 'MotionNotify',
  7: 'EnterNotify',
  8: 'LeaveNotify',
  9: 'FocusIn',
  10: 'FocusOut',
  11: 'KeymapNotify',
  12: 'Expose',
  13: 'GraphicsExposure',
  14: 'NoExposure',
  15: 'VisibilityNotify',
  16: 'CreateNotify',
  17: 'DestroyNotify',
  18: 'UnmapNotify',
  19: 'MapNotify',
  20: 'MapRequest',
  21: 'ReparentNotify',
  22: 'ConfigureNotify',
  23: 'ConfigureRequest',
  24: 'GravityNotify',
  25: 'ResizeRequest',
  26: 'CirculateNotify',
  27: 'CirculateRequest',
  28: 'PropertyNotify',
  29: 'SelectionClear',
  30: 'SelectionRequest',
  31: 'SelectionNotify',
  32: 'ColormapNotify',
  33: 'ClientMessage',
  34: 'MappingNotify',
  35: 'GenericEvent',
};

/** Core error name by code (1..17). */
export const CORE_ERRORS: Record<number, string> = {
  1: 'Request',
  2: 'Value',
  3: 'Window',
  4: 'Pixmap',
  5: 'Atom',
  6: 'Cursor',
  7: 'Font',
  8: 'Match',
  9: 'Drawable',
  10: 'Access',
  11: 'Alloc',
  12: 'Colormap',
  13: 'GContext',
  14: 'IDChoice',
  15: 'Name',
  16: 'Length',
  17: 'Implementation',
};

/** Resource type produced by a core request that allocates an XID. */
export interface ResourceCreator {
  type: string;
  /** Byte offset of the created XID within the request body. */
  xidOffset: number;
}

/**
 * Core requests that allocate a resource id. Nearly all place the new XID at
 * bytes 4..7 of the request. Used by resource tracking (docs §6.1).
 */
export const CORE_RESOURCE_CREATORS: Record<number, ResourceCreator> = {
  1: { type: 'Window', xidOffset: 4 }, // CreateWindow
  53: { type: 'Pixmap', xidOffset: 4 }, // CreatePixmap
  55: { type: 'GContext', xidOffset: 4 }, // CreateGC
  45: { type: 'Font', xidOffset: 4 }, // OpenFont
  78: { type: 'Colormap', xidOffset: 4 }, // CreateColormap
  80: { type: 'Colormap', xidOffset: 4 }, // CopyColormapAndFree (mid)
  93: { type: 'Cursor', xidOffset: 4 }, // CreateCursor
  94: { type: 'Cursor', xidOffset: 4 }, // CreateGlyphCursor
};

/**
 * Core requests that release a resource id → the byte offset of the id they
 * release. Used for lifecycle lints (use-after-free, double-free, leaks).
 */
export const CORE_RESOURCE_FREERS: Record<number, number> = {
  4: 4, // DestroyWindow
  46: 4, // CloseFont
  54: 4, // FreePixmap
  60: 4, // FreeGC
  79: 4, // FreeColormap
  95: 4, // FreeCursor
};

/** The predefined atoms (1..68), so InternAtom/GetProperty can name them. */
export const PREDEFINED_ATOMS: Record<number, string> = {
  1: 'PRIMARY',
  2: 'SECONDARY',
  3: 'ARC',
  4: 'ATOM',
  5: 'BITMAP',
  6: 'CARDINAL',
  7: 'COLORMAP',
  8: 'CURSOR',
  9: 'CUT_BUFFER0',
  10: 'CUT_BUFFER1',
  11: 'CUT_BUFFER2',
  12: 'CUT_BUFFER3',
  13: 'CUT_BUFFER4',
  14: 'CUT_BUFFER5',
  15: 'CUT_BUFFER6',
  16: 'CUT_BUFFER7',
  17: 'DRAWABLE',
  18: 'FONT',
  19: 'INTEGER',
  20: 'PIXMAP',
  21: 'POINT',
  22: 'RECTANGLE',
  23: 'RESOURCE_MANAGER',
  24: 'RGB_COLOR_MAP',
  25: 'RGB_BEST_MAP',
  26: 'RGB_BLUE_MAP',
  27: 'RGB_DEFAULT_MAP',
  28: 'RGB_GRAY_MAP',
  29: 'RGB_GREEN_MAP',
  30: 'RGB_RED_MAP',
  31: 'STRING',
  32: 'VISUALID',
  33: 'WINDOW',
  34: 'WM_COMMAND',
  35: 'WM_HINTS',
  36: 'WM_CLIENT_MACHINE',
  37: 'WM_ICON_NAME',
  38: 'WM_ICON_SIZE',
  39: 'WM_NAME',
  40: 'WM_NORMAL_HINTS',
  41: 'WM_SIZE_HINTS',
  42: 'WM_ZOOM_HINTS',
  43: 'MIN_SPACE',
  44: 'NORM_SPACE',
  45: 'MAX_SPACE',
  46: 'END_SPACE',
  47: 'SUPERSCRIPT_X',
  48: 'SUPERSCRIPT_Y',
  49: 'SUBSCRIPT_X',
  50: 'SUBSCRIPT_Y',
  51: 'UNDERLINE_POSITION',
  52: 'UNDERLINE_THICKNESS',
  53: 'STRIKEOUT_ASCENT',
  54: 'STRIKEOUT_DESCENT',
  55: 'ITALIC_ANGLE',
  56: 'X_HEIGHT',
  57: 'QUAD_WIDTH',
  58: 'WEIGHT',
  59: 'POINT_SIZE',
  60: 'RESOLUTION',
  61: 'COPYRIGHT',
  62: 'NOTICE',
  63: 'FONT_NAME',
  64: 'FAMILY_NAME',
  65: 'FULL_NAME',
  66: 'CAP_HEIGHT',
  67: 'WM_CLASS',
  68: 'WM_TRANSIENT_FOR',
};

/** Requests that produce a reply (used to prioritize seq→request retention). */
export const REPLY_GENERATING = new Set<number>([
  3, 14, 15, 16, 17, 20, 21, 23, 26, 31, 38, 39, 40, 43, 44, 47, 48, 49, 50, 52,
  73, 83, 84, 85, 86, 87, 91, 92, 97, 98, 99, 101, 103, 106, 108, 110, 116, 117,
  119,
]);
