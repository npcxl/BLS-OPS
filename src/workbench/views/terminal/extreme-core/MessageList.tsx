import { XMarkdown } from "@ant-design/x-markdown";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { Copy, FileArchive, Pencil, Quote } from "@/components/icons";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { copyTextWithFeedback } from "@/lib/clipboard-feedback";
import { formatSize } from "@/lib/format";
import type { ExtremeAttachment, ExtremeMessage } from "@/stores/extreme-store";
import LatticeLoader from "@/components/reactbits/LatticeLoader";
import { AgentActivity, isAgentActivity } from "./AgentActivity";
import { AgentStepRun, type AgentStepItem } from "./AgentStepRow";
import { chatTime, durationText } from "./format-time";
import { QuestionCard } from "./QuestionCard";
import {
  hasStepParts,
  type MessageNotePart,
  type MessagePart,
  type MessageQuestionPart,
  type MessageTextPart,
} from "./message-parts";
import { splitStreamingMarkdown } from "./stream-markdown";
import { EC } from "./theme";
import type { ApprovalEntry } from "./view/types";
import { TaskCardView } from "./TaskCardView";
import type { TaskArtifact, TaskCardModel } from "./task-view";
import type { WorkspaceTarget } from "./RemoteWorkspacePanel";
import { RemotePathLink, type OpenTarget } from "./RemotePathLink";
import { ExtremeIconButton } from "./ExtremeIconButton";

/**
 * **已定稿**的那半段 Markdown。
 *
 * 流式正文以空行 / 闭合代码块为界切成两半：前面交给它（只在越过边界时重解析
 * 一次），后面那截还在长的按纯文本显示。这样一条 20 KB 的回复不会再每来一个
 * 字就整篇重排一遍。
 */
const StableMarkdown = memo(function StableMarkdown({
  content,
  onOpen,
}: {
  content: string;
  sessionId?: string;
  onOpen?: OpenTarget;
}) {
  return (
    <XMarkdown
      className="extreme-core-markdown"
      content={content}
      streaming={false}
      config={MARKDOWN_CONFIG}
      components={workspaceComponents}
      componentsProps={{
        a: { onOpen },
      }}
      dompurifyConfig={MARKDOWN_SANITIZE}
    />
  );
});

/**
 * 一条回复的 Markdown 正文。
 *
 * **必须 memo**：流式回答每来一个 token，父组件就会重渲染一次；没有这层缓存
 * 时，整段历史里**每一条**回复都会重新解析 Markdown + DOMPurify 消毒一遍，
 * 长对话下直接卡到点不动。现在只有正文真的变了的那条会重算。
 */
const MarkdownBody = memo(function MarkdownBody({
  content,
  streaming,
  sessionId,
  onOpen,
}: {
  content: string;
  streaming: boolean;
  sessionId?: string;
  onOpen?: OpenTarget;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [visibleContent, setVisibleContent] = useState(() => streaming ? "" : content);
  const displayed = useRef(visibleContent);
  const target = useRef(content);
  target.current = content;

  useEffect(() => {
    if (!streaming) {
      displayed.current = target.current;
      setVisibleContent(target.current);
      return;
    }
    let frame = 0;
    let previous = 0;
    let credit = 0;
    const tick = (time: number) => {
      if (!previous) previous = time;
      if (!target.current.startsWith(displayed.current)) {
        displayed.current = target.current;
        setVisibleContent(target.current);
      }
      const remaining = Array.from(target.current.slice(displayed.current.length));
      if (!remaining.length) credit = 0;
      // 积压时加速追赶，避免网络突发数据造成长时间显示延迟。
      if (remaining.length) credit += Math.min(time - previous, 100) * Math.max(0.07, remaining.length / 900);
      previous = time;
      const count = Math.min(remaining.length, Math.floor(credit));
      if (count > 0) {
        credit -= count;
        displayed.current += remaining.slice(0, count).join("");
        setVisibleContent(displayed.current);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [streaming]);
  /**
   * 只有**接近视口**的回复才真正解析 Markdown。
   *
   * 打开一条长对话时，如果一次性把所有历史都丢给 XMarkdown（解析 + DOMPurify
   * 消毒），点一下就白屏几秒 —— 这里先渲染纯文本，滚到附近再换成 Markdown。
   */
  // 短消息直接解析（成本可忽略）；只有长回复才等滚到附近再解析。
  const [ready, setReady] = useState(streaming || content.length < 1200);

  useEffect(() => {
    if (ready) return undefined;
    if (content.length < 1200) {
      setReady(true);
      return undefined;
    }
    const node = ref.current;
    if (!node) return undefined;
    // 测试 / 不支持 IntersectionObserver 的环境：直接全量渲染。
    if (typeof IntersectionObserver === "undefined") {
      setReady(true);
      return undefined;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        setReady(true);
      },
      { rootMargin: "400px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [ready]);

  if (!ready) {
    // 纯文本预览：保留换行，不解析语法（成本几乎为零）。
    return (
      <div ref={ref} className="extreme-core-markdown whitespace-pre-wrap">
        {content}
      </div>
    );
  }

  if (streaming) {
    const { stable, tail } = splitStreamingMarkdown(visibleContent);
    return (
      <div ref={ref}>
        {stable && <StableMarkdown content={stable} sessionId={sessionId} onOpen={onOpen} />}
        {/*
         * 还在长的这一截：纯文本，不解析。它每个字都在变，交给 Markdown 的
         * 话等于每个字都重解析一次 —— 而它本来也还不是一个完整的块。
         */}
        {tail && (
          <span className="extreme-core-markdown extreme-core-stream-tail whitespace-pre-wrap">
            {tail}
          </span>
        )}
      </div>
    );
  }

  return (
    <div ref={ref}>
      <XMarkdown
        className="extreme-core-markdown"
        content={content}
        streaming={false}
        config={MARKDOWN_CONFIG}
        components={workspaceComponents}
        componentsProps={{
          a: { sessionId, onOpen },
          code: { sessionId, onOpen },
        }}
        dompurifyConfig={MARKDOWN_SANITIZE}
      />
    </div>
  );
});

/** 任务卡与执行活动也是"历史"，没必要跟着每个 token 重算。 */
const MemoAgentActivity = memo(AgentActivity);
const MemoTaskCardView = memo(TaskCardView);

/* ---------------- 一轮回复里的有序片段 ---------------- */

type TurnBlock =
  | { kind: "text"; part: MessageTextPart }
  | { kind: "note"; part: MessageNotePart }
  | { kind: "question"; part: MessageQuestionPart }
  | { kind: "steps"; items: AgentStepItem[] }
  /** 平台内部纠错：命令没有执行，收纳成一条可展开的记录。 */
  | { kind: "internal"; items: AgentStepItem[] };

/**
 * 把片段切成「正文块」与「相邻步骤组」：中间隔着正文就不再合并。
 *
 * 步骤按片段自带的 `taskId` 找任务卡（不依赖"这条消息是不是任务归属"）：
 * 旧记录里任务卡挂在用户消息上，回复上的步骤行仍要能读到状态与输出。
 */
function turnBlocks(
  parts: MessagePart[],
  stepTask: TaskCardModel | undefined,
  approvalByStep: Map<string, ApprovalEntry>,
): TurnBlock[] {
  const blocks: TurnBlock[] = [];
  for (const part of parts) {
    if (part.kind === "text") {
      blocks.push({ kind: "text", part });
      continue;
    }
    // 计划是卡片数据，不占聊天正文的位置。
    if (part.kind === "plan") continue;
    if (part.kind === "note") {
      blocks.push({ kind: "note", part });
      continue;
    }
    if (part.kind === "question") {
      blocks.push({ kind: "question", part });
      continue;
    }
    const step = stepTask?.steps.find((item) => item.id === `agent-${part.stepIndex}`);
    const approval = approvalByStep.get(`${part.taskId}:${part.stepIndex}`);
    const previous = blocks[blocks.length - 1];
    const item: AgentStepItem = { part, step, approval };
    /*
     * 内部纠错（声明冲突 / 看不懂 / 参数不合法）不是用户要读的操作：
     * 相邻的几次合并成一条默认收起的记录，展开仍能看到完整原因（审计不丢）。
     * 判定优先用消息上落盘的标记，任务卡还没装回来时也能正确分类；
     * 两者都没有 = 旧记录，按真实执行展示。
     */
    if (part.internal || step?.category === "internal") {
      if (previous?.kind === "internal") previous.items.push(item);
      else blocks.push({ kind: "internal", items: [item] });
      continue;
    }
    const childGroup = part.groupId?.startsWith("children-") ? part.groupId : undefined;
    const previousGroup = previous?.kind === "steps" ? previous.items[0]?.part.groupId : undefined;
    const previousChildGroup = previousGroup?.startsWith("children-") ? previousGroup : undefined;
    if (previous?.kind === "steps" && childGroup === previousChildGroup) previous.items.push(item);
    else blocks.push({ kind: "steps", items: [item] });
  }
  return blocks;
}

/**
 * 200ms 内就结束的等待不显示加载行 —— 否则快回复会"闪一下"。
 *
 * 只在等待确实持续时才出现；`active` 一变 false 立刻收起（正文流出、
 * 工具开始执行、任务结束都走这条）。
 */
function useDelayedFlag(active: boolean, delay = 200): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!active) {
      setVisible(false);
      return undefined;
    }
    const timer = window.setTimeout(() => setVisible(true), delay);
    return () => window.clearTimeout(timer);
  }, [active, delay]);
  return active && visible;
}

/**
 * 本轮**已用时间**：跟在回复最后，运行中每秒走一次，结束后定格。
 *
 * 只在"这一轮在本会话里真的跑过"时出现（`seenRunning`）：重新打开的历史
 * 对话没有结束时刻，拿 `createdAt` 减现在只会显示几十小时，宁可不显示。
 */
function ElapsedTime({
  startedAt,
  running,
  executedSteps = 0,
}: {
  startedAt: number;
  running: boolean;
  executedSteps?: number;
}) {
  const { t } = useTranslation();
  const [now, setNow] = useState(() => Date.now());
  const [frozen, setFrozen] = useState<number | null>(null);
  const [seenRunning, setSeenRunning] = useState(running);
  useEffect(() => {
    if (!running) {
      setSeenRunning((seen) => {
        if (seen) setFrozen((value) => value ?? Date.now());
        return seen;
      });
      return undefined;
    }
    setSeenRunning(true);
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  if (!seenRunning) return null;
  const duration = durationText((frozen ?? now) - startedAt, t);
  if (!duration) return null;
  return (
    <div className="extreme-core-elapsed" role="note">
      <span>{t("已用时间 {{duration}}", { duration })}</span>
      {executedSteps > 0 && (
        <span className="extreme-core-elapsed-sep">
          · {t("{{n}} 个操作", { n: executedSteps })}
        </span>
      )}
    </div>
  );
}

const ACTIVE_STEP = new Set(["running", "waiting"]);

function stepIsActive(item: AgentStepItem): boolean {
  if (item.approval?.phase === "denied") return false;
  if (item.approval && !item.approval.closed) return true;
  return Boolean(item.step && ACTIVE_STEP.has(item.step.state));
}

/**
 * 正文与步骤按发生顺序渲染。
 *
 * 任何时刻最多一个「当前阶段」：
 * * 有步骤在跑 / 等确认 → 步骤行自己就是提示，不再加字；
 * * 步骤刚结束、模型还没开始写 → 末尾一行「正在整理结果」，正文一出就收起。
 */
function ReplyLoader({ label }: { label: string }) {
  return <LatticeLoader label={label} cellSize={3} gap={1} fontSize={12} showTimer={false} />;
}

function TurnTimeline({
  messageId,
  parts,
  streaming,
  stepTask,
  approvalByStep,
  sessionId,
  onOpen,
  onDecideApproval,
  onOpenOutput,
  onOpenChanges,
}: {
  messageId: string;
  parts: MessagePart[];
  streaming: boolean;
  /** 这一轮命令所属的任务卡（消息上的步骤片段都来自同一次运行）。 */
  stepTask?: TaskCardModel;
  approvalByStep: Map<string, ApprovalEntry>;
  sessionId?: string;
  onOpen?: OpenTarget;
  onDecideApproval?: (entry: ApprovalEntry, allow: boolean) => void;
  onOpenOutput?: () => void;
  onOpenChanges?: (task: TaskCardModel) => void;
}) {
  const { t } = useTranslation();
  const blocks = turnBlocks(parts, stepTask, approvalByStep);
  const last = blocks[blocks.length - 1];
  const active = blocks.some(
    (block) => block.kind === "steps" && block.items.some(stepIsActive),
  );
  const stage = streaming && last?.kind === "steps" && !active;
  /** 步骤刚结束、模型还没吐字的短暂空窗：超过 200ms 才提示，避免闪一下。 */
  const stageVisible = useDelayedFlag(stage);

  return (
    <div className="extreme-core-turn">
      {blocks.map((block) => {
        if (block.kind === "text") {
          const isLast = block === last;
          return (
            <MarkdownBody
              key={block.part.id}
              content={block.part.text}
              streaming={streaming && isLast}
              sessionId={sessionId}
              onOpen={onOpen}
            />
          );
        }
        if (block.kind === "note") {
          // 执行前说明：模型只发了工具时由后端补的一句，紧跟下面的命令。
          return (
            <p key={block.part.id} className="extreme-core-turn-note">
              {block.part.text}
            </p>
          );
        }
        if (block.kind === "question") {
          return (
            <QuestionCard
              key={block.part.id}
              part={block.part}
              messageId={messageId}
            />
          );
        }
        if (block.kind === "internal") {
          /*
           * 一条默认收起的「内部调整」：默认聊天正文只说明平台改过执行方式，
           * 不逐条铺开"平台识别错了"的过程；需要诊断时展开就是完整原因。
           */
          return (
            <details
              key={block.items[0].part.id}
              className="extreme-core-attempts extreme-core-internal-bounces"
              data-internal-bounces={block.items.length}
            >
              <summary>
                {t("{{count}} 次命令未执行（展开查看原因）", {
                  count: block.items.length,
                })}
              </summary>
              <div className="extreme-core-attempts-content">
                {block.items.map((item) => (
                  <AgentStepRun
                    key={item.part.id}
                    items={[item]}
                    goal={stepTask?.goal}
                    onOpenOutput={onOpenOutput}
                  />
                ))}
              </div>
            </details>
          );
        }
        /*
         * 只有**真正执行失败**的一组才收成「N 次操作失败」。
         * 拒绝 / 权限拦下的步骤是"未执行"，混进来会把"没跑"说成"跑失败了"。
         */
        const failedAttempts = block.items.every(
          (item) =>
            item.step?.state === "failed" &&
            !item.approval &&
            item.step?.category !== "denied" &&
            item.step?.category !== "internal",
        );
        if (failedAttempts) {
          return (
            <details key={block.items[0].part.id} className="extreme-core-attempts">
              <summary>{t("{{count}} 次操作失败（展开查看原因）", { count: block.items.length })}</summary>
              <div className="extreme-core-attempts-content">
                {block.items.map((item) => (
                  <AgentStepRun key={item.part.id} items={[item]} goal={stepTask?.goal} onOpenOutput={onOpenOutput} />
                ))}
              </div>
            </details>
          );
        }
        return (
          <AgentStepRun
            key={block.items[0].part.id}
            items={block.items}
            goal={stepTask?.goal}
            onDecide={onDecideApproval}
            onOpenOutput={onOpenOutput}
            onOpenChanges={
              stepTask && onOpenChanges ? () => onOpenChanges(stepTask) : undefined
            }
          />
        );
      })}
      {stageVisible && (
        <div className="extreme-core-reply-wait extreme-core-turn-stage" role="status">
          <ReplyLoader label={t("正在整理结果")} />
        </div>
      )}
    </div>
  );
}


// GFM handles bare URLs. POSIX paths in prose also enter the same verified-link renderer.
const plainPath = String.raw`/[a-zA-Z0-9._~+@%=-]+(?:/[a-zA-Z0-9._~+@%=-]+)*/?`;
const pathStart = new RegExp(String.raw`(?<![\w/:])${plainPath}`);
const pathToken = new RegExp(`^${plainPath}`);
const MARKDOWN_CONFIG: ComponentProps<typeof XMarkdown>["config"] = {
  gfm: true,
  extensions: [{
    name: "remotePath",
    level: "inline",
    start: (text) => pathStart.exec(text)?.index,
    tokenizer(src) {
      if (this.lexer.state.inLink) return undefined;
      const raw = pathToken.exec(src)?.[0]?.replace(/[.]+$/, "");
      if (!raw) return undefined;
      return { type: "remotePath", raw, path: raw };
    },
    renderer: (token) => `<a href="${token.path}">${token.path}</a>`,
  }],
};

function websiteTarget(value: string): WorkspaceTarget | null {
  try {
    const url = new URL(value);
    if ((url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password) {
      return { kind: "website", url: url.href };
    }
  } catch {
    return null;
  }
  return null;
}

type MarkdownComponent = ComponentProps<typeof XMarkdown>["components"];
type LinkProps = {
  href?: string;
  children?: ReactNode;
  block?: boolean;
  className?: string;
  sessionId?: string;
  onOpen?: OpenTarget;
};

function isRemotePath(path: string): boolean {
  return /^\/(?!\/)[^\u0000-\u001f<>|]*$/.test(path) && !path.split("/").includes("..");
}

function WorkspaceLink({ href, children, sessionId, onOpen }: LinkProps) {
  const target = href ? websiteTarget(href) : null;
  if (href && sessionId && isRemotePath(href)) {
    return <RemotePathLink path={href} sessionId={sessionId} onOpen={onOpen}>{children}</RemotePathLink>;
  }
  return target && onOpen
    ? <a href={href} onClick={(event) => { event.preventDefault(); onOpen(target); }}>{children}</a>
    : <span>{children}</span>;
}

function LinkedCode({ children, block, className, sessionId, onOpen }: LinkProps) {
  const path = !block && typeof children === "string" ? children.trim() : "";
  return (
    <code className={className}>
      {path && sessionId && isRemotePath(path) ? (
        <RemotePathLink path={path} sessionId={sessionId} onOpen={onOpen}>{children}</RemotePathLink>
      ) : children}
    </code>
  );
}

function ReplyCodeBlock({ children }: { children?: ReactNode }) {
  const { t } = useTranslation();
  const codeRef = useRef<HTMLPreElement>(null);

  return (
    <div className="extreme-core-reply-code">
      <Tooltip label={t("复制代码")}>
        <button
          type="button"
          className="extreme-core-reply-copy"
          aria-label={t("复制代码")}
          onClick={() => {
            const text = codeRef.current?.textContent;
            if (text) void copyTextWithFeedback(text);
          }}
        >
          <Copy size={14} />
        </button>
      </Tooltip>
      <pre ref={codeRef}>{children}</pre>
    </div>
  );
}

function ReplyTable({ children }: { children?: ReactNode }) {
  return (
    <div className="extreme-core-reply-table">
      <table>{children}</table>
    </div>
  );
}

const workspaceComponents: MarkdownComponent = {
  a: WorkspaceLink,
  code: LinkedCode,
  pre: ReplyCodeBlock,
  table: ReplyTable,
};

/**
 * 模型回复的净化配置。
 *
 * 回复里允许 Markdown，但**不允许**任何可能执行或外联的东西：
 * * `img` 禁掉 —— 外部图片会被自动加载，等于把用户 IP / 阅读行为发给第三方，
 *   也可能用来做"看不见的跟踪像素"；
 * * `script` / `iframe` / `object` 等一律禁止；
 * * `onerror` / `onload` / `onclick` 这类事件属性禁止；
 * * `style` 禁掉，避免回复里塞 `position: fixed` 盖住整个界面。
 */
const MARKDOWN_SANITIZE = {
  FORBID_TAGS: [
    "img",
    "script",
    "style",
    "iframe",
    "object",
    "embed",
    "video",
    "audio",
    "form",
    "input",
    "button",
  ],
  FORBID_ATTR: ["style", "onerror", "onload", "onclick", "onmouseover", "srcset"],
  ADD_ATTR: ["data-block"],
  ALLOW_DATA_ATTR: false,
};

/**
 * 一条消息。
 *
 * **props 里只放 `message` 对象本身**：`patchMessageIn` 只替换目标那条，其余
 * 消息的对象引用不变，所以流式时这一行之外的所有气泡都能被 memo 跳过 ——
 * 每帧 reconcile 的节点数从"整段对话"降到"一条"。
 */
const MessageRow = memo(function MessageRow({
  message,
  attachmentById,
  streaming,
  isLast = false,
  task,
  stepTask,
  approvalByStep,
  sessionId,
  onPreview,
  onOpenWorkspaceTarget,
  onResumeTask,
  onOpenChanges,
  onDecideApproval,
  onOpenOutput,
  onQuote,
  onEdit,
  onRetryMessage,
  onResendMessage,
}: {
  message: ExtremeMessage;
  attachmentById: Map<string, ExtremeAttachment>;
  streaming: boolean;
  /** 最后一条消息：已用时间只挂在它后面。 */
  isLast?: boolean;
  task?: TaskCardModel;
  /** 这一轮命令所属的任务卡：步骤行按它解析状态与输出。 */
  stepTask?: TaskCardModel;
  /** `<taskId>:<stepIndex>` → 这一步挂起 / 已表态的审批。 */
  approvalByStep: Map<string, ApprovalEntry>;
  sessionId?: string;
  onPreview?: (artifact: TaskArtifact, sessionId: string) => void;
  onOpenWorkspaceTarget?: OpenTarget;
  onResumeTask?: (task: TaskCardModel) => void;
  /** 「查看实际变更」：在右栏打开这次运行的文件变更。 */
  onOpenChanges?: (task: TaskCardModel) => void;
  /** 审批表态：按同一步骤的 taskId + callId 原地更新。 */
  onDecideApproval?: (entry: ApprovalEntry, allow: boolean) => void;
  /** 展开的命令：在右侧终端查看真实输出。 */
  onOpenOutput?: (taskId: string) => void;
  onQuote?: (message: ExtremeMessage) => void;
  onEdit?: (message: ExtremeMessage) => void;
  /** 回复中断：用原问题重新跑一次。 */
  onRetryMessage?: (message: ExtremeMessage) => void;
  /** 用户消息没送达：把原文放回输入框。 */
  onResendMessage?: (message: ExtremeMessage) => void;
}) {
  const { t } = useTranslation();
  const mine = message.role === "user";
  /** 这一轮记下了正文与步骤的顺序：按发生顺序内联渲染。 */
  const timeline = !mine && message.parts?.length ? message.parts : null;
  const inlineSteps = timeline
    ? hasStepParts(timeline) || timeline.some((part) => part.kind === "question")
    : false;
  /*
   * 还没有任何正文：给一个轻量占位，避免气泡突然出现又跳高度。
   * 有内联步骤时由步骤行 / 「正在整理结果」承担提示，不再重复。
   */
  /*
   * 本轮还在等模型：没有可见正文、也没有命令在跑。
   *
   * 只看 `!timeline` 不够 —— 先收到计划/空白增量时 timeline 已经有片段，
   * 但屏幕上什么都还没出现，用户只能干等。
   */
  const visibleText = message.text.trim().length > 0;
  const hasSteps = timeline ? timeline.some((part) => part.kind === "step") : false;
  const hasQuestion = timeline ? timeline.some((part) => part.kind === "question") : false;
  const waiting = !mine && streaming && !visibleText && !hasSteps && !hasQuestion;
  /** 首段回复的等待：200ms 后才出「思考中」，正文一开始流出就收起。 */
  const thinking = useDelayedFlag(waiting);
  /*
   * 气泡下的操作条：统一用项目的 `ExtremeIconButton` + `Tooltip`：
   * 模型回复「复制 / 引用」，自己发的「复制 / 编辑」；占位气泡没有正文，
   * 不给按钮。复制走项目剪贴板插件，失败会提示，不会假装成功。
   */
  const canAct = !waiting && !streaming && message.text.trim().length > 0;
  const author = mine ? t("你") : message.model ? `${t("模型")}：${message.model}` : null;
  const time = chatTime(message.createdAt, t);
  /**
   * 气泡上的文件条：**消息快照优先**。
   *
   * 快照是发送那一刻定下来的（名称 / 大小 / 远程路径），附件之后被移除、
   * 或者换到别的服务器回看历史都不会变；只有旧消息没有快照时才回查
   * 会话里的附件列表。
   */
  const sentFiles = useMemo(() => {
    if (message.attachmentSnapshot?.length) {
      return message.attachmentSnapshot.map((item) => ({
        id: item.id,
        name: item.name,
        size: item.size,
        path: item.path,
        remotePath: item.remotePath,
        uploadState: attachmentById.get(item.id)?.uploadState,
        stagedCleaned: attachmentById.get(item.id)?.stagedCleaned,
      }));
    }
    return (message.attachmentIds ?? [])
      .map((id) => attachmentById.get(id))
      .filter((item): item is NonNullable<typeof item> => Boolean(item))
      .map((item) => ({
        id: item.id,
        name: item.name,
        size: item.size,
        path: item.path,
        remotePath: item.remotePath,
        uploadState: item.uploadState,
        stagedCleaned: item.stagedCleaned,
      }));
  }, [message.attachmentSnapshot, message.attachmentIds, attachmentById]);

  return (
    <div
      data-role={message.role}
      data-message-id={message.id}
      className={cn("flex min-w-0 flex-col gap-1.5", mine ? "items-end" : "items-start")}
    >
      {/*
       * 随这条消息发出的附件：发完就从输入区挪到这里。
       *
       * **优先读消息上的快照**（发送那一刻定下来的名称 / 大小 / 路径）：
       * 附件之后被移除、或换到别的服务器回看历史，气泡上仍然是当时发出去的
       * 那个文件；快照没有的老消息才退回会话里的附件列表。
       */}
      {mine && sentFiles.length > 0 && (
        <div className="flex max-w-[78%] flex-wrap justify-end gap-1">
          {sentFiles.map((item) => {
            const uploaded = item.uploadState === "uploaded" || item.uploadState === "deployed";
            return (
              <span
                key={item.id}
                className="flex max-w-[240px] items-center gap-1.5 rounded-md px-2 py-1 text-11"
                style={{
                  background: EC.surfaceRaised,
                  border: `1px solid ${EC.border}`,
                  color: EC.fg,
                }}
                title={item.remotePath ?? item.path ?? item.name}
              >
                <FileArchive size={12} className="shrink-0" />
                <span className="truncate">{item.name}</span>
                <span className="shrink-0" style={{ color: EC.fgSubtle }}>
                  {formatSize(item.size)}
                </span>
                {uploaded && (
                  <span className="shrink-0" style={{ color: EC.accent }}>
                    {t("已上传")}
                  </span>
                )}
                {/* 暂存副本可能被清理：历史里保留名称与这个状态，不装作还在。 */}
                {(item.uploadState === "cleaned" || item.stagedCleaned) && (
                  <span className="shrink-0 text-fg-subtle">{t("暂存已清理")}</span>
                )}
              </span>
            );
          })}
        </div>
      )}
      {waiting ? (
        thinking ? (
          <div
            className="extreme-core-reply-wait extreme-core-turn-stage"
            role="status"
            data-testid="extreme-thinking"
          >
            <ReplyLoader label={t("思考中")} />
          </div>
        ) : null
      ) : (
        <div
          id={`extreme-message-${message.id}`}
          className={cn(
            "extreme-core-message min-w-0",
            mine ? "extreme-core-message-user" : message.local ? "extreme-core-message-notice" : "extreme-core-message-reply",
          )}
        >
          {mine ? (
            message.text
          ) : inlineSteps && timeline ? (
            <TurnTimeline
              messageId={message.id}
              parts={timeline}
              streaming={streaming}
              stepTask={stepTask}
              approvalByStep={approvalByStep}
              sessionId={sessionId}
              onOpen={onOpenWorkspaceTarget}
              onDecideApproval={onDecideApproval}
              onOpenOutput={stepTask && onOpenOutput ? () => onOpenOutput(stepTask.id) : undefined}
              onOpenChanges={onOpenChanges}
            />
          ) : (
            <MarkdownBody
              content={message.text}
              streaming={streaming}
              sessionId={sessionId}
              onOpen={onOpenWorkspaceTarget}
            />
          )}
        </div>
      )}
      {/*
       * 回复中断：正文保留在上面，这里只补一行**状态与重试入口**。
       *
       * 用户可能已经看完一大半内容，把气泡删掉等于"回答凭空消失"；切走再
       * 回来这一行也还在（它写在消息上，不是临时状态）。
       */}
      {!mine && message.interrupted && (
        <div
          data-testid="extreme-message-interrupted"
          data-interrupted={message.interrupted}
          className="flex max-w-[78%] flex-wrap items-center gap-2 rounded-md border border-warning/40 bg-warning/10 px-2 py-1 text-11 text-warning"
        >
          <span className="min-w-0">
            {message.interrupted === "cancelled" ? t("已停止") : t("回复中断")}
            {message.interruptReason ? `：${message.interruptReason}` : ""}
          </span>
          {message.interrupted !== "cancelled" && onRetryMessage && (
            <button
              type="button"
              className="shrink-0 underline underline-offset-2 hover:text-fg"
              onClick={() => onRetryMessage(message)}
            >
              {t("重试")}
            </button>
          )}
        </div>
      )}
      {/* 自己那句没送到后端：正文还在，旁边给出重发入口（不静默丢弃）。 */}
      {mine && message.deliveryError && (
        <div
          data-testid="extreme-message-undelivered"
          className="flex max-w-[78%] flex-wrap items-center gap-2 rounded-md border border-danger/40 bg-danger/10 px-2 py-1 text-11 text-danger"
        >
          <span className="min-w-0">
            {t("没有送达")}：{message.deliveryError}
          </span>
          {onResendMessage && (
            <button
              type="button"
              className="shrink-0 underline underline-offset-2 hover:text-fg"
              onClick={() => onResendMessage(message)}
            >
              {t("重发")}
            </button>
          )}
        </div>
      )}
      {/* 署名与操作同一行：自己的靠右（操作在左），模型靠左（操作在右）。 */}
      {!waiting && (author || time || canAct) && <div className={cn("extreme-core-message-meta flex items-center gap-1", mine && "flex-row-reverse")}>
        {author && (
          <span className="px-1 text-10" style={{ color: EC.fgSubtle }}>{author}</span>
        )}
        {/* 消息时间：旧记录没有 createdAt 时整段不出现，不拿"现在"冒充。 */}
        {time && (
          <span className="text-10" style={{ color: EC.fgSubtle }}>
            {time}
          </span>
        )}
        {canAct && (
          <div className="extreme-core-actions flex items-center gap-0.5">
            <ExtremeIconButton
              label={t("复制")}
              icon={Copy}
              onClick={() => void copyTextWithFeedback(message.text)}
            />
            {mine ? (
              <ExtremeIconButton
                label={t("编辑")}
                icon={Pencil}
                onClick={() => onEdit?.(message)}
              />
            ) : message.local ? null : (
              <ExtremeIconButton
                label={t("引用")}
                icon={Quote}
                onClick={() => onQuote?.(message)}
              />
            )}
          </div>
        )}
      </div>}
      {task && (
        isAgentActivity(task)
          ? (
            /*
             * 有内联顺序时步骤已经画在正文之间：这里只保留产物、执行结果与
             * 「查看实际变更 / 继续执行」这些入口，不再重复一份步骤列表。
             */
            <MemoAgentActivity
              task={task}
              /*
               * 有内联步骤 = 步骤已经画在正文之间，不再重复整块折叠卡。
               * 正在等第一句话（还没有步骤）时也只留产物 / 执行结果这类
               * 入口，不用「正在分析请求」再抢一个阶段提示。
               */
              hideSteps={inlineSteps || (streaming && task.steps.length === 0)}
              onPreview={onPreview}
              onOpenTarget={onOpenWorkspaceTarget}
              onResume={onResumeTask}
              onOpenChanges={onOpenChanges}
            />
          )
          : (
            <div className="w-full max-w-[560px]">
              <MemoTaskCardView task={task} onPreview={onPreview} onResume={onResumeTask} />
            </div>
          )
      )}
      {isLast && !mine && !message.local && message.createdAt ? (
        <ElapsedTime
          startedAt={message.createdAt}
          running={streaming}
          executedSteps={
            (stepTask ?? task)?.steps.filter(
              (step) => step.category !== "internal" && step.category !== "denied",
            ).length ?? 0
          }
        />
      ) : null}
    </div>
  );
});

/**
 * 对话气泡列表。
 *
 * * **用户消息**是纯文本 —— 用户写什么就显示什么，不做 Markdown 解释；
 * * **模型回复**走 `XMarkdown`，已定稿的块与还在长的尾巴分开渲染
 *   （见 `stream-markdown.ts`），长回复不会整篇重排。
 *
 * 排版样式在 `extreme-core.css` 的 `.extreme-core-markdown` 里，全部用
 * `--fg` / `--surface-*` / `--line` 这些 token，深浅主题都对。
 */
export const MessageList = memo(function MessageList({
  messages,
  asking,
  tasks = {},
  attachments = [],
  approvals,
  onPreview,
  sessionId,
  onOpenWorkspaceTarget,
  onResumeTask,
  onOpenChanges,
  onDecideApproval,
  onOpenOutput,
  onQuote,
  onEdit,
  onRetryMessage,
  onResendMessage,
}: {
  messages: ExtremeMessage[];
  asking: boolean;
  /** 会话里的附件：按 `message.attachmentIds` 解析成气泡上的文件条。 */
  attachments?: ExtremeAttachment[];
  /** 按 taskId 索引的任务卡：挂在发起它的那条消息下面。 */
  tasks?: Record<string, TaskCardModel>;
  /** 挂起中的审批：贴在对应步骤上，不再单独占一条确认栏。 */
  approvals?: Record<string, ApprovalEntry>;
  onPreview?: (artifact: TaskArtifact, sessionId: string) => void;
  sessionId?: string;
  onOpenWorkspaceTarget?: OpenTarget;
  /** 从检查点恢复中断 / 失败的任务。 */
  onResumeTask?: (task: TaskCardModel) => void;
  /** 「查看实际变更」：在右栏打开这次运行的文件变更。 */
  onOpenChanges?: (task: TaskCardModel) => void;
  /** 审批表态（允许 / 拒绝）：原地更新同一步骤的状态。 */
  onDecideApproval?: (allow: boolean, callId: string, taskId: string) => void;
  /** 展开的命令：在右侧终端查看。 */
  onOpenOutput?: (taskId: string) => void;
  /** 引用这条回复：把原文带进输入框，接着问。 */
  onQuote?: (message: ExtremeMessage) => void;
  /** 编辑自己发过的那句：把原文回填输入框重写。 */
  onEdit?: (message: ExtremeMessage) => void;
  /** 回复中断：用原问题重新跑一次。 */
  onRetryMessage?: (message: ExtremeMessage) => void;
  /** 用户消息没送达：把原文放回输入框。 */
  onResendMessage?: (message: ExtremeMessage) => void;
}) {
  const attachmentById = useMemo(
    () => new Map(attachments.map((item) => [item.id, item])),
    [attachments],
  );
  /**
   * 审批按**步骤**索引。
   *
   * 同一步骤可能留着一条已拒绝的旧记录、又挂起一条新的：未关闭的优先。
   */
  const approvalByStep = useMemo(() => {
    const map = new Map<string, ApprovalEntry>();
    for (const entry of Object.values(approvals ?? {})) {
      const key = `${entry.approval.taskId}:${entry.approval.stepIndex}`;
      const known = map.get(key);
      if (!known || (known.closed && !entry.closed)) map.set(key, entry);
    }
    return map;
  }, [approvals]);
  /*
   * 父组件的回调有的是 `useCallback`，有的依赖草稿（每敲一个字就换一份）。
   * 这里统一转成稳定引用，否则 `MessageRow` 的 memo 永远命中不了。
   */
  const handlers = useRef({
    onPreview,
    onOpenWorkspaceTarget,
    onResumeTask,
    onOpenChanges,
    onDecideApproval,
    onOpenOutput,
    onQuote,
    onEdit,
    onRetryMessage,
    onResendMessage,
  });
  handlers.current = {
    onPreview,
    onOpenWorkspaceTarget,
    onResumeTask,
    onOpenChanges,
    onDecideApproval,
    onOpenOutput,
    onQuote,
    onEdit,
    onRetryMessage,
    onResendMessage,
  };
  const preview = useCallback(
    (artifact: TaskArtifact, id: string) => handlers.current.onPreview?.(artifact, id),
    [],
  );
  const openTarget = useCallback(
    (target: WorkspaceTarget) => handlers.current.onOpenWorkspaceTarget?.(target),
    [],
  );
  const resumeTask = useCallback(
    (task: TaskCardModel) => handlers.current.onResumeTask?.(task),
    [],
  );
  const openChanges = useCallback(
    (task: TaskCardModel) => handlers.current.onOpenChanges?.(task),
    [],
  );
  const decideApproval = useCallback(
    (entry: ApprovalEntry, allow: boolean) =>
      handlers.current.onDecideApproval?.(
        allow,
        entry.approval.callId,
        entry.approval.taskId,
      ),
    [],
  );
  const openOutput = useCallback((taskId: string) => handlers.current.onOpenOutput?.(taskId), []);
  const quote = useCallback((message: ExtremeMessage) => handlers.current.onQuote?.(message), []);
  const edit = useCallback((message: ExtremeMessage) => handlers.current.onEdit?.(message), []);
  const retry = useCallback(
    (message: ExtremeMessage) => handlers.current.onRetryMessage?.(message),
    [],
  );
  const resend = useCallback(
    (message: ExtremeMessage) => handlers.current.onResendMessage?.(message),
    [],
  );

  const linked = new Set(messages.map((message) => message.taskId).filter(Boolean) as string[]);
  /**
   * 任务归属哪条消息。
   *
   * 优先**这一轮的 assistant 回复**（正文与步骤顺序都记在它身上，任务卡因此
   * 跟在命令后面，而不是跑到用户提问下面）；没有 assistant 引用的旧记录才
   * 退回第一条带 taskId 的消息。同一 taskId 的多条 assistant 取最后一条
   * （续跑 / 平台动作会接着写一条新的回复）。
   */
  const owner = new Map<string, string>();
  for (const message of messages) {
    if (!message.taskId) continue;
    const current = owner.get(message.taskId);
    if (!current || message.role === "assistant") owner.set(message.taskId, message.id);
  }
  /** 没有对应消息的任务（例如直接由按钮发起）统一排在对话末尾。 */
  const orphans = Object.values(tasks).filter((task) => !linked.has(task.id));

  return (
    <>
      <div className="extreme-core-messages">
        {messages.map((message, index) => {
          const mine = message.role === "user";
          const task = message.taskId && owner.get(message.taskId) === message.id
            ? tasks[message.taskId]
            : undefined;
          /*
           * 步骤行只认**这条消息片段里的 taskId**：旧记录的任务卡挂在用户消息
           * 上，回复上的命令仍要能读到状态。按单个任务卡传入而不是整个 tasks
           * 对象，纯文字的历史气泡在别的任务刷新时仍可被 memo 跳过。
           */
          const stepTaskId = message.parts?.find((part) => part.kind === "step")?.taskId;
          const stepTask = stepTaskId ? tasks[stepTaskId] : undefined;
          /*
           * 只有"最后一条 + 正在等回复"才是流式；历史消息一次性渲染。
           * 本机生成的提示（`local`）推送时就是全文，不能按流式逐字补间 ——
           * 否则平台刚写的一条说明只会显示前几个字。
           */
          const streaming =
            !mine && !message.local && asking && index === messages.length - 1;
          return (
            <MessageRow
              key={message.id}
              message={message}
              attachmentById={attachmentById}
              streaming={streaming}
              isLast={index === messages.length - 1}
              task={task}
              stepTask={stepTask}
              approvalByStep={approvalByStep}
              sessionId={sessionId}
              onPreview={preview}
              onOpenWorkspaceTarget={openTarget}
              onResumeTask={resumeTask}
              onOpenChanges={openChanges}
              onDecideApproval={decideApproval}
              onOpenOutput={onOpenOutput ? openOutput : undefined}
              onQuote={quote}
              onEdit={edit}
              onRetryMessage={retry}
              onResendMessage={resend}
            />
          );
        })}
        {orphans.map((task) => isAgentActivity(task) ? (
          <MemoAgentActivity
            key={task.id}
            task={task}
            onPreview={preview}
            onOpenTarget={openTarget}
            onResume={resumeTask}
            onOpenChanges={openChanges}
          />
        ) : (
          <div key={task.id} className="max-w-[560px]">
            <MemoTaskCardView
              task={task}
              onPreview={preview}
              onResume={resumeTask}
            />
          </div>
        ))}
      </div>
    </>
  );
});
