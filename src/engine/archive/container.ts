import { constants } from "node:fs";
import { lstat, open, readdir, rm, type FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { crc32, createDeflateRaw } from "node:zlib";

// PKWARE APPNOTE 4.3 and 4.5.3. Always use ZIP64 so streamed assets and
// conversation entry counts are not limited by ZIP's 32/16-bit fields.
const ZIP64_VERSION = 45;
const UNIX_VERSION = (3 << 8) | ZIP64_VERSION;
const UTF8 = 0x0800;
const DOS_DATE = 0x0021; // 1980-01-01 00:00:00, independent of host timezone.
const ZIP32_SENTINEL = 0xffffffff;

interface Entry {
  path: string;
  directory: boolean;
}

async function entriesIn(root: string): Promise<Entry[]> {
  if (!(await lstat(root)).isDirectory()) throw new Error("archive_root_is_not_a_real_directory");
  const entries: Entry[] = [];
  const visit = async (relative: string): Promise<void> => {
    for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
      const path = relative + entry.name;
      if (entry.isDirectory()) {
        entries.push({ path: path + "/", directory: true });
        await visit(path + "/");
      } else if (entry.isFile()) {
        entries.push({ path, directory: false });
      } else {
        throw new Error("symlink_or_nonregular_path");
      }
    }
  };
  await visit("");
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return entries;
}

async function writeAt(file: FileHandle, bytes: Buffer, position: number): Promise<void> {
  let written = 0;
  while (written < bytes.length) {
    const { bytesWritten } = await file.write(
      bytes,
      written,
      bytes.length - written,
      position + written,
    );
    if (bytesWritten === 0) throw new Error("container_write_stalled");
    written += bytesWritten;
  }
}

function localHeader(name: Buffer, method: number): Buffer {
  const header = Buffer.alloc(30 + name.length + 20);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(ZIP64_VERSION, 4);
  header.writeUInt16LE(UTF8, 6);
  header.writeUInt16LE(method, 8);
  header.writeUInt16LE(DOS_DATE, 12);
  header.writeUInt32LE(ZIP32_SENTINEL, 18);
  header.writeUInt32LE(ZIP32_SENTINEL, 22);
  header.writeUInt16LE(name.length, 26);
  header.writeUInt16LE(20, 28);
  name.copy(header, 30);
  header.writeUInt16LE(0x0001, 30 + name.length);
  header.writeUInt16LE(16, 32 + name.length);
  return header;
}

function centralHeader(local: Buffer, directory: boolean, offset: number): Buffer {
  const nameLength = local.readUInt16LE(26);
  const header = Buffer.alloc(46 + nameLength + 28);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(UNIX_VERSION, 4);
  local.copy(header, 6, 4, 30); // version through extra-field length
  header.writeUInt16LE(28, 30);
  // Canonical package modes, not the source host's umask or mutable metadata.
  header.writeUInt32LE((directory ? 0o40555 : 0o100444) * 0x10000 + (directory ? 0x10 : 0), 38);
  header.writeUInt32LE(ZIP32_SENTINEL, 42);
  local.copy(header, 46, 30);
  header.writeUInt16LE(24, 48 + nameLength);
  header.writeBigUInt64LE(BigInt(offset), 66 + nameLength);
  return header;
}

function endRecords(count: number, centralOffset: number, centralSize: number): Buffer {
  const end = Buffer.alloc(56 + 20 + 22);
  end.writeUInt32LE(0x06064b50, 0);
  end.writeBigUInt64LE(44n, 4);
  end.writeUInt16LE(UNIX_VERSION, 12);
  end.writeUInt16LE(ZIP64_VERSION, 14);
  end.writeBigUInt64LE(BigInt(count), 24);
  end.writeBigUInt64LE(BigInt(count), 32);
  end.writeBigUInt64LE(BigInt(centralSize), 40);
  end.writeBigUInt64LE(BigInt(centralOffset), 48);
  end.writeUInt32LE(0x07064b50, 56);
  end.writeBigUInt64LE(BigInt(centralOffset + centralSize), 64);
  end.writeUInt32LE(1, 72); // single disk
  end.writeUInt32LE(0x06054b50, 76);
  end.writeUInt16LE(0xffff, 84);
  end.writeUInt16LE(0xffff, 86);
  end.writeUInt32LE(ZIP32_SENTINEL, 88);
  end.writeUInt32LE(ZIP32_SENTINEL, 92);
  return end;
}

/** Write a ZIP containing paths relative to one verified conversation directory.
 * The caller keeps that directory immutable and owns publishing the result.
 * Destination must be a new file outside the package; failed writes remove it.
 * Payloads stream one at a time; only entry headers are retained in memory. */
export async function writeConversationContainer(
  directory: string,
  destination: string,
): Promise<void> {
  const root = resolve(directory);
  const entries = await entriesIn(root);
  const output = await open(destination, "wx", 0o600);
  try {
    let position = 0;
    const append = async (bytes: Buffer): Promise<void> => {
      await writeAt(output, bytes, position);
      position += bytes.length;
    };
    const central: Buffer[] = [];
    for (const entry of entries) {
      const input = entry.directory
        ? undefined
        : await open(join(root, entry.path), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await input?.stat();
        if (info && !info.isFile()) throw new Error("symlink_or_nonregular_path");
        const method = info && info.size > 0 ? 8 : 0;
        const name = Buffer.from(entry.path);
        const header = localHeader(name, method);
        const offset = position;
        await append(header);
        const contentOffset = position;
        let checksum = 0;
        let size = 0;
        if (input && method === 8) {
          await pipeline(
            input.createReadStream({ autoClose: false }),
            new Transform({
              transform(chunk: Buffer, _encoding, callback) {
                checksum = crc32(chunk, checksum);
                size += chunk.length;
                callback(null, chunk);
              },
            }),
            createDeflateRaw({ level: 9 }),
            async (chunks) => {
              for await (const chunk of chunks) await append(chunk);
            },
          );
        }
        header.writeUInt32LE(checksum, 14);
        header.writeBigUInt64LE(BigInt(size), 34 + name.length);
        header.writeBigUInt64LE(BigInt(position - contentOffset), 42 + name.length);
        await writeAt(output, header, offset);
        central.push(centralHeader(header, entry.directory, offset));
      } finally {
        await input?.close();
      }
    }
    const centralOffset = position;
    for (const header of central) await append(header);
    await append(endRecords(entries.length, centralOffset, position - centralOffset));
  } catch (error) {
    await rm(destination, { force: true });
    throw error;
  } finally {
    await output.close();
  }
}
