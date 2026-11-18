/**
 * 当前对话的消息时间轴。
 *
 * 用官方 React Bits **Line Sidebar**（`components/ui/line-sidebar.tsx`）承载刻度：
 * 每根短横线对应一条用户消息，鼠标靠近时邻近刻度轻微伸长，正在阅读的那一轮
 * 用主题强调色。
 *
 * 位置在聊天正文左缘（跟着内容列走，不属于左侧会话列表）：
 * * 悬停 / 键盘聚焦 → 右侧预览卡（问题 + 本轮回复摘要）；
 * * 点击 / Enter → 在聊天自己的滚动容器里跳到那一轮，不改变页面滚动；
 * * 滚动时按"当前阅读到哪一轮"高亮，长回复仍算同一轮；
 * * 刻度多到放不下时刻度区自己滚动，当前高亮始终可见。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import LineSidebar from "@/components/ui/line-sidebar";
import { Tooltip } from "@/components/ui/tooltip";
import type { ExtremeMessage } from "@/stores/extreme-store";
import { previewSnippet } from "./format-time";
import type { ChatScroll } from "./use-chat-scroll";

interface Turn {
  /** 用户消息的稳定 id：DOM 锚点与 React key 都用它。 */
  id: string;
  /** 用户问题首行。 */
  question: string;
  /** 本轮 AI 回复摘要（还没有就是空串）。 */
  answer: string;
  /** 这一轮仍在生成。 */
  live: boolean;
}

const QUESTION_LIMIT = 120;
const ANSWER_LIMIT = 180;

/** 一行预览：问题 + 本轮回复（生成中显示已有正文或「回复中」）。 */
function TurnPreview({ turn }: { turn: Turn }) {
  const { t } = useTranslation();
  return (
    <span className="flex w-[240px] flex-col gap-1">
      <span className="line-clamp-2 text-11 leading-4 font-medium text-fg">
        {turn.question || t("新任务")}
      </span>
      {(turn.answer || turn.live) && (
        <span className="line-clamp-3 text-10 leading-4 text-fg-muted">
          {turn.answer || t("回复中")}
        </span>
      )}
    </span>
  );
}

export function MessageTimeline({
  messages,
  asking,
  workspaceId,
  scrollRef,
  stick,
}: {
  messages: ExtremeMessage[];
  asking: boolean;
  workspaceId: string | null;
  scrollRef: RefObject<HTMLDivElement | null>;
  stick: ChatScroll["stick"];
}) {
  const { t } = useTranslation();
  const railRef = useRef<HTMLDivElement | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);

  /**
   * 一轮 = 一条用户消息 + 它后面、下一条用户消息之前的全部助手内容。
   *
   * 预览优先取**模型回复**（排除本机回执）：审批回执属于这一轮，但不该
   * 顶掉真正的回答摘要。
   */
  const turns = useMemo<Turn[]>(() => {
    const list: Turn[] = [];
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index];
      if (message.role !== "user") continue;
      let end = messages.length;
      for (let next = index + 1; next < messages.length; next += 1) {
        if (messages[next].role === "user") {
          end = next;
          break;
        }
      }
      const replies = messages
        .slice(index + 1, end)
        .filter((item) => item.role === "assistant" && !item.local && item.text.trim());
      const last = replies[replies.length - 1];
      const live = asking && end === messages.length;
      list.push({
        id: message.id,
        question: (message.text.trim().split("\n")[0] ?? "").slice(0, QUESTION_LIMIT),
        answer: last ? previewSnippet([last], ANSWER_LIMIT) : live ? t("回复中") : "",
        live,
      });
    }
    return list;
  }, [messages, asking, t]);

  // 滚动监听只需要"用户消息 id 列表"，不必在每个流式 delta 上重新绑定。
  const turnIds = useMemo(() => turns.map((turn) => turn.id).join("\u0001"), [turns]);
  const turnsRef = useRef(turns);
  turnsRef.current = turns;

  const activeIndex = turns.findIndex((turn) => turn.id === activeId);
  const controlledActive = activeIndex >= 0 ? activeIndex : null;

  /** 当前阅读到的那一轮：视口顶部往下 32px 以内、最后一条已进入的用户消息。 */
  const measure = useCallback(() => {
    const box = scrollRef.current;
    if (!box) return;
    const line = box.getBoundingClientRect().top + 32;
    let current: string | null = null;
    for (const turn of turnsRef.current) {
      const element = box.querySelector<HTMLElement>(
        `[data-message-id="${turn.id.replace(/"/g, '\\"')}"]`,
      );
      if (!element) continue;
      if (element.getBoundingClientRect().top <= line) current = turn.id;
      else break;
    }
    setActiveId(current ?? turnsRef.current[0]?.id ?? null);
  }, [scrollRef]);

  useEffect(() => {
    const box = scrollRef.current;
    if (!box) return undefined;
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };
    // 先量一次（切会话 / 历史装载 / 流式长高之后都要重新定位）。
    schedule();
    box.addEventListener("scroll", schedule, { passive: true });
    return () => {
      box.removeEventListener("scroll", schedule);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [measure, turnIds, workspaceId]);

  // 切会话：先清掉上一条对话的高亮，等布局恢复后再按目标位置重算。
  useEffect(() => {
    setActiveId(null);
    const frame = requestAnimationFrame(() => measure());
    return () => cancelAnimationFrame(frame);
  }, [workspaceId, measure]);

  /** 刻度很多时，让当前高亮留在刻度区可视范围内（只滚刻度，不动聊天）。 */
  useEffect(() => {
    const rail = railRef.current;
    if (!rail || activeIndex < 0) return;
    const tick = rail.querySelector<HTMLElement>(`[data-line-item="${activeIndex}"]`);
    if (!tick) return;
    const pad = 10;
    const top =
      tick.getBoundingClientRect().top - rail.getBoundingClientRect().top + rail.scrollTop;
    if (top < rail.scrollTop + pad) {
      rail.scrollTo({ top: Math.max(0, top - pad) });
    } else if (top + tick.offsetHeight > rail.scrollTop + rail.clientHeight - pad) {
      rail.scrollTo({ top: top + tick.offsetHeight - rail.clientHeight + pad });
    }
  }, [activeIndex]);

  /**
   * 跳到某一轮：只在聊天容器里滚。
   *
   * 历史轮次关掉跟随（底部流式输出不会把阅读位置拽走）；最后一轮恢复跟随，
   * 让仍在生成的内容继续贴底。
   */
  const jump = useCallback(
    (turn: Turn, isLast: boolean) => {
      const box = scrollRef.current;
      if (!box) return;
      setActiveId(turn.id);
      if (isLast) {
        stick.current = true;
        box.scrollTo({ top: box.scrollHeight, behavior: "smooth" });
        return;
      }
      stick.current = false;
      const element = box.querySelector<HTMLElement>(
        `[data-message-id="${turn.id.replace(/"/g, '\\"')}"]`,
      );
      if (!element) return;
      const top =
        box.scrollTop + element.getBoundingClientRect().top - box.getBoundingClientRect().top - 12;
      box.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
    },
    [scrollRef, stick],
  );

  if (turns.length === 0) return null;

  return (
    <div className="extreme-core-timeline pointer-events-none absolute inset-0 z-10">
      <div className="extreme-core-column relative mx-auto h-full w-full">
        <div className="pointer-events-auto absolute inset-y-0 -left-8 flex w-8 flex-col">
          <div
            ref={railRef}
            className="relative max-h-full overflow-y-auto py-6 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            <LineSidebar
              items={turns.map((turn) => turn.question)}
              showIndex={false}
              showLabel={false}
              showMarker
              // 受控高亮：由正文滚动位置决定；点击只是把高亮先切过去。
              activeIndex={controlledActive}
              markerLength={20}
              itemGap={10}
              proximityRadius={90}
              falloff="smooth"
              smoothing={90}
              accentColor="rgb(var(--accent))"
              markerColor="rgb(var(--fg-subtle) / 0.45)"
              itemLabel={(index) =>
                t("跳到第 {{n}} 轮：{{question}}", {
                  n: index + 1,
                  question: turns[index]?.question || t("新任务"),
                })
              }
              wrapTick={(index, _label, tick: ReactElement) => (
                <Tooltip
                  side="right"
                  delay={120}
                  label={<TurnPreview turn={turns[index]} />}
                >
                  {tick}
                </Tooltip>
              )}
              onItemClick={(index) => {
                const turn = turns[index];
                if (turn) jump(turn, index === turns.length - 1);
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
