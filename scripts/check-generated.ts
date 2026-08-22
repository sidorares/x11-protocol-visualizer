/**
 * Sanity-check the generated protocol tables.
 *
 * Run after `npm run gen:protocol` to confirm the generator still understands a
 * real xcbproto corpus. It deliberately does *not* compare against the file
 * committed to the repository: distributions ship different xcbproto versions,
 * so a byte-for-byte diff would fail for reasons that have nothing to do with
 * the change under test.
 */

import { GENERATED, GENERATED_BY_XNAME, XID_TYPE_NAMES } from '../src/core/protocol/generated.js';

const files = Object.keys(GENERATED).length;
const requests = Object.values(GENERATED).reduce((a, e) => a + Object.keys(e.requests).length, 0);
const events = Object.values(GENERATED).reduce((a, e) => a + Object.keys(e.events).length, 0);
const replies = Object.values(GENERATED).reduce(
  (a, e) => a + Object.values(e.requests).filter((r) => r.reply).length,
  0,
);

const problems: string[] = [];

if (files < 20) problems.push(`only ${files} protocol files parsed`);
if (requests < 500) problems.push(`only ${requests} requests generated`);
if (events < 50) problems.push(`only ${events} events generated`);
if (replies < 200) problems.push(`only ${replies} replies generated`);
if (XID_TYPE_NAMES.length < 20) problems.push(`only ${XID_TYPE_NAMES.length} XID types found`);

for (const ext of ['RENDER', 'RANDR', 'XInputExtension', 'MIT-SHM']) {
  if (!GENERATED_BY_XNAME[ext]) problems.push(`missing extension: ${ext}`);
}

// Layout rules that are easy to break and expensive to notice: an extension
// request must not lay a field in the minor-opcode byte, and a core request's
// fields resume at offset 4.
const createPicture = GENERATED_BY_XNAME['RENDER']?.requests[4];
if (createPicture?.fields.some((f) => f.off === 1)) {
  problems.push('RENDER:CreatePicture lays a field in the minor-opcode byte');
}
const createWindow = GENERATED['xproto']?.requests[1];
if (createWindow?.fields.find((f) => f.name === 'wid')?.off !== 4) {
  problems.push('core CreateWindow: wid is not at offset 4');
}

if (problems.length) {
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error('\ngenerated tables look wrong');
  process.exit(1);
}

console.log(
  `generator ok — ${files} files · ${requests} requests (${replies} with replies) · ` +
    `${events} events · ${XID_TYPE_NAMES.length} XID types`,
);
