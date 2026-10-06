import { Deflate } from 'fflate';
import { ZipPathIndex } from './filename';

/** What can be put into a ZIP entry: text (encoded as UTF-8), bytes, or a `Blob` (a download, a saved file ...). */
export type ZipData = string | Uint8Array | Blob;

export interface ZipAddOptions {
  /**
   * Write the bytes uncompressed (ZIP method 0, "stored"). Default: stored for formats that are compressed already (see
   * `INCOMPRESSIBLE_EXT`), deflated for everything else. A stored entry is never empty-handed either: its CRC and sizes are in
   * its local header.
   */
  store?: boolean;
  /** Cancels THIS entry (nothing of it is written); the entries added before are not affected. Rejects with an `AbortError`. */
  signal?: AbortSignal;
  /** Modification time of the entry; default: now. */
  mtime?: Date;
}

const DEFLATE_LEVEL = 6;
/**
 * Already-compressed containers and media gain nothing from deflate, so they are stored (method 0): faster, and the bytes of
 * an attachment stay readable in the archive as they are.
 */
const INCOMPRESSIBLE_EXT =
  /\.(?:xlsx|docx|pptx|zip|7z|rar|gz|bz2|xz|zst|jar|apk|pdf|jpe?g|png|gif|webp|avif|heic|mp3|m4a|aac|ogg|opus|flac|mp4|m4v|mov|webm|mkv|avi|wmv)$/i;
/** Give the event loop a turn after this many input bytes so timers and messages keep running. */
const YIELD_EVERY_BYTES = 256 * 1024;
/** Slice size of in-memory data and of a Blob without `stream()` (jsdom). */
const SLICE_BYTES = 1024 * 1024;
/**
 * Limits of a plain ZIP: no ZIP64, so sizes and offsets are 32-bit (the byte limit leaves 256 MB of head room for headers and
 * the central directory below 4 GiB) and the entry count is 16-bit. A larger export has to be split over several archives.
 */
export const MAX_ZIP_INPUT_BYTES = 0xf000_0000;
export const MAX_ZIP_ENTRIES = 0xffff;
const MAX_NAME_BYTES = 0xffff;

export type ZipLimitKind = 'bytes' | 'entries';

/** The entries cannot be written as one plain ZIP; `limit` says which of the two limits above was hit. */
export class ZipLimitError extends RangeError {
  constructor(
    readonly limit: ZipLimitKind,
    message: string,
  ) {
    super(message);
    this.name = 'ZipLimitError';
  }
}

/**
 * Collects output chunks into Blobs as it goes. Browsers can back a Blob with disk storage, so a very large export
 * does not have to live in the JS heap as one giant string / ArrayBuffer.
 */
export class BlobAssembler {
  private readonly parts: Blob[] = [];
  private pending: BlobPart[] = [];
  private pendingUnits = 0;

  constructor(private readonly flushAtUnits = 8 * 1024 * 1024) {}

  push(chunk: string | Uint8Array): void {
    if (chunk.length === 0) return;
    // fflate hands out ArrayBuffer-backed views; the cast only narrows the `ArrayBufferLike` in its typings.
    this.pending.push(typeof chunk === 'string' ? chunk : (chunk as Uint8Array<ArrayBuffer>));
    this.pendingUnits += chunk.length;
    if (this.pendingUnits >= this.flushAtUnits) this.flush();
  }

  /** Appends a Blob by reference: its bytes are not copied or read. */
  pushBlob(blob: Blob): void {
    if (blob.size === 0) return;
    this.flush();
    this.parts.push(blob);
  }

  toBlob(type: string): Blob {
    this.flush();
    return new Blob(this.parts, { type });
  }

  private flush(): void {
    if (this.pending.length === 0) return;
    this.parts.push(new Blob(this.pending));
    this.pending = [];
    this.pendingUnits = 0;
  }
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    // MessageChannel is not clamped to 4 ms like nested setTimeout, and is not throttled in background tabs.
    if (typeof MessageChannel === 'undefined') {
      setTimeout(resolve, 0);
      return;
    }
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

const encoder = new TextEncoder();

/** The data as byte chunks, read lazily. */
async function* chunksOf(data: ZipData): AsyncGenerator<Uint8Array> {
  if (typeof data === 'string') {
    const bytes = encoder.encode(data);
    for (let offset = 0; offset < bytes.length; offset += SLICE_BYTES) yield bytes.subarray(offset, offset + SLICE_BYTES);
    return;
  }
  if (data instanceof Uint8Array) {
    for (let offset = 0; offset < data.length; offset += SLICE_BYTES) yield data.subarray(offset, offset + SLICE_BYTES);
    return;
  }
  if (typeof data.stream !== 'function') {
    for (let offset = 0; offset < data.size; offset += SLICE_BYTES) {
      yield new Uint8Array(await data.slice(offset, offset + SLICE_BYTES).arrayBuffer());
    }
    return;
  }
  const reader = data.stream().getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value.length > 0) yield value;
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
}

function sizeOf(data: ZipData): number {
  if (typeof data === 'string') return encoder.encode(data).length;
  return data instanceof Uint8Array ? data.length : data.size;
}

function assertSafeEntryPath(path: string): void {
  const segments = path.split('/');
  const unsafe =
    path === '' ||
    path.includes('\\') ||
    path.includes('\0') ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..');
  if (unsafe) throw new Error(`Unsafe ZIP entry path: ${JSON.stringify(path)}`);
}

// ---------------------------------------------------------------------------------------------------------------------
// CRC-32 and the container format
// ---------------------------------------------------------------------------------------------------------------------

const CRC_TABLE: Int32Array = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

/** CRC-32 (IEEE, as ZIP uses it) of `bytes`, continuing from `crc` (the result of the previous call, 0 to start). */
export function crc32(bytes: Uint8Array, crc = 0): number {
  let c = ~crc;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;
/** "Version needed to extract" 2.0: deflate, folders. */
const VERSION = 20;
/** General-purpose flag bit 11: the entry name is UTF-8. */
const FLAG_UTF8 = 0x0800;

interface EntryRecord {
  name: Uint8Array;
  method: 0 | 8;
  crc: number;
  compressedSize: number;
  size: number;
  offset: number;
  dosTime: number;
  dosDate: number;
}

/** DOS time and date of `date`; ZIP only covers 1980-2099, so anything else (an invalid Date, a mocked clock) reads as now. */
function dosStamp(date: Date): { dosTime: number; dosDate: number } {
  const valid = Number.isFinite(date.getTime()) && date.getFullYear() >= 1980 && date.getFullYear() <= 2099;
  const d = valid ? date : new Date();
  return {
    dosTime: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    dosDate: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** A local file header: the CRC and the sizes are in it (no data descriptor follows the data), for stored and deflated entries alike. */
function localHeader(entry: EntryRecord): Uint8Array {
  const header = new Uint8Array(30 + entry.name.length);
  const view = new DataView(header.buffer);
  view.setUint32(0, LOCAL_SIGNATURE, true);
  view.setUint16(4, VERSION, true);
  view.setUint16(6, FLAG_UTF8, true);
  view.setUint16(8, entry.method, true);
  view.setUint16(10, entry.dosTime, true);
  view.setUint16(12, entry.dosDate, true);
  view.setUint32(14, entry.crc, true);
  view.setUint32(18, entry.compressedSize, true);
  view.setUint32(22, entry.size, true);
  view.setUint16(26, entry.name.length, true);
  header.set(entry.name, 30);
  return header;
}

/** The central directory followed by the end-of-central-directory record; `directoryOffset` is where the directory starts in the archive. */
function centralDirectory(entries: readonly EntryRecord[], directoryOffset: number): Uint8Array {
  const length = entries.reduce((sum, entry) => sum + 46 + entry.name.length, 0);
  const out = new Uint8Array(length + 22);
  const view = new DataView(out.buffer);
  let at = 0;
  for (const entry of entries) {
    view.setUint32(at, CENTRAL_SIGNATURE, true);
    view.setUint16(at + 4, VERSION, true); // version made by (MS-DOS attributes)
    view.setUint16(at + 6, VERSION, true);
    view.setUint16(at + 8, FLAG_UTF8, true);
    view.setUint16(at + 10, entry.method, true);
    view.setUint16(at + 12, entry.dosTime, true);
    view.setUint16(at + 14, entry.dosDate, true);
    view.setUint32(at + 16, entry.crc, true);
    view.setUint32(at + 20, entry.compressedSize, true);
    view.setUint32(at + 24, entry.size, true);
    view.setUint16(at + 28, entry.name.length, true);
    view.setUint32(at + 42, entry.offset, true);
    out.set(entry.name, at + 46);
    at += 46 + entry.name.length;
  }
  view.setUint32(at, END_SIGNATURE, true);
  view.setUint16(at + 8, entries.length, true);
  view.setUint16(at + 10, entries.length, true);
  view.setUint32(at + 12, length, true);
  view.setUint32(at + 16, directoryOffset, true);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// the assembler
// ---------------------------------------------------------------------------------------------------------------------

interface Built {
  record: EntryRecord;
  /** Header already inside; what follows it. */
  body: Array<Uint8Array | Blob>;
}

/**
 * Builds one ZIP archive entry by entry, so that the engine can put finished chats and attachment bytes in as they come
 * and never has to hold them all at once (the archive is assembled as `Blob` parts).
 *
 * - Every entry carries its CRC and sizes in its local file header; there are no data descriptors, so even sequential
 *   readers that reject "stored entry + descriptor" (for example Java's `ZipInputStream`) can read the archive.
 * - Entries are deflated, except those whose type is compressed already (`.xlsx`, `.zip`, images, video ...), which are stored.
 * - `add` never throws away what is already in: it is atomic (an entry that fails or is cancelled leaves nothing behind), a
 *   path that is taken is made unique (case-insensitive, file vs folder) instead of failing, and `finish` ignores aborts
 *   (packaging is local work that always ends with a valid archive of everything that was added).
 * - A plain ZIP has limits (`MAX_ZIP_ENTRIES`, `MAX_ZIP_INPUT_BYTES`): `add` throws a `ZipLimitError` for an entry that no longer fits.
 */
export class ZipAssembler {
  private readonly output = new BlobAssembler();
  private readonly records: EntryRecord[] = [];
  private readonly index = new ZipPathIndex();
  private readonly pending = new Set<Promise<unknown>>();
  private offset = 0;
  private bytes = 0;
  private reserved = 0;
  private closed = false;
  private result: Promise<Blob> | null = null;

  private readonly maxEntries: number;
  private readonly maxInputBytes: number;

  /**
   * `now` stamps entries that have no time of their own. `limits` are for tests (and for an engine that wants smaller parts):
   * they can only be lower than the limits of a plain ZIP.
   */
  constructor(
    private readonly now: () => Date = () => new Date(),
    limits: { maxEntries?: number; maxInputBytes?: number } = {},
  ) {
    this.maxEntries = Math.min(limits.maxEntries ?? MAX_ZIP_ENTRIES, MAX_ZIP_ENTRIES);
    this.maxInputBytes = Math.min(limits.maxInputBytes ?? MAX_ZIP_INPUT_BYTES, MAX_ZIP_INPUT_BYTES);
  }

  /** Entries committed so far. */
  get entryCount(): number {
    return this.records.length;
  }

  /** Uncompressed bytes of the entries committed so far. */
  get inputBytes(): number {
    return this.bytes;
  }

  /** The paths (as added, i.e. made unique) of the entries committed so far, in order. */
  get paths(): string[] {
    return this.records.map((record) => new TextDecoder().decode(record.name));
  }

  /** Which limit adding one more entry of `bytes` would break; null when it fits. */
  limitFor(bytes: number): ZipLimitKind | null {
    if (this.records.length + this.reserved + 1 > this.maxEntries) return 'entries';
    return this.bytes + bytes > this.maxInputBytes ? 'bytes' : null;
  }

  /**
   * Adds one entry and returns its final path (`path`, or a variant of it when `path` clashed with an earlier entry).
   * Rejects with `ZipLimitError` (limits), an `Error` (unsafe path) or an `AbortError` (`opts.signal`); in every case the
   * archive is exactly as it was before the call.
   */
  async add(path: string, data: ZipData, opts: ZipAddOptions = {}): Promise<string> {
    if (this.closed) throw new Error('The ZIP archive is finished: no entries can be added.');
    assertSafeEntryPath(path);
    const signal = opts.signal;
    if (signal?.aborted) throw abortError();

    const size = sizeOf(data);
    const limit = this.limitFor(size);
    if (limit !== null) {
      throw new ZipLimitError(
        limit,
        limit === 'entries'
          ? `Too many ZIP entries (more than ${this.maxEntries}).`
          : 'The export is too large for a ZIP file (about 3.75 GB limit). Export fewer chats at once.',
      );
    }

    const finalPath = this.index.claim(path);
    const name = encoder.encode(finalPath);
    if (name.length > MAX_NAME_BYTES) {
      this.index.remove(finalPath);
      throw new Error('ZIP entry path is too long.');
    }
    this.reserved += 1;
    // Built and committed in one piece, so `finish` can wait for exactly the entries that are going to be in the archive.
    const work = this.build(name, data, size, opts).then((built) => this.commit(built));
    this.pending.add(work);
    try {
      await work;
      return finalPath;
    } catch (error) {
      this.index.remove(finalPath);
      throw error;
    } finally {
      this.reserved -= 1;
      this.pending.delete(work);
    }
  }

  /**
   * The finished archive: everything that was added. Waits for entries that are still being added (one that fails or is
   * cancelled is simply not in it). Never rejects because of an aborted signal; the assembler cannot be added to afterwards.
   * Calling it again returns the same archive.
   */
  finish(): Promise<Blob> {
    this.result ??= (async () => {
      this.closed = true;
      await Promise.allSettled([...this.pending]);
      this.output.push(centralDirectory(this.records, this.offset));
      return this.output.toBlob('application/zip');
    })();
    return this.result;
  }

  private async build(name: Uint8Array, data: ZipData, size: number, opts: ZipAddOptions): Promise<Built> {
    const signal = opts.signal;
    const decoded = new TextDecoder().decode(name);
    const store = opts.store ?? (size === 0 || INCOMPRESSIBLE_EXT.test(decoded));
    const { dosTime, dosDate } = dosStamp(opts.mtime ?? this.now());

    let crc = 0;
    let total = 0;
    let sinceYield = 0;
    const compressed: Uint8Array[] = [];
    let compressedSize = 0;
    const deflater = store
      ? null
      : new Deflate({ level: DEFLATE_LEVEL }, (chunk) => {
          compressed.push(chunk);
          compressedSize += chunk.length;
        });

    for await (const chunk of chunksOf(data)) {
      crc = crc32(chunk, crc);
      total += chunk.length;
      deflater?.push(chunk, false);
      sinceYield += chunk.length;
      if (signal?.aborted) throw abortError();
      if (sinceYield >= YIELD_EVERY_BYTES) {
        sinceYield = 0;
        await yieldToEventLoop();
        if (signal?.aborted) throw abortError();
      }
    }
    deflater?.push(new Uint8Array(0), true);
    if (signal?.aborted) throw abortError();

    const record: EntryRecord = {
      name,
      method: store ? 0 : 8,
      crc,
      compressedSize: store ? total : compressedSize,
      size: total,
      offset: 0,
      dosTime,
      dosDate,
    };
    if (store) {
      const body: Array<Uint8Array | Blob> = typeof data === 'string' ? [encoder.encode(data)] : [data];
      return { record, body };
    }
    return { record, body: compressed };
  }

  /** Writes a built entry to the archive; synchronous, so entries are never interleaved. */
  private commit({ record, body }: Built): void {
    record.offset = this.offset;
    const header = localHeader(record);
    this.output.push(header);
    for (const part of body) {
      if (part instanceof Blob) this.output.pushBlob(part);
      else this.output.push(part);
    }
    this.offset += header.length + record.compressedSize;
    this.bytes += record.size;
    this.records.push(record);
  }
}
