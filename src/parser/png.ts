import { inflateSync } from 'node:zlib';

const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface ExtractedImageTextChunks {
  format: 'png' | 'webp' | 'unknown';
  chunks: Record<string, string>;
}

function hasPngSignature(buf: Uint8Array): boolean {
  if (buf.length < 8) return false;
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== PNG_SIGNATURE[i]) return false;
  }
  return true;
}

function readUint32BE(buf: Uint8Array, offset: number): number {
  return (
    ((buf[offset] << 24) >>> 0)
    + (buf[offset + 1] << 16)
    + (buf[offset + 2] << 8)
    + buf[offset + 3]
  );
}

function readAscii(buf: Uint8Array, start: number, end: number): string {
  return Buffer.from(buf.buffer, buf.byteOffset + start, end - start).toString('latin1');
}

function readUtf8(buf: Uint8Array, start: number, end: number): string {
  return Buffer.from(buf.buffer, buf.byteOffset + start, end - start).toString('utf8');
}

function indexOfZero(buf: Uint8Array, start: number, end: number): number {
  for (let i = start; i < end; i++) {
    if (buf[i] === 0) return i;
  }
  return -1;
}

/**
 * Parses PNG tEXt, iTXt, and zTXt chunks without external dependencies.
 * Gracefully stops if the input buffer was truncated (e.g., partial read).
 */
export function extractPngTextChunks(input: Uint8Array): Record<string, string> {
  const chunks: Record<string, string> = {};
  if (!hasPngSignature(input)) return chunks;

  let offset = 8;
  while (offset + 8 <= input.length) {
    const length = readUint32BE(input, offset);
    const type = readAscii(input, offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const nextOffset = dataEnd + 4; // +4 CRC

    if (dataEnd > input.length) {
      // Truncated chunk (usually IDAT on partial reads); stop safely.
      break;
    }

    if (type === 'tEXt') {
      const sep = indexOfZero(input, dataStart, dataEnd);
      if (sep > dataStart) {
        const key = readAscii(input, dataStart, sep);
        // ComfyUI writes UTF-8 JSON inside tEXt chunks even though PNG spec says Latin-1.
        const value = readUtf8(input, sep + 1, dataEnd);
        chunks[key] = value;
      }
    } else if (type === 'zTXt') {
      const sep = indexOfZero(input, dataStart, dataEnd);
      if (sep > dataStart && sep + 2 <= dataEnd) {
        const key = readAscii(input, dataStart, sep);
        const compressionMethod = input[sep + 1];
        if (compressionMethod === 0) {
          try {
            const compressed = Buffer.from(
              input.buffer,
              input.byteOffset + sep + 2,
              dataEnd - (sep + 2),
            );
            chunks[key] = inflateSync(compressed).toString('utf8');
          } catch {
            // Ignore corrupt compressed text chunk.
          }
        }
      }
    } else if (type === 'iTXt') {
      const sep = indexOfZero(input, dataStart, dataEnd);
      if (sep > dataStart && sep + 3 <= dataEnd) {
        const key = readAscii(input, dataStart, sep);
        const compressionFlag = input[sep + 1];
        const compressionMethod = input[sep + 2];
        const langEnd = indexOfZero(input, sep + 3, dataEnd);
        if (langEnd >= 0) {
          const translatedEnd = indexOfZero(input, langEnd + 1, dataEnd);
          if (translatedEnd >= 0) {
            const textStart = translatedEnd + 1;
            if (compressionFlag === 1 && compressionMethod === 0) {
              try {
                const compressed = Buffer.from(
                  input.buffer,
                  input.byteOffset + textStart,
                  dataEnd - textStart,
                );
                chunks[key] = inflateSync(compressed).toString('utf8');
              } catch {
                // Ignore corrupt compressed iTXt chunk.
              }
            } else if (compressionFlag === 0) {
              chunks[key] = readUtf8(input, textStart, dataEnd);
            }
          }
        }
      }
    } else if (type === 'IEND') {
      break;
    }

    offset = nextOffset;
  }

  return chunks;
}

function hasWebpSignature(buf: Uint8Array): boolean {
  if (buf.length < 12) return false;
  return (
    readAscii(buf, 0, 4) === 'RIFF'
    && readAscii(buf, 8, 12) === 'WEBP'
  );
}

function extractBalancedJson(text: string, startIndex: number): string | null {
  if (text[startIndex] !== '{') return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = startIndex; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(startIndex, i + 1);
    }
  }
  return null;
}

/**
 * Best-effort ComfyUI metadata extraction from WebP RIFF EXIF / XMP chunks.
 */
export function extractWebpTextChunks(input: Uint8Array): Record<string, string> {
  const chunks: Record<string, string> = {};
  if (!hasWebpSignature(input)) return chunks;

  let offset = 12;
  while (offset + 8 <= input.length) {
    const fourcc = readAscii(input, offset, offset + 4);
    const size =
      input[offset + 4]
      + (input[offset + 5] << 8)
      + (input[offset + 6] << 16)
      + ((input[offset + 7] << 24) >>> 0);
    const dataStart = offset + 8;
    const dataEnd = dataStart + size;
    if (dataEnd > input.length) break;

    if (fourcc === 'EXIF' || fourcc === 'XMP ') {
      const text = readUtf8(input, dataStart, dataEnd);
      for (const key of ['prompt', 'workflow'] as const) {
        if (chunks[key]) continue;
        const marker = `${key}:`;
        const idx = text.indexOf(marker);
        if (idx >= 0) {
          const braceIdx = text.indexOf('{', idx + marker.length);
          if (braceIdx >= 0 && braceIdx - (idx + marker.length) < 16) {
            const json = extractBalancedJson(text, braceIdx);
            if (json) chunks[key] = json;
          }
        }
      }
    }

    offset = dataEnd + (size % 2);
  }

  return chunks;
}

export function extractImageTextChunks(input: Uint8Array): ExtractedImageTextChunks {
  if (hasPngSignature(input)) {
    return { format: 'png', chunks: extractPngTextChunks(input) };
  }
  if (hasWebpSignature(input)) {
    return { format: 'webp', chunks: extractWebpTextChunks(input) };
  }
  return { format: 'unknown', chunks: {} };
}
