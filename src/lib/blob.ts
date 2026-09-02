/**
 * `Uint8Array` → `Blob`, in the one shape TypeScript's DOM lib accepts.
 *
 * `BlobPart` requires a view over a plain `ArrayBuffer`, while our parsed
 * bytes are typed `Uint8Array<ArrayBufferLike>` (they may be a view into a
 * larger buffer). Copying into a fresh, exactly-sized buffer satisfies the
 * type *and* guarantees the blob contains only this file's bytes — a
 * `bytes.buffer` cast would silently include whatever else shares the buffer.
 */
export function bytesToBlob(bytes: Uint8Array, type: string): Blob {
  return new Blob([new Uint8Array(bytes).buffer], { type });
}
