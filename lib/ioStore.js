// Minimal reader for Unreal Engine 5 IoStore containers (.utoc/.ucas).
//
// StarRupture ships pakchunk0 unencrypted and uncompressed (container flags = Indexed
// only, CompressionMethodNameCount = 0), so we only need the table of contents, the
// directory index, and a raw block read. That keeps this dependency-free instead of
// pulling in FModel/CUE4Parse and a .NET toolchain just to read a few hundred small
// data assets.

import { closeSync, openSync, readSync, statSync } from 'node:fs';

const TOC_MAGIC = '-==--==--==--==-';
const SUMMARY_SIZE = 144;
const CHUNK_ID_SIZE = 12;
const OFFSET_LENGTH_SIZE = 10;
const COMPRESSION_BLOCK_SIZE = 12;
const INVALID_INDEX = 0xffffffff;

function readExact(fd, length, position) {
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const got = readSync(fd, buffer, read, length - read, position + read);
    if (got === 0) throw new Error(`Unexpected end of file at offset ${position + read}.`);
    read += got;
  }
  return buffer;
}

// Both 5-byte big-endian fields of FIoOffsetAndLength.
function readUInt40BE(buffer, offset) {
  return buffer.readUIntBE(offset, 5);
}

function parseTocHeader(buffer) {
  if (buffer.subarray(0, 16).toString('latin1') !== TOC_MAGIC) {
    throw new Error('Not an IoStore .utoc file (bad magic).');
  }
  const header = {
    version: buffer.readUInt8(16),
    headerSize: buffer.readUInt32LE(20),
    entryCount: buffer.readUInt32LE(24),
    compressedBlockCount: buffer.readUInt32LE(28),
    compressedBlockEntrySize: buffer.readUInt32LE(32),
    compressionMethodCount: buffer.readUInt32LE(36),
    compressionMethodNameLength: buffer.readUInt32LE(40),
    compressionBlockSize: buffer.readUInt32LE(44),
    directoryIndexSize: buffer.readUInt32LE(48),
    partitionCount: buffer.readUInt32LE(52),
    encryptionKeyGuid: buffer.subarray(64, 80),
    containerFlags: buffer.readUInt8(80),
    perfectHashSeedCount: buffer.readUInt32LE(84),
    chunksWithoutPerfectHashCount: buffer.readUInt32LE(96),
  };

  if (header.headerSize !== SUMMARY_SIZE) {
    throw new Error(`Unsupported IoStore TOC header size ${header.headerSize}.`);
  }
  // Encrypted = 1 << 1. We have no AES key, so bail out clearly rather than returning junk.
  if (header.containerFlags & 0x02) {
    throw new Error('IoStore container is encrypted; an AES key would be required.');
  }
  return header;
}

function readFString(buffer, cursor) {
  const length = buffer.readInt32LE(cursor.offset);
  cursor.offset += 4;
  if (length === 0) return '';
  if (length < 0) {
    const chars = -length;
    const value = buffer.toString('utf16le', cursor.offset, cursor.offset + chars * 2);
    cursor.offset += chars * 2;
    return value.replace(/\0+$/, '');
  }
  const value = buffer.toString('utf8', cursor.offset, cursor.offset + length);
  cursor.offset += length;
  return value.replace(/\0+$/, '');
}

function parseDirectoryIndex(buffer) {
  const cursor = { offset: 0 };
  const mountPoint = readFString(buffer, cursor);

  const directoryCount = buffer.readInt32LE(cursor.offset);
  cursor.offset += 4;
  const directories = [];
  for (let i = 0; i < directoryCount; i++) {
    const base = cursor.offset + i * 16;
    directories.push({
      name: buffer.readUInt32LE(base),
      firstChild: buffer.readUInt32LE(base + 4),
      nextSibling: buffer.readUInt32LE(base + 8),
      firstFile: buffer.readUInt32LE(base + 12),
    });
  }
  cursor.offset += directoryCount * 16;

  const fileCount = buffer.readInt32LE(cursor.offset);
  cursor.offset += 4;
  const files = [];
  for (let i = 0; i < fileCount; i++) {
    const base = cursor.offset + i * 12;
    files.push({
      name: buffer.readUInt32LE(base),
      nextFile: buffer.readUInt32LE(base + 4),
      userData: buffer.readUInt32LE(base + 8),
    });
  }
  cursor.offset += fileCount * 12;

  const stringCount = buffer.readInt32LE(cursor.offset);
  cursor.offset += 4;
  const strings = [];
  for (let i = 0; i < stringCount; i++) strings.push(readFString(buffer, cursor));

  // The directory tree is sibling-linked, so walk it iteratively to avoid deep recursion.
  const entries = new Map();
  const stack = [{ index: 0, prefix: mountPoint }];
  while (stack.length > 0) {
    const { index, prefix } = stack.pop();
    let directoryIndex = index;
    while (directoryIndex !== INVALID_INDEX) {
      const directory = directories[directoryIndex];
      const path = directory.name === INVALID_INDEX ? prefix : `${prefix}${strings[directory.name]}/`;
      let fileIndex = directory.firstFile;
      while (fileIndex !== INVALID_INDEX) {
        const file = files[fileIndex];
        entries.set(`${path}${strings[file.name]}`, file.userData);
        fileIndex = file.nextFile;
      }
      if (directory.firstChild !== INVALID_INDEX) stack.push({ index: directory.firstChild, prefix: path });
      directoryIndex = directory.nextSibling;
    }
  }
  return entries;
}

export function openContainer(tocPath, casPath) {
  const tocFd = openSync(tocPath, 'r');
  let casFd;
  try {
    const header = parseTocHeader(readExact(tocFd, SUMMARY_SIZE, 0));

    const offsetLengthStart = header.headerSize + header.entryCount * CHUNK_ID_SIZE;
    const offsetLengths = readExact(tocFd, header.entryCount * OFFSET_LENGTH_SIZE, offsetLengthStart);

    const blockStart =
      offsetLengthStart + header.entryCount * OFFSET_LENGTH_SIZE + header.perfectHashSeedCount * 4;
    const blockBuffer = readExact(
      tocFd,
      header.compressedBlockCount * header.compressedBlockEntrySize,
      blockStart,
    );

    const directoryStart =
      blockStart +
      header.compressedBlockCount * header.compressedBlockEntrySize +
      header.compressionMethodCount * header.compressionMethodNameLength;
    const directoryIndex = parseDirectoryIndex(
      readExact(tocFd, header.directoryIndexSize, directoryStart),
    );

    casFd = openSync(casPath, 'r');
    const casSize = statSync(casPath).size;

    function readChunk(tocEntryIndex) {
      const base = tocEntryIndex * OFFSET_LENGTH_SIZE;
      const offset = readUInt40BE(offsetLengths, base);
      const length = readUInt40BE(offsetLengths, base + 5);

      const firstBlock = Math.floor(offset / header.compressionBlockSize);
      const lastBlock = Math.floor((offset + length - 1) / header.compressionBlockSize);

      const parts = [];
      for (let block = firstBlock; block <= lastBlock; block++) {
        const entry = block * COMPRESSION_BLOCK_SIZE;
        const blockOffset = blockBuffer.readUIntLE(entry, 5);
        const compressedSize = blockBuffer.readUIntLE(entry + 5, 3);
        const uncompressedSize = blockBuffer.readUIntLE(entry + 8, 3);
        const method = blockBuffer.readUInt8(entry + 11);
        if (method !== 0) {
          throw new Error(`Compressed block (method ${method}) is not supported by this reader.`);
        }
        if (blockOffset + compressedSize > casSize) {
          throw new Error('Compression block points past the end of the .ucas file.');
        }
        parts.push(readExact(casFd, compressedSize, blockOffset).subarray(0, uncompressedSize));
      }

      const start = offset - firstBlock * header.compressionBlockSize;
      return Buffer.concat(parts).subarray(start, start + length);
    }

    return {
      header,
      paths: [...directoryIndex.keys()],
      has: (path) => directoryIndex.has(path),
      read(path) {
        const tocEntryIndex = directoryIndex.get(path);
        if (tocEntryIndex === undefined) throw new Error(`Asset not found in container: ${path}`);
        return readChunk(tocEntryIndex);
      },
      close() {
        closeSync(tocFd);
        if (casFd !== undefined) closeSync(casFd);
      },
    };
  } catch (error) {
    closeSync(tocFd);
    if (casFd !== undefined) closeSync(casFd);
    throw error;
  }
}
