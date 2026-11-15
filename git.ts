import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { inflateSync } from 'node:zlib';
import {
  type GitObject,
  type GitObjectType,
  ZERO_OID,
  getCompressedObject,
  hashObject,
  isOid,
  parseCommit,
  parseTag,
  parseTree,
} from './git-objects.ts';
import type { ForgeStore, RepoState } from './store.ts';

const AGENT = 'gitcore-forge/1.0.0';
const SIDEBAND_CHUNK_MAX = 65515; // 4 (pkt len) + 1 (band) + 65515 = 65520 PKT_LINE_MAX

const TYPE_TO_CODE: Record<GitObjectType, number> = {
  commit: 1,
  tree: 2,
  blob: 3,
  tag: 4,
};

const CODE_TO_TYPE: Record<number, GitObjectType> = {
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
};

const HEX_DIGITS = '0123456789abcdef';

function encodePktHexLen(len: number): string {
  return (
    HEX_DIGITS[(len >> 12) & 0xf]! +
    HEX_DIGITS[(len >> 8) & 0xf]! +
    HEX_DIGITS[(len >> 4) & 0xf]! +
    HEX_DIGITS[len & 0xf]!
  );
}

export function encodePktText(lines: readonly (string | 'flush' | 'delim')[]): Buffer {
  const parts: Buffer[] = new Array(lines.length);
  for (let i = 0; i < lines.length; i++) {
    const item = lines[i]!;
    if (item === 'flush') {
      parts[i] = Buffer.from('0000', 'ascii');
    } else if (item === 'delim') {
      parts[i] = Buffer.from('0001', 'ascii');
    } else {
      const payload = Buffer.from(item, 'utf8');
      const total = payload.length + 4;
      const out = Buffer.allocUnsafe(total);
      out.write(encodePktHexLen(total), 0, 4, 'ascii');
      payload.copy(out, 4);
      parts[i] = out;
    }
  }
  return Buffer.concat(parts);
}

export function encodePktData(payload: Buffer): Buffer {
  const total = payload.length + 4;
  const out = Buffer.allocUnsafe(total);
  out.write(encodePktHexLen(total), 0, 4, 'ascii');
  payload.copy(out, 4);
  return out;
}

export function encodeSidebandPack(pack: Buffer, prefixParts: readonly Buffer[] = [], includeTrailingFlush = true): Buffer {
  const chunkCount = Math.max(1, Math.ceil(pack.length / SIDEBAND_CHUNK_MAX));
  let totalBytes = 0;
  for (const p of prefixParts) totalBytes += p.length;
  for (let off = 0; off < pack.length; off += SIDEBAND_CHUNK_MAX) {
    const sliceLen = Math.min(SIDEBAND_CHUNK_MAX, pack.length - off);
    totalBytes += 5 + sliceLen;
  }
  if (pack.length === 0) {
    // Unreachable for valid 32-byte pack, safeguard
    totalBytes += 5;
  }
  if (includeTrailingFlush) totalBytes += 4;

  const out = Buffer.allocUnsafe(totalBytes);
  let pos = 0;
  for (const p of prefixParts) {
    p.copy(out, pos);
    pos += p.length;
  }
  if (chunkCount === 1 && pack.length === 0) {
    out.write('0005', pos, 4, 'ascii');
    out[pos + 4] = 1;
    pos += 5;
  } else {
    for (let off = 0; off < pack.length; off += SIDEBAND_CHUNK_MAX) {
      const sliceLen = Math.min(SIDEBAND_CHUNK_MAX, pack.length - off);
      const pktLen = 5 + sliceLen;
      out.write(encodePktHexLen(pktLen), pos, 4, 'ascii');
      out[pos + 4] = 1;
      pack.copy(out, pos + 5, off, off + sliceLen);
      pos += pktLen;
    }
  }
  if (includeTrailingFlush) {
    out.write('0000', pos, 4, 'ascii');
  }
  return out;
}

type DecodedPkt =
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'data'; payload: Buffer };

function parsePktStream(buf: Buffer): { packets: DecodedPkt[]; remainderOffset: number } {
  const packets: DecodedPkt[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) {
      throw new Error('truncated pkt-line header');
    }
    const hex = buf.toString('ascii', offset, offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
      throw new Error(`invalid pkt-line length prefix: ${JSON.stringify(hex)}`);
    }
    const len = Number.parseInt(hex, 16);
    offset += 4;
    if (len === 0) {
      packets.push({ kind: 'flush' });
      continue;
    }
    if (len === 1) {
      packets.push({ kind: 'delim' });
      continue;
    }
    if (len === 2 || len === 3 || len > 65520) {
      throw new Error(`invalid pkt-line length: ${len}`);
    }
    const payloadLen = len - 4;
    if (offset + payloadLen > buf.length) {
      throw new Error('truncated pkt-line payload');
    }
    packets.push({ kind: 'data', payload: buf.subarray(offset, offset + payloadLen) });
    offset += payloadLen;
  }
  return { packets, remainderOffset: offset };
}

function parseReceivePackHeaderAndBody(buf: Buffer): { lines: Buffer[]; pack: Buffer } {
  const lines: Buffer[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) throw new Error('truncated receive-pack pkt-line header');
    const hex = buf.toString('ascii', offset, offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
      throw new Error(`invalid pkt-line length: ${JSON.stringify(hex)}`);
    }
    const len = Number.parseInt(hex, 16);
    offset += 4;
    if (len === 0) {
      return { lines, pack: buf.subarray(offset) };
    }
    if (len < 4 || len > 65520) throw new Error(`invalid pkt-line length: ${len}`);
    const payloadLen = len - 4;
    if (offset + payloadLen > buf.length) throw new Error('truncated receive-pack pkt-line payload');
    lines.push(buf.subarray(offset, offset + payloadLen));
    offset += payloadLen;
  }
  throw new Error('receive-pack missing flush packet');
}

function readVarintSize(buffer: Buffer, offset: number): { first: number; size: number; next: number } {
  if (offset >= buffer.length) throw new Error('pack object header truncated');
  const first = buffer[offset++]!;
  let size = first & 0x0f;
  let shift = 4;
  let byte = first;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('pack object size varint truncated');
    byte = buffer[offset++]!;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 53) throw new Error('pack object size varint overflow');
  }
  return { first, size, next: offset };
}

function readOfsDeltaOffset(buffer: Buffer, offset: number): { dist: number; next: number } {
  if (offset >= buffer.length) throw new Error('ofs-delta offset truncated');
  let byte = buffer[offset++]!;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('ofs-delta offset varint truncated');
    byte = buffer[offset++]!;
    value = ((value + 1) << 7) | (byte & 0x7f);
  }
  return { dist: value, next: offset };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let val = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint truncated');
      const b = delta[offset++]!;
      val += (b & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    return val;
  };
  const srcSize = readSize();
  const dstSize = readSize();
  if (srcSize !== base.length) {
    throw new Error(`delta source size mismatch: expected ${srcSize}, got ${base.length}`);
  }
  const out = Buffer.allocUnsafe(dstSize);
  let outPos = 0;
  while (offset < delta.length) {
    const op = delta[offset++]!;
    if (op & 0x80) {
      let cpOff = 0;
      let cpLen = 0;
      if (op & 0x01) cpOff |= delta[offset++]!;
      if (op & 0x02) cpOff |= delta[offset++]! << 8;
      if (op & 0x04) cpOff |= delta[offset++]! << 16;
      if (op & 0x08) cpOff |= delta[offset++]! << 24;
      if (op & 0x10) cpLen |= delta[offset++]!;
      if (op & 0x20) cpLen |= delta[offset++]! << 8;
      if (op & 0x40) cpLen |= delta[offset++]! << 16;
      if (cpLen === 0) cpLen = 0x10000;
      if (cpOff + cpLen > base.length || outPos + cpLen > dstSize) {
        throw new Error('delta copy out of bounds');
      }
      base.copy(out, outPos, cpOff, cpOff + cpLen);
      outPos += cpLen;
    } else if (op !== 0) {
      if (offset + op > delta.length || outPos + op > dstSize) {
        throw new Error('delta insert out of bounds');
      }
      delta.copy(out, outPos, offset, offset + op);
      offset += op;
      outPos += op;
    } else {
      throw new Error('invalid delta opcode 0');
    }
  }
  if (outPos !== dstSize) throw new Error('delta output size mismatch');
  return out;
}

interface RawPackEntry {
  offset: number;
  typeCode: number;
  data: Buffer;
  compressed?: Buffer;
  baseOffset?: number;
  baseOid?: string;
  resolved?: GitObject;
}

function parsePackfile(pack: Buffer, existingObjects: ReadonlyMap<string, GitObject>): Map<string, GitObject> {
  if (pack.length < 32) throw new Error('packfile too short');
  if (pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('bad packfile header');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const expectedTrailer = pack.subarray(trailerStart);
  const actualTrailer = createHash('sha1').update(pack.subarray(0, trailerStart)).digest();
  if (!expectedTrailer.equals(actualTrailer)) {
    throw new Error('packfile checksum mismatch');
  }

  const raw: RawPackEntry[] = new Array(count);
  const byOffset = new Map<number, RawPackEntry>();
  let offset = 12;

  for (let i = 0; i < count; i++) {
    const entryOffset = offset;
    const hdr = readVarintSize(pack, offset);
    offset = hdr.next;
    const typeCode = (hdr.first >> 4) & 0x07;
    const entry: RawPackEntry = { offset: entryOffset, typeCode, data: Buffer.alloc(0) };

    if (typeCode === 6) {
      const ofs = readOfsDeltaOffset(pack, offset);
      offset = ofs.next;
      const baseOff = entryOffset - ofs.dist;
      if (ofs.dist <= 0 || baseOff < 12) throw new Error('invalid ofs-delta base offset');
      entry.baseOffset = baseOff;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('truncated ref-delta oid');
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TO_TYPE[typeCode]) {
      throw new Error(`unknown pack entry type ${typeCode}`);
    }

    const view = pack.subarray(offset, trailerStart);
    const inflated = inflateSync(view, { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    const consumed = inflated.engine.bytesWritten;
    if (!consumed || consumed <= 0) throw new Error('zlib consumed zero bytes');
    if (inflated.buffer.length !== hdr.size) {
      throw new Error(`pack entry inflated length ${inflated.buffer.length} != ${hdr.size}`);
    }
    entry.data = inflated.buffer;
    offset += consumed;
    raw[i] = entry;
    byOffset.set(entryOffset, entry);
  }

  if (offset !== trailerStart) {
    throw new Error('trailing bytes before packfile trailer');
  }

  const unpacked = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, GitObject>();
  const resolving = new Set<number>();

  const resolveEntry = (entry: RawPackEntry): GitObject => {
    if (entry.resolved) return entry.resolved;
    if (resolving.has(entry.offset)) throw new Error('delta cycle in packfile');
    resolving.add(entry.offset);

    let objType: GitObjectType;
    let objData: Buffer;
    let compressed: Buffer | undefined;

    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error('ofs-delta base missing');
      const base = resolveEntry(baseEntry);
      objType = base.type;
      objData = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid!;
      let base = resolvedByOid.get(wanted) ?? existingObjects.get(wanted);
      if (!base) {
        for (const cand of raw) {
          if (!cand.resolved && cand.typeCode >= 1 && cand.typeCode <= 4) {
            const candObj = resolveEntry(cand);
            if (candObj.oid === wanted) {
              base = candObj;
              break;
            }
          }
        }
      }
      if (!base) throw new Error(`ref-delta base ${wanted} missing`);
      objType = base.type;
      objData = applyDelta(base.data, entry.data);
    } else {
      objType = CODE_TO_TYPE[entry.typeCode]!;
      objData = entry.data;
      compressed = entry.compressed;
    }

    resolving.delete(entry.offset);
    const oid = hashObject(objType, objData);
    const obj: GitObject = { type: objType, data: objData, oid, compressed };
    entry.resolved = obj;
    unpacked.set(oid, obj);
    resolvedByOid.set(oid, obj);
    return obj;
  };

  for (const entry of raw) {
    resolveEntry(entry);
  }
  return unpacked;
}

function writeObjectHeaderInto(buf: Buffer, pos: number, type: GitObjectType, size: number): number {
  const code = TYPE_TO_CODE[type];
  let rem = size >>> 4;
  let byte = (code << 4) | (size & 0x0f);
  if (rem > 0) byte |= 0x80;
  buf[pos++] = byte;
  while (rem > 0) {
    const nextByte = rem & 0x7f;
    rem = Math.floor(rem / 128);
    buf[pos++] = rem > 0 ? nextByte | 0x80 : nextByte;
  }
  return pos;
}

function objectHeaderSize(size: number): number {
  let len = 1;
  let rem = size >>> 4;
  while (rem > 0) {
    len += 1;
    rem = Math.floor(rem / 128);
  }
  return len;
}

function buildPackfile(objects: readonly GitObject[]): Buffer {
  const compressedList: Buffer[] = new Array(objects.length);
  let bodyLen = 0;
  for (let i = 0; i < objects.length; i++) {
    const obj = objects[i]!;
    const comp = getCompressedObject(obj);
    compressedList[i] = comp;
    bodyLen += objectHeaderSize(obj.data.length) + comp.length;
  }
  const totalLen = 12 + bodyLen + 20;
  const pack = Buffer.allocUnsafe(totalLen);
  pack.write('PACK', 0, 4, 'ascii');
  pack.writeUInt32BE(2, 4);
  pack.writeUInt32BE(objects.length, 8);

  let pos = 12;
  for (let i = 0; i < objects.length; i++) {
    const obj = objects[i]!;
    pos = writeObjectHeaderInto(pack, pos, obj.type, obj.data.length);
    const comp = compressedList[i]!;
    comp.copy(pack, pos);
    pos += comp.length;
  }

  const trailer = createHash('sha1').update(pack.subarray(0, pos)).digest();
  trailer.copy(pack, pos);
  return pack;
}

function peelTag(objects: ReadonlyMap<string, GitObject>, oid: string): string | undefined {
  let cur = oid;
  let sawTag = false;
  for (let guard = 0; guard < 16; guard++) {
    const obj = objects.get(cur);
    if (!obj || obj.type !== 'tag') break;
    sawTag = true;
    cur = parseTag(obj.data).object;
  }
  return sawTag ? cur : undefined;
}

let v2UploadPackAdsBuf: Buffer | null = null;
function getV2UploadPackAds(): Buffer {
  if (v2UploadPackAdsBuf === null) {
    v2UploadPackAdsBuf = encodePktText([
      '# service=git-upload-pack\n',
      'flush',
      'version 2\n',
      `agent=${AGENT}\n`,
      'ls-refs=unborn\n',
      'fetch=shallow wait-for-done\n',
      'object-format=sha1\n',
      'flush',
    ]);
  }
  return v2UploadPackAdsBuf;
}

let okMainPlainReportBuf: Buffer | null = null;
function getOkMainPlainReport(): Buffer {
  if (okMainPlainReportBuf === null) {
    okMainPlainReportBuf = encodePktText(['unpack ok\n', 'ok refs/heads/main\n', 'flush']);
  }
  return okMainPlainReportBuf;
}

let okMainSidebandReportBuf: Buffer | null = null;
function getOkMainSidebandReport(): Buffer {
  if (okMainSidebandReportBuf === null) {
    okMainSidebandReportBuf = encodeSidebandPack(getOkMainPlainReport(), [], true);
  }
  return okMainSidebandReportBuf;
}

function buildAdvertisement(repo: RepoState, service: 'git-upload-pack' | 'git-receive-pack', protocolVersion: 0 | 2): Buffer {
  if (service === 'git-upload-pack' && protocolVersion === 2) {
    return getV2UploadPackAds();
  }
  const cacheKey = `${service}:v0`;
  const cached = repo.adsCache.get(cacheKey);
  if (cached) return cached;

  const caps =
    service === 'git-upload-pack'
      ? `multi_ack_detailed side-band-64k thin-pack ofs-delta shallow agent=${AGENT}`
      : `report-status side-band-64k delete-refs ofs-delta atomic agent=${AGENT}`;
  const refNames = [...repo.refs.keys()].sort();
  const lines: Array<string | 'flush'> = [`# service=${service}\n`, 'flush'];

  const headTarget = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headTarget);
  const firstCaps = headOid !== undefined ? `${caps} symref=HEAD:${headTarget}` : caps;

  const refEntries: Array<{ line: string }> = [];
  if (service === 'git-upload-pack' && headOid !== undefined) {
    refEntries.push({ line: `${headOid} HEAD` });
  }
  for (const refName of refNames) {
    const oid = repo.refs.get(refName)!;
    refEntries.push({ line: `${oid} ${refName}` });
    if (service === 'git-upload-pack') {
      const peeled = peelTag(repo.objects, oid);
      if (peeled) {
        refEntries.push({ line: `${peeled} ${refName}^{}` });
      }
    }
  }

  if (refEntries.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\u0000${caps}\n`);
  } else {
    lines.push(`${refEntries[0]!.line}\u0000${firstCaps}\n`);
    for (let i = 1; i < refEntries.length; i++) {
      lines.push(`${refEntries[i]!.line}\n`);
    }
  }
  lines.push('flush');
  const buf = encodePktText(lines);

  repo.adsCache.set(cacheKey, buf);
  return buf;
}

function handleLsRefs(repo: RepoState, argPayloads: readonly Buffer[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];

  for (const raw of argPayloads) {
    const line = raw.toString('utf8').replace(/\n$/, '');
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }

  const lsKey = `ls:${peel ? 1 : 0}:${symrefs ? 1 : 0}:${unborn ? 1 : 0}:${prefixes.join('|')}`;
  const cached = repo.adsCache.get(lsKey);
  if (cached) return cached;

  const matchesPrefix = (name: string): boolean => {
    if (prefixes.length === 0) return true;
    for (const p of prefixes) {
      if (name.startsWith(p)) return true;
    }
    return false;
  };

  const lines: Array<string | 'flush'> = [];
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headTarget);

  if (matchesPrefix('HEAD')) {
    if (headOid !== undefined) {
      lines.push(`${headOid} HEAD${symrefs ? ` symref-target:${headTarget}` : ''}\n`);
    } else if (unborn) {
      lines.push(`unborn HEAD${symrefs ? ` symref-target:${headTarget}` : ''}\n`);
    }
  }

  const refNames = [...repo.refs.keys()].sort();
  for (const refName of refNames) {
    if (!matchesPrefix(refName)) continue;
    const oid = repo.refs.get(refName)!;
    let suffix = '';
    if (peel) {
      const peeled = peelTag(repo.objects, oid);
      if (peeled) suffix = ` peeled:${peeled}`;
    }
    lines.push(`${oid} ${refName}${suffix}\n`);
  }
  lines.push('flush');
  const out = encodePktText(lines);
  repo.adsCache.set(lsKey, out);
  return out;
}

function collectReachableTreeAndBlobs(
  objects: ReadonlyMap<string, GitObject>,
  rootTreeOid: string,
  excludeObjects: ReadonlySet<string>,
  out: Map<string, GitObject>,
  mustIncludeRootTrees: ReadonlySet<string>,
): void {
  const stack: Array<{ oid: string; isRoot: boolean }> = [{ oid: rootTreeOid, isRoot: true }];
  while (stack.length > 0) {
    const item = stack.pop()!;
    if (out.has(item.oid)) continue;
    if (excludeObjects.has(item.oid) && !(item.isRoot && mustIncludeRootTrees.has(item.oid))) continue;
    const obj = objects.get(item.oid);
    if (!obj) continue;
    out.set(item.oid, obj);
    if (obj.type === 'tree') {
      const entries = parseTree(obj.data);
      for (const entry of entries) {
        if (entry.mode === '160000') continue; // gitlink
        if (out.has(entry.oid) || excludeObjects.has(entry.oid)) continue;
        if (entry.mode === '40000' || entry.mode === '040000') {
          stack.push({ oid: entry.oid, isRoot: false });
        } else {
          const blob = objects.get(entry.oid);
          if (blob) out.set(blob.oid, blob);
        }
      }
    }
  }
}

function handleUploadPackFetch(
  repo: RepoState,
  protocol: 0 | 2,
  wants: readonly string[],
  haves: readonly string[],
  clientShallow: readonly string[],
  depth: number | null,
  done: boolean,
): Buffer {
  const sortedWants = [...new Set(wants)].sort();
  const sortedHaves = [...new Set(haves)].sort();
  const sortedShallow = [...new Set(clientShallow)].sort();

  const cacheKey = done
    ? `${protocol}:${repo.refVersion}:${sortedWants.join(',')}:${sortedHaves.join(',')}:${sortedShallow.join(',')}:${depth ?? ''}`
    : '';
  if (cacheKey !== '') {
    const cached = repo.packCache.get(cacheKey);
    if (cached) return cached;
  }

  // If negotiation without `done` (not done yet)
  if (!done) {
    const common = sortedHaves.filter((h) => repo.objects.has(h));
    if (protocol === 2) {
      const ackLines: Array<string | 'flush'> = ['acknowledgments\n'];
      if (common.length === 0) ackLines.push('NAK\n');
      else {
        for (const h of common) ackLines.push(`ACK ${h}\n`);
      }
      ackLines.push('flush');
      return encodePktText(ackLines);
    }
    const v0Lines: Array<string | 'flush'> = common.length === 0 ? ['NAK\n'] : common.map((h) => `ACK ${h}\n`);
    return encodePktText(v0Lines);
  }

  // Determine commits & tags requested
  const clientShallowSet = new Set<string>(sortedShallow);
  const clientHeldCommits = new Set<string>();
  const clientHeldNonCommits = new Set<string>();

  // Walk haves respecting client's shallow boundaries
  const haveQueue: string[] = [];
  for (const h of sortedHaves) {
    if (repo.objects.has(h)) haveQueue.push(h);
  }
  while (haveQueue.length > 0) {
    const oid = haveQueue.pop()!;
    if (clientHeldCommits.has(oid) || clientHeldNonCommits.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    if (obj.type === 'commit') {
      clientHeldCommits.add(oid);
      const parsed = parseCommit(obj.data);
      // Do not walk parents if this commit is a client shallow root
      if (!clientShallowSet.has(oid)) {
        for (const p of parsed.parents) {
          if (!clientHeldCommits.has(p)) haveQueue.push(p);
        }
      }
    } else if (obj.type === 'tag') {
      clientHeldNonCommits.add(oid);
      const target = parseTag(obj.data).object;
      haveQueue.push(target);
    } else {
      clientHeldNonCommits.add(oid);
    }
  }

  // Mark trees and blobs of client-held commits as already owned
  const treeStack: string[] = [];
  for (const cOid of clientHeldCommits) {
    const cObj = repo.objects.get(cOid);
    if (cObj && cObj.type === 'commit') {
      treeStack.push(parseCommit(cObj.data).tree);
    }
  }
  while (treeStack.length > 0) {
    const tOid = treeStack.pop()!;
    if (clientHeldNonCommits.has(tOid)) continue;
    const tObj = repo.objects.get(tOid);
    if (!tObj) continue;
    clientHeldNonCommits.add(tOid);
    if (tObj.type === 'tree') {
      for (const e of parseTree(tObj.data)) {
        if (e.mode === '160000') continue;
        if (clientHeldNonCommits.has(e.oid)) continue;
        if (e.mode === '40000' || e.mode === '040000') treeStack.push(e.oid);
        else clientHeldNonCommits.add(e.oid);
      }
    }
  }

  // Walk wants
  const sendTags: GitObject[] = [];
  const keptCommitOids = new Set<string>();
  const newShallowSet = new Set<string>();
  const unshallowSet = new Set<string>();
  const startCommitDist = new Map<string, number>();
  const bfsQueue: Array<{ oid: string; dist: number }> = [];

  for (const w of sortedWants) {
    let cur = w;
    for (let guard = 0; guard < 16; guard++) {
      const obj = repo.objects.get(cur);
      if (!obj) break;
      if (obj.type === 'tag') {
        if (!clientHeldNonCommits.has(obj.oid)) sendTags.push(obj);
        cur = parseTag(obj.data).object;
        continue;
      }
      if (obj.type === 'commit') {
        bfsQueue.push({ oid: cur, dist: 0 });
      } else if (!clientHeldNonCommits.has(obj.oid)) {
        sendTags.push(obj);
      }
      break;
    }
  }

  if (depth !== null && depth > 0) {
    while (bfsQueue.length > 0) {
      const { oid, dist } = bfsQueue.shift()!;
      const prevDist = startCommitDist.get(oid);
      if (prevDist !== undefined && prevDist <= dist) continue;
      if (dist >= depth) continue;
      startCommitDist.set(oid, dist);
      keptCommitOids.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      const parsed = parseCommit(obj.data);
      if (parsed.parents.length > 0 && dist === depth - 1) {
        newShallowSet.add(oid);
      } else {
        for (const p of parsed.parents) {
          bfsQueue.push({ oid: p, dist: dist + 1 });
        }
      }
    }
    for (const s of sortedShallow) {
      if (keptCommitOids.has(s) && !newShallowSet.has(s)) {
        unshallowSet.add(s);
      }
    }
  } else {
    // Full traversal stopping at clientHeldCommits
    while (bfsQueue.length > 0) {
      const { oid } = bfsQueue.shift()!;
      if (keptCommitOids.has(oid) || clientHeldCommits.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      keptCommitOids.add(oid);
      const parsed = parseCommit(obj.data);
      if (clientShallowSet.has(oid)) {
        unshallowSet.add(oid);
        for (const p of parsed.parents) {
          if (!keptCommitOids.has(p) && !clientHeldCommits.has(p)) {
            bfsQueue.push({ oid: p, dist: 0 });
          }
        }
      } else {
        for (const p of parsed.parents) {
          if (!keptCommitOids.has(p) && !clientHeldCommits.has(p)) {
            bfsQueue.push({ oid: p, dist: 0 });
          }
        }
      }
    }
    for (const s of sortedShallow) {
      if (clientHeldCommits.has(s)) {
        const obj = repo.objects.get(s);
        if (obj && obj.type === 'commit') {
          const parsed = parseCommit(obj.data);
          let needsParents = false;
          for (const p of parsed.parents) {
            if (keptCommitOids.has(p)) {
              needsParents = true;
              break;
            }
          }
          if (needsParents) unshallowSet.add(s);
        }
      }
    }
  }

  const sendObjectsMap = new Map<string, GitObject>();
  for (const tagObj of sendTags) sendObjectsMap.set(tagObj.oid, tagObj);

  const rootTreesNeeded = new Set<string>();
  const sendCommits: GitObject[] = [];
  for (const cOid of keptCommitOids) {
    if (clientHeldCommits.has(cOid)) continue;
    const obj = repo.objects.get(cOid);
    if (!obj) continue;
    sendCommits.push(obj);
    sendObjectsMap.set(obj.oid, obj);
    if (obj.type === 'commit') {
      rootTreesNeeded.add(parseCommit(obj.data).tree);
    }
  }

  for (const cObj of sendCommits) {
    if (cObj.type === 'commit') {
      const treeOid = parseCommit(cObj.data).tree;
      collectReachableTreeAndBlobs(repo.objects, treeOid, clientHeldNonCommits, sendObjectsMap, rootTreesNeeded);
    }
  }

  const pack = buildPackfile([...sendObjectsMap.values()]);
  const prefixParts: Buffer[] = [];

  if (protocol === 2) {
    if (newShallowSet.size > 0 || unshallowSet.size > 0) {
      const shLines: Array<string | 'delim'> = ['shallow-info\n'];
      for (const s of newShallowSet) shLines.push(`shallow ${s}\n`);
      for (const u of unshallowSet) shLines.push(`unshallow ${u}\n`);
      shLines.push('delim');
      prefixParts.push(encodePktText(shLines));
    }
    prefixParts.push(encodePktText(['packfile\n']));
  } else {
    const v0Header: Array<string> = [];
    for (const s of newShallowSet) v0Header.push(`shallow ${s}\n`);
    for (const u of unshallowSet) v0Header.push(`unshallow ${u}\n`);
    v0Header.push('NAK\n');
    prefixParts.push(encodePktText(v0Header));
  }

  const response = encodeSidebandPack(pack, prefixParts, true);
  if (cacheKey !== '') {
    repo.packCache.set(cacheKey, response);
  }
  return response;
}

function extractCommitParentsFast(data: Buffer): string[] {
  const parents: string[] = [];
  let pos = 0;
  const end = data.length;
  while (pos < end) {
    const nl = data.indexOf(0x0a, pos);
    const lineEnd = nl >= 0 ? nl : end;
    if (lineEnd === pos) break; // blank line terminates commit header
    if (
      lineEnd - pos >= 47 &&
      data[pos] === 0x70 && // 'p'
      data[pos + 1] === 0x61 && // 'a'
      data[pos + 2] === 0x72 && // 'r'
      data[pos + 3] === 0x65 && // 'e'
      data[pos + 4] === 0x6e && // 'n'
      data[pos + 5] === 0x74 && // 't'
      data[pos + 6] === 0x20 // ' '
    ) {
      parents.push(data.toString('ascii', pos + 7, pos + 47));
    }
    if (nl < 0) break;
    pos = nl + 1;
  }
  return parents;
}

function isCommitAncestor(objects: ReadonlyMap<string, GitObject>, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const descObj = objects.get(descendant);
  if (descObj && descObj.type === 'commit') {
    const firstParents = extractCommitParentsFast(descObj.data);
    if (firstParents.length === 1 && firstParents[0] === ancestor) return true;
  }
  const visited = new Set<string>();
  const stack: string[] = [descendant];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (cur === ancestor) return true;
    if (visited.has(cur)) continue;
    visited.add(cur);
    const obj = objects.get(cur);
    if (obj && obj.type === 'commit') {
      const parents = extractCommitParentsFast(obj.data);
      for (const p of parents) {
        if (p === ancestor) return true;
        if (!visited.has(p)) stack.push(p);
      }
    }
  }
  return false;
}

function handleUploadPackPost(repo: RepoState, req: IncomingMessage, body: Buffer): { status: number; contentType: string; body: Buffer } {
  const gitProto = String(req.headers['git-protocol'] ?? '');
  const isV2 = gitProto.includes('version=2');
  const rawKey = isV2 && body.length <= 512 ? `r2:${body.toString('latin1')}` : '';
  if (rawKey) {
    const cachedRaw = repo.packCache.get(rawKey);
    if (cachedRaw) {
      return {
        status: 200,
        contentType: 'application/x-git-upload-pack-result',
        body: cachedRaw,
      };
    }
  }

  const { packets } = parsePktStream(body);

  if (isV2) {
    let command = '';
    let pastDelim = false;
    const args: Buffer[] = [];
    for (const pkt of packets) {
      if (pkt.kind === 'flush') break;
      if (pkt.kind === 'delim') {
        pastDelim = true;
        continue;
      }
      if (!pastDelim) {
        const line = pkt.payload.toString('utf8').replace(/\n$/, '');
        if (line.startsWith('command=')) command = line.slice('command='.length);
      } else {
        args.push(pkt.payload);
      }
    }

    if (command === 'ls-refs') {
      const result = handleLsRefs(repo, args);
      if (rawKey && repo.packCache.size < 256) repo.packCache.set(rawKey, result);
      return {
        status: 200,
        contentType: 'application/x-git-upload-pack-result',
        body: result,
      };
    }
    if (command === 'fetch') {
      const wants: string[] = [];
      const haves: string[] = [];
      const shallow: string[] = [];
      let depth: number | null = null;
      let done = false;
      for (const raw of args) {
        const line = raw.toString('utf8').replace(/\n$/, '');
        if (line.startsWith('want ')) {
          const oid = line.slice(5).trim();
          if (isOid(oid)) wants.push(oid.toLowerCase());
        } else if (line.startsWith('have ')) {
          const oid = line.slice(5).trim();
          if (isOid(oid)) haves.push(oid.toLowerCase());
        } else if (line.startsWith('shallow ')) {
          const oid = line.slice(8).trim();
          if (isOid(oid)) shallow.push(oid.toLowerCase());
        } else if (line.startsWith('deepen ')) {
          const d = Number.parseInt(line.slice(7).trim(), 10);
          if (Number.isInteger(d) && d > 0) depth = d;
        } else if (line === 'done') {
          done = true;
        }
      }
      const result = handleUploadPackFetch(repo, 2, wants, haves, shallow, depth, done);
      if (rawKey && done && repo.packCache.size < 256) repo.packCache.set(rawKey, result);
      return {
        status: 200,
        contentType: 'application/x-git-upload-pack-result',
        body: result,
      };
    }
    return {
      status: 400,
      contentType: 'application/json; charset=utf-8',
      body: Buffer.from(JSON.stringify({ message: `Unsupported git v2 command: ${command}` })),
    };
  }

  // Protocol v0 upload-pack
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  let done = false;
  for (const pkt of packets) {
    if (pkt.kind !== 'data') continue;
    const line = pkt.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const oid = line.slice(5, 45).toLowerCase();
      if (isOid(oid)) wants.push(oid);
    } else if (line.startsWith('have ')) {
      const oid = line.slice(5, 45).toLowerCase();
      if (isOid(oid)) haves.push(oid);
    } else if (line.startsWith('shallow ')) {
      const oid = line.slice(8, 48).toLowerCase();
      if (isOid(oid)) shallow.push(oid);
    } else if (line.startsWith('deepen ')) {
      const d = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isInteger(d) && d > 0) depth = d;
    } else if (line === 'done') {
      done = true;
    }
  }
  return {
    status: 200,
    contentType: 'application/x-git-upload-pack-result',
    body: handleUploadPackFetch(repo, 0, wants, haves, shallow, depth, done),
  };
}

function handleReceivePackPost(
  store: ForgeStore,
  repo: RepoState,
  body: Buffer,
): { status: number; contentType: string; body: Buffer } {
  const { lines, pack } = parseReceivePackHeaderAndBody(body);
  if (lines.length === 0) {
    return {
      status: 400,
      contentType: 'application/json; charset=utf-8',
      body: Buffer.from(JSON.stringify({ message: 'Empty receive-pack command list' })),
    };
  }

  const caps = new Set<string>();
  const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    let raw = lines[i]!.toString('utf8');
    if (i === 0) {
      const nul = raw.indexOf('\u0000');
      if (nul >= 0) {
        const capPart = raw.slice(nul + 1).replace(/\n$/, '');
        for (const c of capPart.split(' ')) {
          if (c) caps.add(c);
        }
        raw = raw.slice(0, nul);
      }
    }
    raw = raw.replace(/\n$/, '');
    const sp1 = raw.indexOf(' ');
    const sp2 = sp1 >= 0 ? raw.indexOf(' ', sp1 + 1) : -1;
    if (sp1 < 0 || sp2 < 0) throw new Error(`malformed receive-pack command: ${raw}`);
    const oldOid = raw.slice(0, sp1).toLowerCase();
    const newOid = raw.slice(sp1 + 1, sp2).toLowerCase();
    const ref = raw.slice(sp2 + 1);
    if (!isOid(oldOid) || !isOid(newOid) || !ref) throw new Error('invalid receive-pack command fields');
    commands.push({ oldOid, newOid, ref });
  }

  let unpackOk = true;
  let unpackError = '';
  let unpacked = new Map<string, GitObject>();
  if (pack.length > 0) {
    try {
      unpacked = parsePackfile(pack, repo.objects);
      for (const [oid, obj] of unpacked) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
      }
    } catch (err) {
      unpackOk = false;
      unpackError = err instanceof Error ? err.message : String(err);
    }
  }

  const reportLines: Array<string | 'flush'> = [];
  if (!unpackOk) {
    reportLines.push(`unpack ${unpackError || 'error'}\n`);
    for (const cmd of commands) {
      reportLines.push(`ng ${cmd.ref} unpacker error\n`);
    }
  } else {
    reportLines.push('unpack ok\n');
    let mutated = false;
    for (const cmd of commands) {
      const current = repo.refs.get(cmd.ref);
      if (cmd.newOid === ZERO_OID) {
        if (current === undefined) {
          if (cmd.oldOid === ZERO_OID) {
            reportLines.push(`ok ${cmd.ref}\n`);
          } else {
            reportLines.push(`ng ${cmd.ref} reference does not exist\n`);
          }
          continue;
        }
        if (cmd.oldOid !== ZERO_OID && current !== cmd.oldOid) {
          reportLines.push(`ng ${cmd.ref} failed to lock\n`);
          continue;
        }
        repo.refs.delete(cmd.ref);
        mutated = true;
        reportLines.push(`ok ${cmd.ref}\n`);
        continue;
      }

      if (!repo.objects.has(cmd.newOid)) {
        reportLines.push(`ng ${cmd.ref} missing object ${cmd.newOid}\n`);
        continue;
      }

      if (cmd.oldOid === ZERO_OID) {
        if (current !== undefined && current !== cmd.newOid) {
          reportLines.push(`ng ${cmd.ref} non-fast-forward\n`);
          continue;
        }
        repo.refs.set(cmd.ref, cmd.newOid);
        mutated = true;
        reportLines.push(`ok ${cmd.ref}\n`);
        continue;
      }

      if (current === undefined) {
        reportLines.push(`ng ${cmd.ref} failed to lock\n`);
        continue;
      }
      if (current !== cmd.oldOid) {
        reportLines.push(`ng ${cmd.ref} non-fast-forward\n`);
        continue;
      }
      if (!isCommitAncestor(repo.objects, current, cmd.newOid)) {
        reportLines.push(`ng ${cmd.ref} non-fast-forward\n`);
        continue;
      }
      repo.refs.set(cmd.ref, cmd.newOid);
      mutated = true;
      reportLines.push(`ok ${cmd.ref}\n`);
    }
    if (mutated) {
      store.invalidateRepoPackCaches(repo);
    }
  }

  const useSideband = caps.has('side-band-64k');
  let wireBody: Buffer;
  if (unpackOk && commands.length === 1 && reportLines.length === 2 && reportLines[1] === 'ok refs/heads/main\n') {
    wireBody = useSideband ? getOkMainSidebandReport() : getOkMainPlainReport();
  } else {
    reportLines.push('flush');
    const rawReport = encodePktText(reportLines);
    wireBody = useSideband ? encodeSidebandPack(rawReport, [], true) : rawReport;
  }

  return {
    status: 200,
    contentType: 'application/x-git-receive-pack-result',
    body: wireBody,
  };
}

export function handleGitGetInfoRefs(
  store: ForgeStore,
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  repoName: string,
  service: string | null,
  requestId: string,
): void {
  const repo = store.findRepo(owner, repoName);
  if (!repo) {
    res.writeHead(404, {
      'content-type': 'application/json; charset=utf-8',
      'x-github-request-id': requestId,
    });
    res.end('{"message":"Not Found"}');
    return;
  }
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    res.writeHead(400, {
      'content-type': 'application/json; charset=utf-8',
      'x-github-request-id': requestId,
    });
    res.end('{"message":"Unsupported service"}');
    return;
  }

  const gitProto = String(req.headers['git-protocol'] ?? '');
  const version: 0 | 2 = service === 'git-upload-pack' && gitProto.includes('version=2') ? 2 : 0;
  const payload = buildAdvertisement(repo, service, version);

  res.writeHead(200, {
    'content-type': `application/x-${service}-advertisement`,
    'cache-control': 'no-cache',
    'content-length': payload.length,
    'x-github-request-id': requestId,
  });
  res.end(payload);
}

export function handleGitPostService(
  store: ForgeStore,
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  repoName: string,
  service: 'git-upload-pack' | 'git-receive-pack',
  body: Buffer,
  requestId: string,
): void {
  const repo = store.findRepo(owner, repoName);
  if (!repo) {
    res.writeHead(404, {
      'content-type': 'application/json; charset=utf-8',
      'x-github-request-id': requestId,
    });
    res.end('{"message":"Not Found"}');
    return;
  }

  try {
    const reply =
      service === 'git-upload-pack'
        ? handleUploadPackPost(repo, req, body)
        : handleReceivePackPost(store, repo, body);
    res.writeHead(reply.status, {
      'content-type': reply.contentType,
      'cache-control': 'no-cache',
      'content-length': reply.body.length,
      'x-github-request-id': requestId,
    });
    res.end(reply.body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const jsonErr = Buffer.from(JSON.stringify({ message }));
    res.writeHead(400, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': jsonErr.length,
      'x-github-request-id': requestId,
    });
    res.end(jsonErr);
  }
}
