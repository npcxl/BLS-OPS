/**
 * 发布 / 订阅面板：订阅一条频道，消息按到达顺序追加。
 *
 * 消息来自 Tauri Channel 的后台推送，不轮询；面板卸载时自动退订，
 * 避免后台任务泄漏（PUBSUB_MAX 只限制订阅数，不回收失去订阅者的任务）。
 */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { databaseApi } from "@/api/ops-api";
import type { DatabaseProfile, RedisPubSubEvent } from "@/api/types/database";
import { toDbError } from "@/stores/database-store";
import { X } from "@/components/icons";

/**
 * 消息负载解码：Rust 侧统一推 Base64（二进制无损）。
 * 解码后按严格 UTF-8 试一次：文本正常显示，真二进制回退成 Base64 文本。
 */
function decodePubsubMessage(event: RedisPubSubEvent): string {
  if (event.messageBase64) {
    try {
      const raw = atob(event.messageBase64);
      const bytes = Uint8Array.from(raw, (char) => char.charCodeAt(0));
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return `base64: ${event.messageBase64}`;
    }
  }
  return event.message ?? "";
}

export function PubSubPanel({
  profile,
  dbIndex,
  onClose,
}: {
  profile: DatabaseProfile;
  dbIndex: number;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [channel, setChannel] = useState("");
  const [subId, setSubId] = useState<string | null>(null);
  const [messages, setMessages] = useState<RedisPubSubEvent[]>([]);
  const [publishChannel, setPublishChannel] = useState("");
  const [publishMessage, setPublishMessage] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  // Channel 回调经 ref 保持稳定，避免重订阅。
  const onMessageRef = useRef((event: RedisPubSubEvent) => {
    // 连接断开/服务端结束任务时后端会推 closed：前端同步复位，
    // 输入框解锁、可以重新订阅，而不是一直显示"已订阅"却收不到消息。
    if (event.event === "closed") setSubId(null);
    setMessages((current) => [...current.slice(-199), event]);
  });

  const subIdRef = useRef<string | null>(null);
  useEffect(() => {
    subIdRef.current = subId;
  }, [subId]);

  // 面板关掉/组件卸载时必须退订：否则后端 PubSubTask 会一直占着连接收消息。
  useEffect(
    () => () => {
      const id = subIdRef.current;
      if (id) void databaseApi.redisUnsubscribe(id).catch(() => undefined);
    },
    [],
  );

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages.length]);

  const subscribe = async () => {
    if (!channel.trim()) return;
    try {
      const id = await databaseApi.redisSubscribe(
        profile.id,
        dbIndex,
        channel.trim(),
        (event) => onMessageRef.current(event),
      );
      setSubId(id);
    } catch (failure) {
      setMessages((current) => [
        ...current,
        {
          event: "error",
          subId: "",
          message: toDbError(failure).message,
        },
      ]);
    }
  };

  const unsubscribe = async () => {
    if (!subId) return;
    await databaseApi.redisUnsubscribe(subId).catch(() => undefined);
    setSubId(null);
  };

  return (
    <div className="absolute inset-y-0 right-0 z-20 flex w-[360px] flex-col border-l border-line bg-surface-1 shadow-[-12px_0_32px_rgb(15_23_42/0.08)]">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3">
        <span className="flex-1 text-12 font-medium text-fg-muted">{t("发布 / 订阅")}</span>
        <Button
          variant="ghost"
          size="xs"
          className="h-5 w-5 px-0"
          aria-label={t("关闭")}
          onClick={() => {
            // 关闭面板顺手退订，不能把订阅任务漏在后端。
            void unsubscribe().finally(onClose);
          }}
        >
          <X size={12} />
        </Button>
      </div>

      <div className="shrink-0 border-b border-line px-3 py-2">
        <div className="flex items-center gap-2">
          <input
            className="h-[26px] min-w-0 flex-1 rounded-[6px] border border-line bg-surface-1 px-2 font-mono text-11 text-fg outline-none focus:border-accent"
            placeholder={t("频道名，例如 orders:events")}
            value={channel}
            disabled={!!subId}
            onChange={(event) => setChannel(event.target.value)}
          />
          {subId ? (
            <Button variant="secondary" size="xs" onClick={() => void unsubscribe()}>
              {t("取消订阅")}
            </Button>
          ) : (
            <Button variant="secondary" size="xs" disabled={!channel.trim()} onClick={() => void subscribe()}>
              {t("订阅")}
            </Button>
          )}
        </div>
        {subId && (
          <p className="mt-1 text-10 text-success">
            {t("已订阅 {{channel}}，消息实时到达", { channel })}
          </p>
        )}
      </div>

      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {messages.length === 0 && (
          <p className="text-11 leading-relaxed text-fg-subtle">
            {t("订阅后，到达该频道的消息会实时出现在这里。")}
          </p>
        )}
        {messages.map((event, index) => (
          <div key={index} className="mb-1.5 rounded-[6px] border border-line/70 px-2 py-1">
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  "text-10 font-medium",
                  event.event === "message" && "text-accent",
                  event.event === "error" && "text-danger",
                  event.event !== "message" && event.event !== "error" && "text-fg-subtle",
                )}
              >
                {event.event}
              </span>
              {event.channel && (
                <span className="min-w-0 truncate font-mono text-10 text-fg-subtle">
                  {event.channel}
                </span>
              )}
            </div>
            {event.messageBase64 ? (
              <div className="mt-0.5 break-all font-mono text-11 text-fg">
                {decodePubsubMessage(event)}
              </div>
            ) : (
              event.message && (
                <div className="mt-0.5 break-all font-mono text-11 text-fg">
                  {event.message}
                </div>
              )
            )}
          </div>
        ))}
      </div>

      <div className="shrink-0 border-t border-line px-3 py-2">
        <div className="mb-1 text-11 font-medium text-fg-muted">{t("发布消息")}</div>
        <div className="flex items-center gap-2">
          <input
            className="h-[26px] w-[130px] rounded-[6px] border border-line bg-surface-1 px-2 font-mono text-11 text-fg outline-none focus:border-accent"
            placeholder={t("频道")}
            value={publishChannel}
            onChange={(event) => setPublishChannel(event.target.value)}
          />
          <input
            className="h-[26px] min-w-0 flex-1 rounded-[6px] border border-line bg-surface-1 px-2 font-mono text-11 text-fg outline-none focus:border-accent"
            placeholder={t("消息内容")}
            value={publishMessage}
            onChange={(event) => setPublishMessage(event.target.value)}
          />
          <Button
            variant="secondary"
            size="xs"
            disabled={!publishChannel.trim()}
            onClick={async () => {
              try {
                const receivers = await databaseApi.redisPublish(
                  profile.id,
                  dbIndex,
                  publishChannel.trim(),
                  publishMessage,
                );
                setMessages((current) => [
                  ...current,
                  {
                    event: "message",
                    subId: "",
                    channel: publishChannel.trim(),
                    message: t("已发布给 {{count}} 个订阅者", { count: receivers }),
                  },
                ]);
              } catch (failure) {
                setMessages((current) => [
                  ...current,
                  { event: "error", subId: "", message: toDbError(failure).message },
                ]);
              }
            }}
          >
            {t("发布")}
          </Button>
        </div>
      </div>
    </div>
  );
}
