// Parser for UE5 "Zen" cooked packages (the .uasset layout used inside IoStore).
//
// Cooked UE5 packages use unversioned property serialization: property *names* are not
// stored, only a fragment header saying which schema slots are present, followed by raw
// values. Fully generic decoding needs a .usmap schema dump, which StarRupture does not
// ship. We therefore expose the pieces that are self-describing (name map, imported
// package names, import map, export payload) and let callers decode the small, uniform
// recipe structs positionally.

import { Buffer } from 'node:buffer';

const SUMMARY_SIZE = 52;
const EXPORT_ENTRY_SIZE = 72;
const IMPORT_ENTRY_SIZE = 8;

// FPackageObjectIndex packs a 2-bit type into the top bits of a uint64.
const OBJECT_INDEX_TYPE = { export: 0n, scriptImport: 1n, packageImport: 2n, null: 3n };

function readNameBatch(buffer, offset) {
  if (!Number.isInteger(offset) || offset < 0 || offset + 16 > buffer.length) return [];
  const count = buffer.readInt32LE(offset);
  const stringBytes = buffer.readInt32LE(offset + 4);
  if (count <= 0 || stringBytes < 0) return [];

  const headerStart = offset + 16 + count * 8;
  let stringStart = headerStart + count * 2;
  if (stringStart + stringBytes > buffer.length) return [];

  const names = [];
  for (let i = 0; i < count; i++) {
    const high = buffer.readUInt8(headerStart + i * 2);
    const low = buffer.readUInt8(headerStart + i * 2 + 1);
    const isUtf16 = (high & 0x80) !== 0;
    const length = ((high & 0x7f) << 8) | low;
    const byteLength = isUtf16 ? length * 2 : length;
    if (stringStart + byteLength > buffer.length) break;
    names.push(
      isUtf16
        ? buffer.toString('utf16le', stringStart, stringStart + byteLength)
        : buffer.toString('utf8', stringStart, stringStart + byteLength),
    );
    stringStart += byteLength;
  }
  return names;
}

export function parseZenPackage(buffer) {
  if (buffer.length < SUMMARY_SIZE) throw new Error('Package is too small to be a Zen package.');

  const summary = {
    hasVersioningInfo: buffer.readUInt32LE(0),
    headerSize: buffer.readUInt32LE(4),
    packageFlags: buffer.readUInt32LE(16),
    cookedHeaderSize: buffer.readUInt32LE(20),
    importedPublicExportHashesOffset: buffer.readInt32LE(24),
    importMapOffset: buffer.readInt32LE(28),
    exportMapOffset: buffer.readInt32LE(32),
    exportBundleEntriesOffset: buffer.readInt32LE(36),
    dependencyBundleHeadersOffset: buffer.readInt32LE(40),
    dependencyBundleEntriesOffset: buffer.readInt32LE(44),
    importedPackageNamesOffset: buffer.readInt32LE(48),
  };

  if (summary.hasVersioningInfo !== 0) {
    throw new Error('Versioned Zen packages are not supported by this reader.');
  }
  if (summary.headerSize > buffer.length) {
    throw new Error('Zen package header extends past the end of the asset.');
  }

  const nameMap = readNameBatch(buffer, SUMMARY_SIZE);
  const importedPackageNames = readNameBatch(buffer, summary.importedPackageNamesOffset);

  const importCount = (summary.exportMapOffset - summary.importMapOffset) / IMPORT_ENTRY_SIZE;
  const imports = [];
  for (let i = 0; i < importCount; i++) {
    const raw = buffer.readBigUInt64LE(summary.importMapOffset + i * IMPORT_ENTRY_SIZE);
    const kind = raw >> 62n;
    if (kind === OBJECT_INDEX_TYPE.packageImport) {
      // FPackageImportReference: low 32 bits index the public export hashes, high 32 bits
      // index importedPackageNames (with a flag bit set that must be masked off).
      imports.push({
        kind: 'packageImport',
        packageIndex: Number((raw >> 32n) & 0xffffffffn) & 0x7fffffff,
        exportHashIndex: Number(raw & 0xffffffffn),
      });
    } else if (kind === OBJECT_INDEX_TYPE.scriptImport) {
      imports.push({ kind: 'scriptImport', hash: raw & 0x3fffffffffffffffn });
    } else {
      imports.push({ kind: kind === OBJECT_INDEX_TYPE.export ? 'export' : 'null' });
    }
  }

  const exportCount = (summary.exportBundleEntriesOffset - summary.exportMapOffset) / EXPORT_ENTRY_SIZE;
  const exports = [];
  for (let i = 0; i < exportCount; i++) {
    const base = summary.exportMapOffset + i * EXPORT_ENTRY_SIZE;
    exports.push({
      serialOffset: Number(buffer.readBigUInt64LE(base)),
      serialSize: Number(buffer.readBigUInt64LE(base + 8)),
      objectName: nameMap[buffer.readUInt32LE(base + 16)] ?? null,
    });
  }

  const payload = buffer.subarray(summary.headerSize);

  return {
    summary,
    nameMap,
    importedPackageNames,
    imports,
    exports,
    payload,
    // Object properties serialize as FPackageIndex: negative values are imports.
    resolveObjectRef(packageIndexRef) {
      if (packageIndexRef >= 0) return null;
      const entry = imports[-packageIndexRef - 1];
      if (!entry || entry.kind !== 'packageImport') return null;
      return importedPackageNames[entry.packageIndex] ?? null;
    },
  };
}

export function exportPayload(pkg, index = 0) {
  const entry = pkg.exports[index];
  if (!entry) throw new Error(`Package has no export at index ${index}.`);
  return pkg.payload.subarray(entry.serialOffset, entry.serialOffset + entry.serialSize);
}

// UStringTable payloads are a flat run of length-prefixed FStrings alternating between
// localization key and source string. Scanning for that shape avoids needing the schema.
export function parseStringTablePairs(payload) {
  const strings = [];
  let offset = 0;
  while (offset + 4 <= payload.length) {
    const length = payload.readInt32LE(offset);
    if (length > 1 && length < 4096 && offset + 4 + length <= payload.length) {
      const bytes = payload.subarray(offset + 4, offset + 4 + length);
      if (bytes[length - 1] === 0) {
        const text = bytes.toString('utf8', 0, length - 1);
        if (/^[\x20-\x7e\u00a0-\uffff]*$/.test(text)) {
          strings.push(text);
          offset += 4 + length;
          continue;
        }
      }
    }
    offset += 1;
  }

  const pairs = new Map();
  for (let i = 0; i + 1 < strings.length; i++) {
    if (strings[i].endsWith('_name') || strings[i].endsWith('_desc')) {
      if (!pairs.has(strings[i])) pairs.set(strings[i], strings[i + 1]);
    }
  }
  return pairs;
}

export { Buffer };
