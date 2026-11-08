'use strict';

/**
 * scripts/make-icon.js — generates XorView's original icons (a teal rounded
 * square with a white "X") as plain PNGs plus a multi-size ICO. No external
 * assets. Side effects happen only via main() under require.main.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function crc32(buffer) {
  let table = crc32.table;
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      table[n] = c >>> 0;
    }
    crc32.table = table;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    crc = table[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function makePng(size) {
  const teal = [34, 184, 168, 255];
  const white = [255, 255, 255, 255];
  const arm = Math.max(2, Math.floor(size / 9));
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4);
    row[0] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const onDiag = Math.abs(x - y) <= arm || Math.abs(x + y - (size - 1)) <= arm;
      const px = onDiag ? white : teal;
      px.forEach((v, i) => {
        row[1 + x * 4 + i] = v;
      });
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  const idat = zlib.deflateSync(Buffer.concat(rows));
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/**
 * Pack PNG buffers into a multi-image ICO (Vista+ PNG-compressed entries).
 * @param {{ size: number, png: Buffer }[]} images
 */
function makeIco(images) {
  const count = images.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(count, 4);
  const dirSize = 16 * count;
  let offset = 6 + dirSize;
  const entries = [];
  const blobs = [];
  for (const { size, png } of images) {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size;
    entry[1] = size >= 256 ? 0 : size;
    entry[2] = 0; // palette colors
    entry[3] = 0; // reserved
    entry.writeUInt16LE(1, 4); // planes
    entry.writeUInt16LE(32, 6); // bit depth
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += png.length;
    entries.push(entry);
    blobs.push(png);
  }
  return Buffer.concat([header, ...entries, ...blobs]);
}

function main(outDir) {
  const dir = outDir || path.join(__dirname, '..', 'assets');
  fs.mkdirSync(dir, { recursive: true });
  const written = [];
  const trayFile = path.join(dir, 'tray.png');
  fs.writeFileSync(trayFile, makePng(32));
  written.push(trayFile);
  const iconPng = path.join(dir, 'icon.png');
  fs.writeFileSync(iconPng, makePng(256));
  written.push(iconPng);
  const icoFile = path.join(dir, 'icon.ico');
  fs.writeFileSync(
    icoFile,
    makeIco([16, 32, 48, 256].map((size) => ({ size, png: makePng(size) })))
  );
  written.push(icoFile);
  for (const file of written) {
    console.log(`icon: wrote ${file} (${fs.statSync(file).size} bytes)`);
  }
  return written;
}

if (require.main === module) {
  main();
}

module.exports = {
  makePng,
  makeIco,
  main
};
