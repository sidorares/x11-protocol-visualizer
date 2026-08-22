/**
 * XInputExtension — XInput 2 events.
 *
 * XI2 events are delivered as X Generic Events (core code 35): byte 1 is the
 * extension's major opcode, bytes 8-9 the XI event type (the keys below), 10-11
 * the deviceid, 12-15 the timestamp. Layouts follow the XInput 2.x protocol /
 * xcbproto xinput.xml. Names appear as `XInputExtension:Motion`, etc.
 */
import type { ExtensionSpec, DecodeCtx } from './types.js';
import { F } from './types.js';
import { fp, fp1616, r16, r32, u8, xid, type Order } from './read.js';

const deviceHeader = (b: Buffer, e: Order) => [
  F('evtype', String(r16(b, 8, e)), 8, 2),
  F('deviceid', String(r16(b, 10, e)), 10, 2),
  F('time', String(r32(b, 12, e)), 12, 4),
];

/** XIDeviceEvent — KeyPress/Release, ButtonPress/Release, Motion (evtype 2-6). */
function deviceEvent(name: string) {
  return (b: Buffer, e: Order) => {
    const dev = r16(b, 10, e);
    const detail = r32(b, 16, e);
    const root = r32(b, 20, e);
    const event = r32(b, 24, e);
    const child = r32(b, 28, e);
    const ex = fp1616(b, 40, e);
    const ey = fp1616(b, 44, e);
    return {
      summary: `dev=${dev} ${name} event=${xid(event)} @(${fp(ex)},${fp(ey)}) detail=${detail}`,
      fields: [
        ...deviceHeader(b, e),
        F('detail', String(detail), 16, 4),
        F('root', xid(root), 20, 4, 'WINDOW'),
        F('event', xid(event), 24, 4, 'WINDOW'),
        F('child', child ? xid(child) : 'None', 28, 4, 'WINDOW'),
        F('root-x', fp(fp1616(b, 32, e)), 32, 4),
        F('root-y', fp(fp1616(b, 36, e)), 36, 4),
        F('event-x', fp(ex), 40, 4),
        F('event-y', fp(ey), 44, 4),
        F('sourceid', String(r16(b, 52, e)), 52, 2),
      ],
    };
  };
}

const ENTER_MODE: Record<number, string> = { 0: 'Normal', 1: 'Grab', 2: 'Ungrab', 3: 'WhileGrabbed' };

/** XIEnterEvent / XILeaveEvent / Focus (evtype 7-10). */
function crossingEvent(name: string) {
  return (b: Buffer, e: Order) => {
    const dev = r16(b, 10, e);
    const mode = u8(b, 18);
    const root = r32(b, 20, e);
    const event = r32(b, 24, e);
    const child = r32(b, 28, e);
    const ex = fp1616(b, 40, e);
    const ey = fp1616(b, 44, e);
    return {
      summary: `dev=${dev} ${name} event=${xid(event)} mode=${ENTER_MODE[mode] ?? mode} @(${fp(ex)},${fp(ey)})`,
      fields: [
        ...deviceHeader(b, e),
        F('sourceid', String(r16(b, 16, e)), 16, 2),
        F('mode', ENTER_MODE[mode] ?? String(mode), 18, 1),
        F('detail', String(u8(b, 19)), 19, 1),
        F('root', xid(root), 20, 4, 'WINDOW'),
        F('event', xid(event), 24, 4, 'WINDOW'),
        F('child', child ? xid(child) : 'None', 28, 4, 'WINDOW'),
        F('event-x', fp(ex), 40, 4),
        F('event-y', fp(ey), 44, 4),
      ],
    };
  };
}

/** XIRawEvent — Raw key/button/motion (evtype 13-17): no window, no coords. */
function rawEvent(name: string) {
  return (b: Buffer, e: Order) => {
    const dev = r16(b, 10, e);
    const detail = r32(b, 16, e);
    return {
      summary: `dev=${dev} ${name} detail=${detail}`,
      fields: [...deviceHeader(b, e), F('detail', String(detail), 16, 4), F('sourceid', String(r16(b, 20, e)), 20, 2)],
    };
  };
}

/** Fallback for events we name but don't field-decode: still show device + time. */
function generic(name: string) {
  return (b: Buffer, e: Order) => ({
    summary: `dev=${r16(b, 10, e)} ${name}`,
    fields: deviceHeader(b, e),
  });
}

function propertyEvent(b: Buffer, e: Order, ctx: DecodeCtx) {
  const prop = r32(b, 16, e);
  return {
    summary: `dev=${r16(b, 10, e)} property=${ctx.atomName(prop)}`,
    fields: [...deviceHeader(b, e), F('property', ctx.atomName(prop), 16, 4, 'ATOM')],
  };
}

export const XINPUT: ExtensionSpec = {
  xgeEvents: {
    1: { name: 'DeviceChanged', decode: generic('DeviceChanged') },
    2: { name: 'KeyPress', decode: deviceEvent('KeyPress') },
    3: { name: 'KeyRelease', decode: deviceEvent('KeyRelease') },
    4: { name: 'ButtonPress', decode: deviceEvent('ButtonPress') },
    5: { name: 'ButtonRelease', decode: deviceEvent('ButtonRelease') },
    6: { name: 'Motion', decode: deviceEvent('Motion') },
    7: { name: 'Enter', decode: crossingEvent('Enter') },
    8: { name: 'Leave', decode: crossingEvent('Leave') },
    9: { name: 'FocusIn', decode: crossingEvent('FocusIn') },
    10: { name: 'FocusOut', decode: crossingEvent('FocusOut') },
    11: { name: 'Hierarchy', decode: generic('Hierarchy') },
    12: { name: 'Property', decode: (b, e, ctx) => propertyEvent(b, e, ctx) },
    13: { name: 'RawKeyPress', decode: rawEvent('RawKeyPress') },
    14: { name: 'RawKeyRelease', decode: rawEvent('RawKeyRelease') },
    15: { name: 'RawButtonPress', decode: rawEvent('RawButtonPress') },
    16: { name: 'RawButtonRelease', decode: rawEvent('RawButtonRelease') },
    17: { name: 'RawMotion', decode: rawEvent('RawMotion') },
    18: { name: 'TouchBegin', decode: deviceEvent('TouchBegin') },
    19: { name: 'TouchUpdate', decode: deviceEvent('TouchUpdate') },
    20: { name: 'TouchEnd', decode: deviceEvent('TouchEnd') },
    21: { name: 'TouchOwnership', decode: generic('TouchOwnership') },
    22: { name: 'RawTouchBegin', decode: rawEvent('RawTouchBegin') },
    23: { name: 'RawTouchUpdate', decode: rawEvent('RawTouchUpdate') },
    24: { name: 'RawTouchEnd', decode: rawEvent('RawTouchEnd') },
    25: { name: 'BarrierHit', decode: generic('BarrierHit') },
    26: { name: 'BarrierLeave', decode: generic('BarrierLeave') },
    27: { name: 'GesturePinchBegin', decode: generic('GesturePinchBegin') },
    28: { name: 'GesturePinchUpdate', decode: generic('GesturePinchUpdate') },
    29: { name: 'GesturePinchEnd', decode: generic('GesturePinchEnd') },
    30: { name: 'GestureSwipeBegin', decode: generic('GestureSwipeBegin') },
    31: { name: 'GestureSwipeUpdate', decode: generic('GestureSwipeUpdate') },
    32: { name: 'GestureSwipeEnd', decode: generic('GestureSwipeEnd') },
  },
  errors: {
    0: 'Device',
    1: 'Event',
    2: 'Mode',
    3: 'DeviceBusy',
    4: 'Class',
  },
};
