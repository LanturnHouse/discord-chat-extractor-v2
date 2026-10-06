import { crc32 as nodeCrc32 } from 'node:zlib';
import { strFromU8, strToU8, Unzip, UnzipInflate, UnzipPassThrough, unzipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
import { BlobAssembler, crc32, MAX_ZIP_ENTRIES, MAX_ZIP_INPUT_BYTES, ZipAssembler, ZipLimitError } from '../../../src/lib/export/zip';

async function bytesOf(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

async function unzip(blob: Blob): Promise<Record<string, Uint8Array>> {
  return unzipSync(await bytesOf(blob));
}

const textBlob = (text: string): Blob => new Blob([text], { type: 'text/plain' });

function noise(length: number, seed = 12345): Uint8Array<ArrayBuffer> {
  const data = new Uint8Array(length);
  let state = seed;
  for (let i = 0; i < length; i += 1) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    data[i] = state >> 16;
  }
  return data;
}

/** Builds an archive from `entries` in order. */
async function build(entries: Array<[string, string | Uint8Array | Blob, { store?: boolean }?]>): Promise<Blob> {
  const zip = new ZipAssembler();
  for (const [path, data, options] of entries) await zip.add(path, data, options);
  return zip.finish();
}

interface Header {
  name: string;
  flags: number;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  offset: number;
}

/** Hand-written reader of the central directory and of the local header each entry of it points at. */
function readHeaders(bytes: Uint8Array): { central: Header[]; local: Header[]; directoryOffset: number; directorySize: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const endAt = bytes.length - 22;
  expect(view.getUint32(endAt, true)).toBe(0x06054b50);
  expect(view.getUint16(endAt + 4, true)).toBe(0); // disk number
  expect(view.getUint16(endAt + 6, true)).toBe(0);
  const count = view.getUint16(endAt + 10, true);
  expect(view.getUint16(endAt + 8, true)).toBe(count);
  const directorySize = view.getUint32(endAt + 12, true);
  const directoryOffset = view.getUint32(endAt + 16, true);
  expect(view.getUint16(endAt + 20, true)).toBe(0); // no comment
  expect(directoryOffset + directorySize).toBe(endAt);
  const central: Header[] = [];
  let at = directoryOffset;
  for (let i = 0; i < count; i += 1) {
    expect(view.getUint32(at, true)).toBe(0x02014b50);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    central.push({
      name: strFromU8(bytes.subarray(at + 46, at + 46 + nameLength)),
      flags: view.getUint16(at + 8, true),
      method: view.getUint16(at + 10, true),
      crc: view.getUint32(at + 16, true),
      compressedSize: view.getUint32(at + 20, true),
      size: view.getUint32(at + 24, true),
      offset: view.getUint32(at + 42, true),
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  expect(at).toBe(endAt);
  const local = central.map((entry): Header => {
    const start = entry.offset;
    expect(view.getUint32(start, true)).toBe(0x04034b50);
    const nameLength = view.getUint16(start + 26, true);
    return {
      name: strFromU8(bytes.subarray(start + 30, start + 30 + nameLength)),
      flags: view.getUint16(start + 6, true),
      method: view.getUint16(start + 8, true),
      crc: view.getUint32(start + 14, true),
      compressedSize: view.getUint32(start + 18, true),
      size: view.getUint32(start + 22, true),
      offset: start,
    };
  });
  return { central, local, directoryOffset, directorySize };
}

/**
 * A strict sequential reader, like Java's ZipInputStream when the sizes are in the headers: walks the archive front to back
 * from the local headers alone, takes the sizes from them, and fails on anything that needs a data descriptor.
 */
function readSequentially(bytes: Uint8Array): Array<{ name: string; method: number; data: Uint8Array }> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries: Array<{ name: string; method: number; data: Uint8Array }> = [];
  let at = 0;
  while (view.getUint32(at, true) === 0x04034b50) {
    const flags = view.getUint16(at + 6, true);
    const method = view.getUint16(at + 8, true);
    expect(flags & 0x0008, 'a data descriptor follows the data: a sequential reader cannot know the size').toBe(0);
    expect(flags & 0x0800).toBe(0x0800);
    const crc = view.getUint32(at + 14, true);
    const compressedSize = view.getUint32(at + 18, true);
    const size = view.getUint32(at + 22, true);
    const nameLength = view.getUint16(at + 26, true);
    const extraLength = view.getUint16(at + 28, true);
    const name = strFromU8(bytes.subarray(at + 30, at + 30 + nameLength));
    const start = at + 30 + nameLength + extraLength;
    const raw = bytes.subarray(start, start + compressedSize);
    let data: Uint8Array;
    if (method === 0) {
      expect(compressedSize).toBe(size);
      data = raw;
    } else {
      expect(method).toBe(8);
      data = unzipSync(buildSingleEntryZip(name, raw, crc, compressedSize, size))[name]!;
    }
    expect(nodeCrc32(data), `crc of ${name}`).toBe(crc);
    expect(data.length).toBe(size);
    entries.push({ name, method, data });
    at = start + compressedSize;
  }
  expect(view.getUint32(at, true), 'the central directory follows the last entry').toBe(0x02014b50);
  return entries;
}

/** A one-entry archive around already deflated bytes, so that the reader above can use fflate to inflate them. */
function buildSingleEntryZip(name: string, deflated: Uint8Array, crc: number, compressedSize: number, size: number): Uint8Array {
  const nameBytes = strToU8(name);
  const local = new Uint8Array(30 + nameBytes.length + deflated.length);
  const lv = new DataView(local.buffer);
  lv.setUint32(0, 0x04034b50, true);
  lv.setUint16(4, 20, true);
  lv.setUint16(6, 0x0800, true);
  lv.setUint16(8, 8, true);
  lv.setUint32(14, crc, true);
  lv.setUint32(18, compressedSize, true);
  lv.setUint32(22, size, true);
  lv.setUint16(26, nameBytes.length, true);
  local.set(nameBytes, 30);
  local.set(deflated, 30 + nameBytes.length);
  const central = new Uint8Array(46 + nameBytes.length);
  const cv = new DataView(central.buffer);
  cv.setUint32(0, 0x02014b50, true);
  cv.setUint16(4, 20, true);
  cv.setUint16(6, 20, true);
  cv.setUint16(8, 0x0800, true);
  cv.setUint16(10, 8, true);
  cv.setUint32(16, crc, true);
  cv.setUint32(20, compressedSize, true);
  cv.setUint32(24, size, true);
  cv.setUint16(28, nameBytes.length, true);
  central.set(nameBytes, 46);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, 1, true);
  ev.setUint16(10, 1, true);
  ev.setUint32(12, central.length, true);
  ev.setUint32(16, local.length, true);
  const out = new Uint8Array(local.length + central.length + end.length);
  out.set(local, 0);
  out.set(central, local.length);
  out.set(end, local.length + central.length);
  return out;
}

/** Reads the archive front to back like fflate's streaming consumer (no central directory), in chunks of `chunk` bytes. */
function streamUnzip(bytes: Uint8Array, chunk: number): Record<string, Uint8Array> {
  const parts: Record<string, Uint8Array[]> = {};
  const unzipper = new Unzip((file) => {
    parts[file.name] = [];
    file.ondata = (error, data) => {
      if (error) throw error;
      parts[file.name]!.push(data);
    };
    file.start();
  });
  unzipper.register(UnzipInflate);
  unzipper.register(UnzipPassThrough);
  for (let at = 0; at < bytes.length; at += chunk) unzipper.push(bytes.subarray(at, at + chunk), at + chunk >= bytes.length);
  return Object.fromEntries(Object.entries(parts).map(([name, list]) => [name, Buffer.concat(list)]));
}

describe('ZipAssembler: the archive', () => {
  it('produces a readable application/zip with the entries and their folders', async () => {
    const zip = await build([
      ['Server/Category/general.txt', 'hello world'],
      ['Direct Messages/Alice.txt', 'hi'],
    ]);
    expect(zip.type).toBe('application/zip');
    const files = await unzip(zip);
    expect(Object.keys(files).sort()).toEqual(['Direct Messages/Alice.txt', 'Server/Category/general.txt']);
    expect(strFromU8(files['Server/Category/general.txt']!)).toBe('hello world');
    expect(strFromU8(files['Direct Messages/Alice.txt']!)).toBe('hi');
  });

  it('keeps entries in the order they were added', async () => {
    const zip = await build(['c', 'a', 'b'].map((n): [string, string] => [`${n}.txt`, n]));
    expect(Object.keys(await unzip(zip))).toEqual(['c.txt', 'a.txt', 'b.txt']);
    expect(readHeaders(await bytesOf(zip)).central.map((h) => h.name)).toEqual(['c.txt', 'a.txt', 'b.txt']);
  });

  it('stores Korean and emoji names and text as UTF-8 (general-purpose flag bit 11)', async () => {
    const path = '모임방/수학/수학모임 - 잡담 🎉.html';
    const zip = await build([[path, '안녕하세요 👋']]);
    const bytes = await bytesOf(zip);
    const files = unzipSync(bytes);
    expect(Object.keys(files)).toEqual([path]);
    expect(strFromU8(files[path]!)).toBe('안녕하세요 👋');
    const { central, local } = readHeaders(bytes);
    expect(central[0]!.flags & 0x0800).toBe(0x0800);
    expect(local[0]!.flags & 0x0800).toBe(0x0800);
    expect(local[0]!.name).toBe(path);
  });

  it('writes an empty entry (stored, all zero) and a valid archive for zero entries', async () => {
    const zip = await build([
      ['empty.txt', ''],
      ['after.txt', 'x'],
      ['empty.bin', new Uint8Array(0)],
      ['empty-blob.txt', new Blob([])],
    ]);
    const files = await unzip(zip);
    expect(files['empty.txt']).toHaveLength(0);
    expect(strFromU8(files['after.txt']!)).toBe('x');
    expect(files['empty.bin']).toHaveLength(0);
    expect(files['empty-blob.txt']).toHaveLength(0);
    const { local } = readHeaders(await bytesOf(zip));
    expect(local[0]).toMatchObject({ method: 0, crc: 0, size: 0, compressedSize: 0 });

    const none = await new ZipAssembler().finish();
    expect(await unzip(none)).toEqual({});
    expect(none.size).toBe(22);
  });

  it('round-trips data much larger than one chunk and compresses text', async () => {
    const line = 'The quick brown fox jumps over the lazy dog 안녕하세요 \n';
    const big = line.repeat(60_000); // ~3.8 MB, many chunks
    const zip = await build([['big.txt', big]]);
    expect(zip.size).toBeLessThan(big.length / 10);
    const files = await unzip(zip);
    expect(strFromU8(files['big.txt']!)).toBe(big);
  });

  it('round-trips incompressible binary data byte for byte', async () => {
    const data = noise(1_500_000);
    const zip = await build([['noise.bin', new Blob([data])]]);
    const files = await unzip(zip);
    expect(Buffer.from(files['noise.bin']!).equals(Buffer.from(data))).toBe(true);
  });

  it('takes text, bytes and Blobs, also a view into a bigger buffer', async () => {
    const backing = new Uint8Array([9, 9, 1, 2, 3, 4, 9, 9]);
    const zip = await build([
      ['text.txt', 'töxt 🙂'],
      ['view.bin', backing.subarray(2, 6), { store: true }],
      ['blob.txt', textBlob('from a blob')],
    ]);
    const files = await unzip(zip);
    expect(strFromU8(files['text.txt']!)).toBe('töxt 🙂');
    expect([...files['view.bin']!]).toEqual([1, 2, 3, 4]);
    expect(strFromU8(files['blob.txt']!)).toBe('from a blob');
  });

  it('stamps entries with the injected clock, or with their own time', async () => {
    const zip = new ZipAssembler(() => new Date(2026, 9, 6, 13, 4, 6));
    await zip.add('a.txt', 'a');
    await zip.add('b.txt', 'b', { mtime: new Date(2024, 1, 29, 23, 59, 58) });
    const bytes = await bytesOf(await zip.finish());
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const stamp = (at: number): Date => {
      const time = view.getUint16(at + 10, true);
      const date = view.getUint16(at + 12, true);
      return new Date(1980 + (date >> 9), ((date >> 5) & 15) - 1, date & 31, time >> 11, (time >> 5) & 63, (time & 31) * 2);
    };
    const { local } = readHeaders(bytes);
    expect(stamp(local[0]!.offset)).toEqual(new Date(2026, 9, 6, 13, 4, 6));
    expect(stamp(local[1]!.offset)).toEqual(new Date(2024, 1, 29, 23, 59, 58));
  });

  it('stamps entries with the current time by default and reads a time ZIP cannot hold as "now"', async () => {
    const before = Date.now();
    const zip = new ZipAssembler();
    await zip.add('a.txt', 'a');
    await zip.add('old.txt', 'a', { mtime: new Date(1970, 0, 1) });
    await zip.add('invalid.txt', 'a', { mtime: new Date(Number.NaN) });
    await zip.add('future.txt', 'a', { mtime: new Date(2200, 0, 1) });
    const bytes = await bytesOf(await zip.finish());
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (const entry of readHeaders(bytes).local) {
      const time = view.getUint16(entry.offset + 10, true);
      const date = view.getUint16(entry.offset + 12, true);
      const modified = new Date(1980 + (date >> 9), ((date >> 5) & 15) - 1, date & 31, time >> 11, (time >> 5) & 63, (time & 31) * 2);
      expect(Math.abs(modified.getTime() - before)).toBeLessThan(15_000);
    }
  });
});

describe('ZipAssembler: sizes and CRC are in the local headers, never in a data descriptor', () => {
  const payload = new Uint8Array(70_000).fill(7);
  const entries: Array<[string, Uint8Array | string]> = [
    ['book.xlsx', payload],
    ['inner.ZIP', payload],
    ['notes.txt', payload],
    ['photo.PNG', noise(5000)],
    ['clip.mp4', noise(9000, 2)],
    ['readme', 'plain text without an extension'],
    ['empty.xlsx', new Uint8Array(0)],
  ];

  it('stores what is compressed already (method 0, the bytes as they are) and deflates the rest (method 8)', async () => {
    const bytes = await bytesOf(await build(entries));
    const { central } = readHeaders(bytes);
    const byName = Object.fromEntries(central.map((entry) => [entry.name, entry]));
    for (const name of ['book.xlsx', 'inner.ZIP', 'photo.PNG', 'clip.mp4', 'empty.xlsx']) {
      expect(byName[name]!.method, name).toBe(0);
      expect(byName[name]!.compressedSize, name).toBe(byName[name]!.size);
    }
    expect(byName['book.xlsx']!.compressedSize).toBe(payload.length);
    for (const name of ['notes.txt', 'readme']) expect(byName[name]!.method, name).toBe(8);
    expect(byName['notes.txt']!.compressedSize).toBeLessThan(1000);
  });

  it('writes the CRC-32 and both sizes into every local file header and into the central directory, and no entry uses a descriptor', async () => {
    const bytes = await bytesOf(await build(entries));
    const { central, local } = readHeaders(bytes);
    expect(local.map((h) => h.name)).toEqual(entries.map(([name]) => name));
    for (let i = 0; i < central.length; i += 1) {
      const [, data] = entries[i]!;
      const raw = typeof data === 'string' ? strToU8(data) : data;
      for (const header of [central[i]!, local[i]!]) {
        expect(header.flags & 0x0008, `${header.name}: flags ${header.flags}`).toBe(0);
        expect(header.crc, `${header.name} crc`).toBe(nodeCrc32(raw));
        expect(header.size, `${header.name} size`).toBe(raw.length);
      }
      expect(local[i]!.method).toBe(central[i]!.method);
      expect(local[i]!.flags).toBe(central[i]!.flags);
      expect(local[i]!.compressedSize).toBe(central[i]!.compressedSize);
    }
  });

  it('can be read by a strict sequential reader that never looks at the central directory', async () => {
    const bytes = await bytesOf(await build(entries));
    const read = readSequentially(bytes);
    expect(read.map((entry) => entry.name)).toEqual(entries.map(([name]) => name));
    for (let i = 0; i < read.length; i += 1) {
      const [, data] = entries[i]!;
      expect(Buffer.from(read[i]!.data).equals(Buffer.from(typeof data === 'string' ? strToU8(data) : data))).toBe(true);
    }
  });

  it.each([7, 1000, 65_536])('can be read by a streaming reader that never sees the central directory (%i byte chunks)', async (chunk) => {
    const bytes = await bytesOf(await build(entries));
    const files = streamUnzip(bytes, chunk);
    expect(Object.keys(files)).toEqual(entries.map(([name]) => name));
    for (const [name, data] of entries) {
      expect(Buffer.from(files[name]!).equals(Buffer.from(typeof data === 'string' ? strToU8(data) : data)), name).toBe(true);
    }
  });

  it('can be read by a streaming reader that is fed one byte at a time', async () => {
    const small = new Uint8Array(3000).fill(5);
    const zip = await build([
      ['a.xlsx', small],
      ['b.txt', small],
    ]);
    const files = streamUnzip(await bytesOf(zip), 1);
    expect(Object.keys(files)).toEqual(['a.xlsx', 'b.txt']);
    expect(Buffer.from(files['a.xlsx']!).equals(Buffer.from(small))).toBe(true);
    expect(Buffer.from(files['b.txt']!).equals(Buffer.from(small))).toBe(true);
  });

  it('round-trips through the central-directory reader too, with every offset right', async () => {
    const bytes = await bytesOf(await build(entries));
    const files = unzipSync(bytes);
    expect(files['book.xlsx']).toEqual(payload);
    expect(files['inner.ZIP']).toEqual(payload);
    const { central, directoryOffset } = readHeaders(bytes);
    for (let i = 1; i < central.length; i += 1) expect(central[i]!.offset).toBeGreaterThan(central[i - 1]!.offset);
    expect(central[central.length - 1]!.offset).toBeLessThan(directoryOffset);
  });

  it('`store` overrides the guess in both directions', async () => {
    const zip = await build([
      ['forced.txt', payload, { store: true }],
      ['deflated.xlsx', payload, { store: false }],
    ]);
    const { central } = readHeaders(await bytesOf(zip));
    expect(central[0]).toMatchObject({ method: 0, compressedSize: payload.length });
    expect(central[1]).toMatchObject({ method: 8 });
    expect(central[1]!.compressedSize).toBeLessThan(1000);
    const files = await unzip(zip);
    expect(files['forced.txt']).toEqual(payload);
    expect(files['deflated.xlsx']).toEqual(payload);
  });

  it('stays readable when the entry is empty or incompressible noise', async () => {
    const data = noise(150_000, 99);
    const zip = await build([
      ['empty.xlsx', new Uint8Array(0)],
      ['noise.xlsx', new Blob([data])],
      ['noise.bin', data],
    ]);
    const bytes = await bytesOf(zip);
    const files = unzipSync(bytes);
    expect(files['noise.xlsx']).toEqual(data);
    expect(files['noise.bin']).toEqual(data);
    const streamed = streamUnzip(bytes, 4096);
    expect(streamed['empty.xlsx']).toHaveLength(0);
    expect(Buffer.from(streamed['noise.xlsx']!).equals(Buffer.from(data))).toBe(true);
    expect(readSequentially(bytes)).toHaveLength(3);
  });

  it('a stored Blob is referenced, not copied: its bytes are read once (for the CRC) and end up in the archive as they are', async () => {
    const data = noise(300_000, 5);
    const blob = new Blob([data]);
    const streamSpy = vi.spyOn(blob, 'stream');
    const zip = await build([['photo.jpg', blob]]);
    expect(streamSpy).toHaveBeenCalledTimes(1);
    const files = await unzip(zip);
    expect(Buffer.from(files['photo.jpg']!).equals(Buffer.from(data))).toBe(true);
  });

  it('reads Blobs without stream() (as in jsdom) through slices', async () => {
    const real = new Blob(['no stream ', '블롭 ', 'x'.repeat(2_500_000)]);
    const streamless = new Proxy(real, {
      get(target, prop) {
        if (prop === 'stream') return undefined;
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    expect(typeof streamless.stream).not.toBe('function');
    const zip = await build([
      ['dom.txt', streamless],
      ['dom.png', streamless],
    ]);
    const files = await unzip(zip);
    const expected = `no stream 블롭 ${'x'.repeat(2_500_000)}`;
    expect(strFromU8(files['dom.txt']!)).toBe(expected);
    expect(strFromU8(files['dom.png']!)).toBe(expected);
  });

  it('is exact for every size around the chunk boundaries', async () => {
    for (const size of [1, 2, 255, 256, 1023, 1024, 65_535, 65_536, 65_537, 262_143, 262_144, 262_145, 1_048_575, 1_048_576, 1_048_577]) {
      const data = noise(size, size);
      const zip = await build([
        ['a.txt', data],
        ['b.mp4', data],
      ]);
      const read = readSequentially(await bytesOf(zip));
      expect(Buffer.from(read[0]!.data).equals(Buffer.from(data)), `deflated ${size}`).toBe(true);
      expect(Buffer.from(read[1]!.data).equals(Buffer.from(data)), `stored ${size}`).toBe(true);
    }
  });
});

describe('ZipAssembler: paths', () => {
  it('rejects unsafe paths and leaves the archive as it was', async () => {
    const zip = new ZipAssembler();
    for (const path of ['../evil.txt', 'a/../b.txt', '/abs.txt', 'a//b.txt', 'a\\b.txt', '', './x.txt', 'a/./b.txt', 'nul\0.txt', 'a/']) {
      await expect(zip.add(path, 'x')).rejects.toThrow(/Unsafe ZIP entry path/);
    }
    expect(zip.entryCount).toBe(0);
    expect(await unzip(await zip.finish())).toEqual({});
  });

  it('makes a path that is taken unique instead of failing, and returns the path it used', async () => {
    const zip = new ZipAssembler();
    expect(await zip.add('a/chat.html', '1')).toBe('a/chat.html');
    expect(await zip.add('a/chat.html', '2')).toBe('a/chat (2).html');
    expect(await zip.add('A/CHAT.HTML', '3')).toBe('A/CHAT (3).HTML');
    expect(zip.paths).toEqual(['a/chat.html', 'a/chat (2).html', 'A/CHAT (3).HTML']);
    const files = await unzip(await zip.finish());
    expect(Object.keys(files)).toEqual(['a/chat.html', 'a/chat (2).html', 'A/CHAT (3).HTML']);
    expect(strFromU8(files['a/chat (2).html']!)).toBe('2');
  });

  it('never makes an entry both a file and a folder', async () => {
    const zip = new ZipAssembler();
    await zip.add('a/b.txt', 'file');
    expect(await zip.add('a', 'x')).toBe('a (2)');
    expect(await zip.add('a/b.txt/c.txt', 'inner')).toBe('a/b.txt (2)/c.txt');
    const names = Object.keys(await unzip(await zip.finish()));
    for (const outer of names) for (const inner of names) expect(inner.startsWith(`${outer}/`)).toBe(false);
  });

  it('refuses a path that does not fit the ZIP name field', async () => {
    const zip = new ZipAssembler();
    await expect(zip.add(`${'a'.repeat(70_000)}.txt`, 'x')).rejects.toThrow(/too long/);
    expect(zip.entryCount).toBe(0);
    // ...and the path is free again
    expect(await zip.add('ok.txt', 'x')).toBe('ok.txt');
  });
});

describe('ZipAssembler: failed and cancelled entries leave nothing behind', () => {
  it('a cancelled entry is not in the archive; the ones before it are, and the path can be used again', async () => {
    const zip = new ZipAssembler();
    await zip.add('one.txt', '1');
    const controller = new AbortController();
    const big = new Blob([new Uint8Array(6 * 1024 * 1024).fill(9)]);
    const second = zip.add('two.txt', big, { signal: controller.signal });
    controller.abort();
    await expect(second).rejects.toMatchObject({ name: 'AbortError' });
    expect(zip.paths).toEqual(['one.txt']);
    expect(await zip.add('two.txt', '2')).toBe('two.txt'); // not "two (2).txt": the failed entry released its path
    const files = await unzip(await zip.finish());
    expect(Object.keys(files)).toEqual(['one.txt', 'two.txt']);
    expect(strFromU8(files['two.txt']!)).toBe('2');
  });

  it('a signal that is already aborted rejects without reading the data', async () => {
    const controller = new AbortController();
    controller.abort();
    const blob = textBlob('x');
    const streamSpy = vi.spyOn(blob, 'stream');
    const zip = new ZipAssembler();
    await expect(zip.add('a.txt', blob, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(streamSpy).not.toHaveBeenCalled();
    expect(zip.entryCount).toBe(0);
  });

  it('stops when aborted in the middle of a big entry', async () => {
    const controller = new AbortController();
    const big = new Blob([new Uint8Array(8 * 1024 * 1024).fill(9)]);
    const zip = new ZipAssembler();
    const promise = zip.add('big.bin', big, { signal: controller.signal });
    setTimeout(() => controller.abort(), 0);
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(zip.entryCount).toBe(0);
    expect(zip.inputBytes).toBe(0);
  });

  it('an entry whose data cannot be read fails alone', async () => {
    const zip = new ZipAssembler();
    await zip.add('ok.txt', 'ok');
    const broken = new Blob(['x']);
    Object.defineProperty(broken, 'stream', {
      value: () => new ReadableStream({ pull: () => Promise.reject(new TypeError('disk error')) }),
    });
    await expect(zip.add('broken.txt', broken)).rejects.toThrow('disk error');
    await zip.add('after.txt', 'after');
    expect(Object.keys(await unzip(await zip.finish()))).toEqual(['ok.txt', 'after.txt']);
  });

  it('finish ignores an aborted signal: cancelling during packaging still delivers every finished entry', async () => {
    const controller = new AbortController();
    const zip = new ZipAssembler();
    await zip.add('chat 1.html', '<p>one</p>', { signal: controller.signal });
    await zip.add('chat 2.html', '<p>two</p>', { signal: controller.signal });
    const third = zip.add('chat 3.html', new Blob([new Uint8Array(5 * 1024 * 1024).fill(1)]), { signal: controller.signal });
    controller.abort(); // the user cancels while the third chat is being packaged
    await expect(third).rejects.toMatchObject({ name: 'AbortError' });
    const archive = await zip.finish(); // no signal is consulted
    const files = await unzip(archive);
    expect(Object.keys(files)).toEqual(['chat 1.html', 'chat 2.html']);
    expect(strFromU8(files['chat 2.html']!)).toBe('<p>two</p>');
  });
});

describe('ZipAssembler: finishing', () => {
  it('waits for entries that are still being added', async () => {
    const zip = new ZipAssembler();
    const pending = [
      zip.add('a.txt', 'a'.repeat(2_000_000)),
      zip.add('b.txt', new Blob(['b'.repeat(1_000_000)])),
      zip.add('c.xlsx', noise(400_000)),
    ];
    const archive = await zip.finish();
    await Promise.all(pending);
    const files = await unzip(archive);
    expect(Object.keys(files).sort()).toEqual(['a.txt', 'b.txt', 'c.xlsx']);
    expect(strFromU8(files['b.txt']!)).toBe('b'.repeat(1_000_000));
  });

  it('concurrent adds are not interleaved: every entry is intact', async () => {
    const zip = new ZipAssembler();
    const blobs = Array.from({ length: 6 }, (_, i) => noise(120_000 + i, i + 1));
    await Promise.all(blobs.map((data, i) => zip.add(`file${i}.${i % 2 === 0 ? 'bin' : 'jpg'}`, data)));
    const bytes = await bytesOf(await zip.finish());
    const read = readSequentially(bytes);
    expect(read).toHaveLength(6);
    for (const entry of read) {
      const index = Number(/file(\d)/.exec(entry.name)![1]);
      expect(Buffer.from(entry.data).equals(Buffer.from(blobs[index]!))).toBe(true);
    }
  });

  it('can be called again and returns the same archive; adding afterwards fails', async () => {
    const zip = new ZipAssembler();
    await zip.add('a.txt', 'a');
    const first = await zip.finish();
    expect(await zip.finish()).toBe(first);
    await expect(zip.add('b.txt', 'b')).rejects.toThrow(/finished/);
    expect(Object.keys(await unzip(first))).toEqual(['a.txt']);
  });

  it('an archive of entries that all failed is a valid empty archive', async () => {
    const zip = new ZipAssembler();
    await expect(zip.add('../bad', 'x')).rejects.toThrow();
    expect((await zip.finish()).size).toBe(22);
  });

  it('counts entries and input bytes', async () => {
    const zip = new ZipAssembler();
    expect(zip.entryCount).toBe(0);
    expect(zip.inputBytes).toBe(0);
    await zip.add('a.txt', '한글'); // 6 bytes in UTF-8
    await zip.add('b.bin', new Uint8Array(10));
    await zip.add('c.png', new Blob([new Uint8Array(100)]));
    expect(zip.entryCount).toBe(3);
    expect(zip.inputBytes).toBe(116);
  });

  it('yields to the event loop while compressing', async () => {
    const big = new Blob([new Uint8Array(8 * 1024 * 1024).fill(65)]);
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 0);
    try {
      await build([['big.txt', big]]);
    } finally {
      clearInterval(timer);
    }
    expect(ticks).toBeGreaterThan(0);
  });
});

describe('ZipAssembler: the limits of a plain ZIP', () => {
  it('exposes the limits the engine has to respect', () => {
    expect(MAX_ZIP_INPUT_BYTES).toBeLessThan(2 ** 32);
    expect(MAX_ZIP_ENTRIES).toBe(65_535);
  });

  it('limitFor says which limit one more entry of that size would break, without adding anything', () => {
    const zip = new ZipAssembler();
    expect(zip.limitFor(0)).toBeNull();
    expect(zip.limitFor(MAX_ZIP_INPUT_BYTES)).toBeNull();
    expect(zip.limitFor(MAX_ZIP_INPUT_BYTES + 1)).toBe('bytes');
    expect(zip.entryCount).toBe(0);
  });

  it('rejects an entry above the byte limit with a ZipLimitError for "bytes", and takes one that is exactly at the limit', async () => {
    // Only the declared size is looked at before anything is read; the empty blob behind the fake size is what gets read.
    const sized = (size: number): Blob => Object.defineProperty(new Blob([]), 'size', { value: size });
    const zip = new ZipAssembler();
    const failure = await zip.add('a.bin', sized(MAX_ZIP_INPUT_BYTES + 1)).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ZipLimitError);
    expect(failure).toBeInstanceOf(RangeError);
    expect(failure).toMatchObject({ limit: 'bytes', name: 'ZipLimitError' });
    expect((failure as Error).message).toMatch(/too large/);
    expect(zip.entryCount).toBe(0);
    await expect(zip.add('b.bin', sized(MAX_ZIP_INPUT_BYTES))).resolves.toBe('b.bin');
  });

  it('counts the bytes added so far against the byte limit (a smaller limit, injected)', async () => {
    const zip = new ZipAssembler(undefined, { maxInputBytes: 1000 });
    await zip.add('a.bin', new Uint8Array(600));
    expect(zip.limitFor(400)).toBeNull();
    expect(zip.limitFor(401)).toBe('bytes');
    await expect(zip.add('b.bin', new Uint8Array(401))).rejects.toMatchObject({ name: 'ZipLimitError', limit: 'bytes' });
    await expect(zip.add('c.bin', new Uint8Array(400))).resolves.toBe('c.bin');
    expect(zip.inputBytes).toBe(1000);
    // the failed entry did not use up its path or any room
    expect(Object.keys(await unzip(await zip.finish()))).toEqual(['a.bin', 'c.bin']);
  });

  it('rejects an entry beyond the entry limit with a ZipLimitError for "entries" (a smaller limit, injected)', async () => {
    const zip = new ZipAssembler(undefined, { maxEntries: 3 });
    for (const name of ['a', 'b', 'c']) await zip.add(`${name}.txt`, name);
    expect(zip.limitFor(0)).toBe('entries');
    const failure = await zip.add('d.txt', 'd').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ZipLimitError);
    expect(failure).toMatchObject({ limit: 'entries' });
    expect(Object.keys(await unzip(await zip.finish()))).toEqual(['a.txt', 'b.txt', 'c.txt']);
  });

  it('really holds more than 65,535 entries back (the default limit)', async () => {
    const zip = new ZipAssembler();
    // 65,535 tiny stored entries are cheap enough to write for real.
    for (let i = 0; i < MAX_ZIP_ENTRIES; i += 1) await zip.add(`${i}.txt`, '');
    expect(zip.entryCount).toBe(MAX_ZIP_ENTRIES);
    await expect(zip.add('one-too-many.txt', '')).rejects.toMatchObject({ name: 'ZipLimitError', limit: 'entries' });
    const archive = await zip.finish();
    const { central } = readHeaders(await bytesOf(archive));
    expect(central).toHaveLength(MAX_ZIP_ENTRIES);
  }, 60_000);
});

describe('crc32', () => {
  it('matches the reference implementation, also when chained over chunks', () => {
    const data = noise(100_000, 3);
    expect(crc32(data)).toBe(nodeCrc32(data));
    let chained = 0;
    for (let at = 0; at < data.length; at += 7777) chained = crc32(data.subarray(at, at + 7777), chained);
    expect(chained).toBe(nodeCrc32(data));
    expect(crc32(new Uint8Array(0))).toBe(0);
    expect(crc32(strToU8('123456789'))).toBe(0xcbf43926);
  });
});

describe('BlobAssembler', () => {
  it('concatenates strings and bytes in call order and sets the type', async () => {
    const assembler = new BlobAssembler(4);
    assembler.push('ab');
    assembler.push(strToU8('cd'));
    assembler.push('');
    assembler.push('ef');
    const blob = assembler.toBlob('text/x-test');
    expect(blob.type).toBe('text/x-test');
    expect(await blob.text()).toBe('abcdef');
  });

  it('is usable again after toBlob()', async () => {
    const assembler = new BlobAssembler();
    assembler.push('a');
    expect(await assembler.toBlob('text/plain').text()).toBe('a');
    assembler.push('b');
    expect(await assembler.toBlob('text/plain').text()).toBe('ab');
  });

  it('takes a Blob by reference in the right place of the sequence', async () => {
    const assembler = new BlobAssembler();
    assembler.push('<');
    assembler.pushBlob(new Blob(['middle']));
    assembler.pushBlob(new Blob([]));
    assembler.push('>');
    expect(await assembler.toBlob('text/plain').text()).toBe('<middle>');
  });
});
