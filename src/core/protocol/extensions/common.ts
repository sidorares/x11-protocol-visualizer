/**
 * The common X extensions — request/event/error names, plus field decoders for
 * the resource-creating requests (so jump-to-creator works). Names come from
 * the respective X.Org protocol specs / xcbproto (minor-opcode order).
 *
 * Extensions with richer per-request decoding live in their own files
 * (render.ts, xinput.ts); these are the breadth pass so nothing shows as
 * `ext:reqN`. Field decoding can be filled in the same way, one request at a
 * time.
 */
import type { ExtensionSpec } from './types.js';
import { F, reqNames, codeNames, evtNames } from './types.js';
import { r32, xid, type Order } from './read.js';

/** A create-resource request: destination id at `off`. */
const creates = (name: string, type: string, fieldName: string, off = 4) => ({
  name,
  decode: (b: Buffer, e: Order) => {
    const id = r32(b, off, e);
    return { summary: `${fieldName}=${xid(id)}`, created: { xid: id, type }, fields: [F(fieldName, xid(id), off, 4, type.toUpperCase())] };
  },
});
/** A request referencing one resource at `off`. */
const refs = (name: string, fieldType: string, fieldName: string, off = 4) => ({
  name,
  decode: (b: Buffer, e: Order) => {
    const id = r32(b, off, e);
    return { summary: `${fieldName}=${xid(id)}`, fields: [F(fieldName, xid(id), off, 4, fieldType)] };
  },
});
/** A request that releases the resource at `off`. */
const frees = (name: string, fieldType: string, fieldName: string, off = 4) => ({
  name,
  decode: (b: Buffer, e: Order) => {
    const id = r32(b, off, e);
    return { summary: `${fieldName}=${xid(id)}`, frees: id, fields: [F(fieldName, xid(id), off, 4, fieldType)] };
  },
});

export const XFIXES: ExtensionSpec = {
  requests: {
    ...reqNames([
      'QueryVersion', 'ChangeSaveSet', 'SelectSelectionInput', 'SelectCursorInput', 'GetCursorImage',
      'CreateRegion', 'CreateRegionFromBitmap', 'CreateRegionFromWindow', 'CreateRegionFromGC',
      'CreateRegionFromPicture', 'DestroyRegion', 'SetRegion', 'CopyRegion', 'UnionRegion',
      'IntersectRegion', 'SubtractRegion', 'InvertRegion', 'TranslateRegion', 'RegionExtents',
      'FetchRegion', 'SetGCClipRegion', 'SetWindowShapeRegion', 'SetPictureClipRegion', 'SetCursorName',
      'GetCursorName', 'GetCursorImageAndName', 'ChangeCursor', 'ChangeCursorByName', 'ExpandRegion',
      'HideCursor', 'ShowCursor', 'CreatePointerBarrier', 'DeletePointerBarrier',
      'SetClientDisconnectMode', 'GetClientDisconnectMode',
    ]),
    5: creates('CreateRegion', 'Region', 'region'),
    10: frees('DestroyRegion', 'REGION', 'region'),
    11: refs('SetRegion', 'REGION', 'region'),
    31: creates('CreatePointerBarrier', 'Barrier', 'barrier'),
    32: frees('DeletePointerBarrier', 'BARRIER', 'barrier'),
  },
  events: evtNames(['SelectionNotify', 'CursorNotify']),
  errors: codeNames(['Region']),
};

export const SHAPE: ExtensionSpec = {
  requests: reqNames([
    'QueryVersion', 'Rectangles', 'Mask', 'Combine', 'Offset', 'QueryExtents', 'SelectInput',
    'InputSelected', 'GetRectangles',
  ]),
  events: evtNames(['Notify']),
};

export const DAMAGE: ExtensionSpec = {
  requests: {
    ...reqNames(['QueryVersion', 'Create', 'Destroy', 'Subtract', 'Add']),
    1: {
      name: 'Create',
      decode: (b, e) => {
        const damage = r32(b, 4, e);
        const drawable = r32(b, 8, e);
        return {
          summary: `damage=${xid(damage)} drawable=${xid(drawable)}`,
          created: { xid: damage, type: 'Damage' },
          fields: [F('damage', xid(damage), 4, 4, 'DAMAGE'), F('drawable', xid(drawable), 8, 4, 'DRAWABLE')],
        };
      },
    },
    2: frees('Destroy', 'DAMAGE', 'damage'),
  },
  events: evtNames(['Notify']),
  errors: codeNames(['Damage']),
};

export const COMPOSITE: ExtensionSpec = {
  requests: {
    ...reqNames([
      'QueryVersion', 'RedirectWindow', 'RedirectSubwindows', 'UnredirectWindow', 'UnredirectSubwindows',
      'CreateRegionFromBorderClip', 'NameWindowPixmap', 'GetOverlayWindow', 'ReleaseOverlayWindow',
    ]),
    6: {
      name: 'NameWindowPixmap',
      decode: (b, e) => {
        const window = r32(b, 4, e);
        const pixmap = r32(b, 8, e);
        return {
          summary: `window=${xid(window)} pixmap=${xid(pixmap)}`,
          created: { xid: pixmap, type: 'Pixmap' },
          fields: [F('window', xid(window), 4, 4, 'WINDOW'), F('pixmap', xid(pixmap), 8, 4, 'PIXMAP')],
        };
      },
    },
  },
};

export const SYNC: ExtensionSpec = {
  requests: reqNames([
    'Initialize', 'ListSystemCounters', 'CreateCounter', 'SetCounter', 'ChangeCounter', 'QueryCounter',
    'DestroyCounter', 'Await', 'CreateAlarm', 'ChangeAlarm', 'QueryAlarm', 'DestroyAlarm', 'SetPriority',
    'GetPriority', 'CreateFence', 'TriggerFence', 'ResetFence', 'DestroyFence', 'QueryFence', 'AwaitFence',
  ]),
  events: evtNames(['CounterNotify', 'AlarmNotify']),
  errors: codeNames(['Counter', 'Alarm']),
};

export const PRESENT: ExtensionSpec = {
  requests: reqNames(['QueryVersion', 'Pixmap', 'NotifyMSC', 'SelectInput', 'QueryCapabilities']),
  xgeEvents: evtNames(['ConfigureNotify', 'CompleteNotify', 'IdleNotify', 'RedirectNotify']),
};

export const RANDR: ExtensionSpec = {
  // Non-contiguous minor opcodes (1 and 3 are unused), so declared explicitly.
  requests: {
    0: { name: 'QueryVersion' }, 2: { name: 'SetScreenConfig' }, 4: { name: 'SelectInput' },
    5: { name: 'GetScreenInfo' }, 6: { name: 'GetScreenSizeRange' }, 7: { name: 'SetScreenSize' },
    8: { name: 'GetScreenResources' }, 9: { name: 'GetOutputInfo' }, 10: { name: 'ListOutputProperties' },
    11: { name: 'QueryOutputProperty' }, 12: { name: 'ConfigureOutputProperty' },
    13: { name: 'ChangeOutputProperty' }, 14: { name: 'DeleteOutputProperty' }, 15: { name: 'GetOutputProperty' },
    16: { name: 'CreateMode' }, 17: { name: 'DestroyMode' }, 18: { name: 'AddOutputMode' },
    19: { name: 'DeleteOutputMode' }, 20: { name: 'GetCrtcInfo' }, 21: { name: 'SetCrtcConfig' },
    22: { name: 'GetCrtcGammaSize' }, 23: { name: 'GetCrtcGamma' }, 24: { name: 'SetCrtcGamma' },
    25: { name: 'GetScreenResourcesCurrent' }, 26: { name: 'SetCrtcTransform' }, 27: { name: 'GetCrtcTransform' },
    28: { name: 'GetPanning' }, 29: { name: 'SetPanning' }, 30: { name: 'SetOutputPrimary' },
    31: { name: 'GetOutputPrimary' }, 32: { name: 'GetProviders' }, 33: { name: 'GetProviderInfo' },
    34: { name: 'SetProviderOffloadSink' }, 35: { name: 'SetProviderOutputSource' },
    36: { name: 'ListProviderProperties' }, 37: { name: 'QueryProviderProperty' },
    38: { name: 'ConfigureProviderProperty' }, 39: { name: 'ChangeProviderProperty' },
    40: { name: 'DeleteProviderProperty' }, 41: { name: 'GetProviderProperty' }, 42: { name: 'GetMonitors' },
    43: { name: 'SetMonitor' }, 44: { name: 'DeleteMonitor' }, 45: { name: 'CreateLease' }, 46: { name: 'FreeLease' },
  },
  events: evtNames(['ScreenChangeNotify', 'Notify']),
  errors: codeNames(['Output', 'Crtc', 'Mode', 'Provider']),
};

export const XTEST: ExtensionSpec = {
  requests: reqNames(['GetVersion', 'CompareCursor', 'FakeInput', 'GrabControl']),
};

export const XC_MISC: ExtensionSpec = {
  requests: reqNames(['GetVersion', 'GetXIDRange', 'GetXIDList']),
};

export const DPMS: ExtensionSpec = {
  requests: reqNames(['GetVersion', 'Capable', 'GetTimeouts', 'SetTimeouts', 'Enable', 'Disable', 'ForceLevel', 'Info']),
};

export const SCREENSAVER: ExtensionSpec = {
  requests: reqNames(['QueryVersion', 'QueryInfo', 'SelectInput', 'SetAttributes', 'UnsetAttributes', 'Suspend']),
  events: evtNames(['Notify']),
};

export const BIG_REQUESTS: ExtensionSpec = {
  requests: reqNames(['Enable']),
};
