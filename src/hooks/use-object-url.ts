import { useEffect, useState } from "react";
import { bytesToBlob } from "@/lib/blob";

/**
 * Turns bytes into a `blob:` URL and revokes it when they change or the
 * component unmounts.
 *
 * Preview content lives in memory, not on disk, so `blob:` is the only URL a
 * media element can be pointed at. Every URL is revoked on the way out — an
 * un-revoked URL pins the whole file in memory for the life of the window.
 */
export function useObjectUrl(bytes: Uint8Array | null | undefined, mime: string): string | null {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!bytes) {
      setUrl(null);
      return;
    }
    const next = URL.createObjectURL(bytesToBlob(bytes, mime));
    setUrl(next);
    return () => {
      URL.revokeObjectURL(next);
      setUrl(null);
    };
  }, [bytes, mime]);

  return url;
}
