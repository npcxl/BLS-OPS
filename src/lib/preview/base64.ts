/**
 * Base64 → bytes for the preview payload.
 *
 * The backend hands file content over as base64 because the IPC layer is JSON;
 * this turns it back into the typed array every parser takes. Chunked because
 * `atob` on a 20 MB string produces a 20 MB JS string, and building the result
 * one `charCodeAt` at a time over that is measurably slower than working in
 * 64 KB slices.
 */
export function base64ToBytes(base64: string): Uint8Array {
  const bytes = new Uint8Array(byteLength(base64));
  const chunk = 64 * 1024;
  let offset = 0;

  for (let index = 0; index < base64.length; index += chunk) {
    const slice = base64.slice(index, index + chunk);
    const binary = atob(slice);
    for (let i = 0; i < binary.length; i++) bytes[offset + i] = binary.charCodeAt(i);
    offset += binary.length;
  }
  return bytes.subarray(0, offset);
}

/** Decoded byte count, ignoring padding and whitespace. */
function byteLength(base64: string): number {
  const clean = base64.replace(/[\s=]/g, "");
  return Math.floor((clean.length * 3) / 4);
}
