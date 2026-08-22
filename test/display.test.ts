import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDisplay, DisplayParseError } from '../src/core/display.ts';

test('bare :N resolves to the classic unix socket', () => {
  assert.deepEqual(resolveDisplay(':0'), {
    kind: 'unix',
    path: '/tmp/.X11-unix/X0',
    display: 0,
    screen: 0,
  });
  assert.deepEqual(resolveDisplay(':2.1'), {
    kind: 'unix',
    path: '/tmp/.X11-unix/X2',
    display: 2,
    screen: 1,
  });
});

test('XQuartz launchd path keeps :0 as part of the socket path', () => {
  const disp = '/private/tmp/com.apple.launchd.WH7mCoWYWS/org.xquartz:0';
  assert.deepEqual(resolveDisplay(disp), {
    kind: 'unix',
    path: disp, // the whole string, including :0, is the socket
    display: 0,
    screen: 0,
  });
});

test('host:N resolves to TCP 6000+N', () => {
  assert.deepEqual(resolveDisplay('127.0.0.1:1'), {
    kind: 'tcp',
    host: '127.0.0.1',
    port: 6001,
    display: 1,
    screen: 0,
  });
  assert.deepEqual(resolveDisplay('somehost:5.0'), {
    kind: 'tcp',
    host: 'somehost',
    port: 6005,
    display: 5,
    screen: 0,
  });
});

test('empty / malformed DISPLAY throws', () => {
  assert.throws(() => resolveDisplay(undefined), DisplayParseError);
  assert.throws(() => resolveDisplay(''), DisplayParseError);
  assert.throws(() => resolveDisplay('nocolon'), DisplayParseError);
  assert.throws(() => resolveDisplay(':x'), DisplayParseError);
});
