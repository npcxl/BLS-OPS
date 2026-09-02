import { useState } from "react";
import { Music, VideoOff } from "lucide-react";
import { useObjectUrl } from "@/hooks/use-object-url";
import { formatSize } from "@/lib/format";

/**
 * Audio / video preview over a `blob:` URL.
 *
 * The WebView decodes whatever its codecs support — nothing is transcoded.
 * When a container/codec is unsupported the element fires `error`, and we say
 * so instead of leaving a dead control strip on screen.
 */
export function MediaPreview({
  bytes,
  mime,
  audio,
}: {
  bytes: Uint8Array;
  mime: string;
  audio: boolean;
}) {
  const url = useObjectUrl(bytes, mime);
  const [failed, setFailed] = useState(false);

  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3 p-6">
      <div className="flex items-center gap-2 text-12 text-fg-subtle">
        <Music size={14} />
        {audio ? "音频" : "视频"} · {formatSize(bytes.length)}
      </div>

      {failed ? (
        <div className="flex flex-col items-center gap-1.5 text-center">
          <VideoOff size={20} className="text-fg-subtle" />
          <p className="max-w-[360px] text-11 leading-relaxed text-fg-muted">
            当前环境无法播放这种格式（{mime}）。可下载后用本地播放器打开。
          </p>
        </div>
      ) : audio ? (
        <audio
          key={url ?? ""}
          src={url ?? undefined}
          controls
          className="w-[min(480px,90%)]"
          onError={() => setFailed(true)}
        />
      ) : (
        <video
          key={url ?? ""}
          src={url ?? undefined}
          controls
          className="max-h-full w-[min(880px,96%)] rounded-[8px] bg-black"
          onError={() => setFailed(true)}
        />
      )}
    </div>
  );
}
