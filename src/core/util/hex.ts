/** Hex/format helpers shared by the console renderer and (later) the UI. */

export function toHex(buf: Buffer, maxBytes = Infinity): string {
  const n = Math.min(buf.length, maxBytes);
  let out = '';
  for (let i = 0; i < n; i++) {
    out += buf[i]!.toString(16).padStart(2, '0');
    if (i + 1 < n) out += ' ';
  }
  if (n < buf.length) out += ` … (+${buf.length - n} bytes)`;
  return out;
}

/** Classic `hexdump`-style rows: offset, hex columns, ASCII gutter. */
export function hexDump(buf: Buffer, bytesPerRow = 16): string[] {
  const rows: string[] = [];
  for (let off = 0; off < buf.length; off += bytesPerRow) {
    const slice = buf.subarray(off, off + bytesPerRow);
    const hex: string[] = [];
    let ascii = '';
    for (let i = 0; i < bytesPerRow; i++) {
      if (i < slice.length) {
        const b = slice[i]!;
        hex.push(b.toString(16).padStart(2, '0'));
        ascii += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.';
      } else {
        hex.push('  ');
        ascii += ' ';
      }
      if (i === 7) hex.push('');
    }
    rows.push(`${off.toString(16).padStart(4, '0')}  ${hex.join(' ')}  ${ascii}`);
  }
  return rows;
}

export function xid(n: number): string {
  return '0x' + (n >>> 0).toString(16).padStart(8, '0');
}
