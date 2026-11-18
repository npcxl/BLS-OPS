import { Actions } from "@ant-design/x";
import type { ActionsProps } from "@ant-design/x";
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
import { cn } from "@/lib/cn";
import { copyTextWithFeedback } from "@/lib/clipboard-feedback";
import { formatSize } from "@/lib/format";
import type { ExtremeAttachment, ExtremeMessage } from "@/stores/extreme-store";
import { AgentActivity, isAgentActivity } from "./AgentActivity";
import { chatTime } from "./format-time";
import { splitStreamingMarkdown } from "./stream-markdown";
import { EC } from "./theme";
import { TaskCardView } from "./TaskCardView";
import type { TaskArtifact, TaskCardModel } from "./task-view";
import type { WorkspaceTarget } from "./RemoteWorkspacePanel";

/**
 * **已定稿**的那半段 Markdown。
 *
 * 流式正文以空行 / 闭合代码块为界切成两半：前面交给它（只在越过边界时重解析
 * 一次），后面那截还在长的按纯文本显示。这样一条 20 KB 的回复不会再每来一个
 * 字就整篇重排一遍。
 */
const StableMarkdown = memo(function StableMarkdown({
  content,
  sessionId,
  onOpen,
}: {
  content: string;
  sessionId?: string;
  onOpen?: (target: WorkspaceTarget) => void;
}) {
  return (
    <XMarkdown
      className="extreme-core-markdown"
      content={content}
      streaming={false}
      components={workspaceComponents}
      componentsProps={{
        a: { sessionId, onOpen },
        code: { sessionId, onOpen },
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
  onOpen?: (target: WorkspaceTarget) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
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
    const { stable, tail } = splitStreamingMarkdown(content);
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

function workspaceTarget(value: string, sessionId: string): WorkspaceTarget | null {
  if (/^\/(?!\/)[^\u0000-\u001f]+$/.test(value) && !value.split("/").includes("..")) {
    return { kind: "directory", path: value, sessionId };
  }
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
  onOpen?: (target: WorkspaceTarget) => void;
};

function WorkspaceLink({ href, children, sessionId, onOpen }: LinkProps) {
  const target = href && sessionId ? workspaceTarget(href, sessionId) : null;
  return target && onOpen
    ? <a href={href} onClick={(event) => { event.preventDefault(); onOpen(target); }}>{children}</a>
    : <span>{children}</span>;
}

function LinkedCode({ children, block, className, sessionId, onOpen }: LinkProps) {
  const target = !block && typeof children === "string" && sessionId
    ? workspaceTarget(children, sessionId)
    : null;
  return (
    <code className={className}>
      {target && onOpen ? (
        <a href={children as string} onClick={(event) => { event.preventDefault(); onOpen(target); }}>{children}</a>
      ) : children}
    </code>
  );
}

function ReplyCodeBlock({ children }: { children?: ReactNode }) {
  const { t } = useTranslation();
  const codeRef = useRef<HTMLPreElement>(null);

  return (
    <div className="extreme-core-reply-code">
      <button
        type="button"
        className="extreme-core-reply-copy"
        title={t("复制代码")}
        aria-label={t("复制代码")}
        onClick={() => {
          const text = codeRef.current?.textContent;
          if (text) void copyTextWithFeedback(text);
        }}
      >
        <Copy size={14} />
      </button>
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
  task,
  sessionId,
  onPreview,
  onOpenWorkspaceTarget,
  onQuote,
  onEdit,
}: {
  message: ExtremeMessage;
  attachmentById: Map<string, ExtremeAttachment>;
  streaming: boolean;
  task?: TaskCardModel;
  sessionId?: string;
  onPreview?: (artifact: TaskArtifact, sessionId: string) => void;
  onOpenWorkspaceTarget?: (target: WorkspaceTarget) => void;
  onQuote?: (message: ExtremeMessage) => void;
  onEdit?: (message: ExtremeMessage) => void;
}) {
  const { t } = useTranslation();
  const mine = message.role === "user";
  // 还没有任何正文：给一个轻量占位，避免气泡突然出现又跳高度。
  const waiting = !mine && message.text === "";
  /*
   * 气泡下的操作条：照 antd X `Bubble` footer 的做法，用 `Actions`。
   *
   * 模型的回复可以「复制 / 引用」，自己发的可以「复制 / 编辑」；占位气泡
   * 还没有正文，不给按钮。复制走项目的剪贴板插件（WebView 的
   * `navigator.clipboard` 会弹系统授权），失败会有一条提示，不会假装成功。
   */
  const canAct = !waiting && !streaming && message.text.trim().length > 0;
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
      }));
  }, [message.attachmentSnapshot, message.attachmentIds, attachmentById]);
  const copyItem = {
    key: "copy",
    label: t("复制"),
    icon: <Copy size={13} />,
    onItemClick: () => void copyTextWithFeedback(message.text),
  };
  const actions: ActionsProps["items"] = mine
    ? [
        copyItem,
        {
          key: "edit",
          label: t("编辑"),
          icon: <Pencil size={13} />,
          onItemClick: () => onEdit?.(message),
        },
      ]
    : [
        copyItem,
        /*
         * 本机提示（"已生成 3 个步骤…"）也是 assistant，但它不是模型
         * 的回复：只能复制，没有可供追问的原文。
         */
        ...(message.local
          ? []
          : [
              {
                key: "quote",
                label: t("引用"),
                icon: <Quote size={13} />,
                onItemClick: () => onQuote?.(message),
              },
            ]),
      ];

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
              </span>
            );
          })}
        </div>
      )}
      {waiting ? (
        <div className="extreme-core-reply-wait" role="status">
          <span aria-hidden="true" />
          {t("正在回答…")}
        </div>
      ) : (
        <div
          className={cn(
            "extreme-core-message min-w-0",
            mine ? "extreme-core-message-user" : message.local ? "extreme-core-message-notice" : "extreme-core-message-reply",
          )}
          style={
            mine
              ? { background: EC.accent, color: "#ffffff" }
                : undefined
          }
        >
          {mine ? (
            message.text
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
      {/* 署名与操作同一行：自己的靠右（操作在左），模型靠左（操作在右）。 */}
      {!waiting && <div className={cn("extreme-core-message-meta flex items-center gap-1", mine && "flex-row-reverse")}>
        <span className="px-1 text-10" style={{ color: EC.fgSubtle }}>
          {mine
            ? t("你")
            : message.model
              ? `${t("模型")}：${message.model}`
              : t("本机提示")}
        </span>
        {/* 消息时间：旧记录没有 createdAt 时整段不出现，不拿"现在"冒充。 */}
        {chatTime(message.createdAt, t) && (
          <span className="text-10" style={{ color: EC.fgSubtle }}>
            {chatTime(message.createdAt, t)}
          </span>
        )}
        {canAct && <Actions className="extreme-core-actions" items={actions} />}
      </div>}
      {task && (
        isAgentActivity(task)
          ? <MemoAgentActivity task={task} onPreview={onPreview} onOpenTarget={onOpenWorkspaceTarget} />
          : <div className="w-full max-w-[560px]"><MemoTaskCardView task={task} onPreview={onPreview} /></div>
      )}
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
  onPreview,
  sessionId,
  onOpenWorkspaceTarget,
  onQuote,
  onEdit,
}: {
  messages: ExtremeMessage[];
  asking: boolean;
  /** 会话里的附件：按 `message.attachmentIds` 解析成气泡上的文件条。 */
  attachments?: ExtremeAttachment[];
  /** 按 taskId 索引的任务卡：挂在发起它的那条消息下面。 */
  tasks?: Record<string, TaskCardModel>;
  onPreview?: (artifact: TaskArtifact, sessionId: string) => void;
  sessionId?: string;
  onOpenWorkspaceTarget?: (target: WorkspaceTarget) => void;
  /** 引用这条回复：把原文带进输入框，接着问。 */
  onQuote?: (message: ExtremeMessage) => void;
  /** 编辑自己发过的那句：把原文回填输入框重写。 */
  onEdit?: (message: ExtremeMessage) => void;
}) {
  const { t } = useTranslation();
  const attachmentById = useMemo(
    () => new Map(attachments.map((item) => [item.id, item])),
    [attachments],
  );
  /*
   * 父组件的回调有的是 `useCallback`，有的依赖草稿（每敲一个字就换一份）。
   * 这里统一转成稳定引用，否则 `MessageRow` 的 memo 永远命中不了。
   */
  const handlers = useRef({ onPreview, onOpenWorkspaceTarget, onQuote, onEdit });
  handlers.current = { onPreview, onOpenWorkspaceTarget, onQuote, onEdit };
  const preview = useCallback(
    (artifact: TaskArtifact, id: string) => handlers.current.onPreview?.(artifact, id),
    [],
  );
  const openTarget = useCallback(
    (target: WorkspaceTarget) => handlers.current.onOpenWorkspaceTarget?.(target),
    [],
  );
  const quote = useCallback((message: ExtremeMessage) => handlers.current.onQuote?.(message), []);
  const edit = useCallback((message: ExtremeMessage) => handlers.current.onEdit?.(message), []);

  const linked = new Set(messages.map((message) => message.taskId).filter(Boolean) as string[]);
  /**
   * 每个任务只归属**第一条**带它的消息。
   *
   * 任务被复用（「开始吧」/「重新检查」）时可能有多条消息指向同一个 taskId，
   * 逐条渲染就会看到两张一模一样的卡片。
   */
  const owner = new Map<string, string>();
  for (const message of messages) {
    if (message.taskId && !owner.has(message.taskId)) owner.set(message.taskId, message.id);
  }
  /** 没有对应消息的任务（例如直接由按钮发起）统一排在对话末尾。 */
  const orphans = Object.values(tasks).filter((task) => !linked.has(task.id));

  return (
    <>
      <div className="extreme-core-messages">
        {messages.map((message, index) => {
          const mine = message.role === "user";
          const previousTaskId = messages[index - 1]?.taskId;
          const previousTask = previousTaskId ? tasks[previousTaskId] : undefined;
          // 还没吐字的占位：紧跟在一张"正在跑"的卡片后面时不必占位。
          if (!mine && message.text === "" && previousTask && isAgentActivity(previousTask)) {
            return null;
          }
          const task = message.taskId && owner.get(message.taskId) === message.id
            ? tasks[message.taskId]
            : undefined;
          // 只有"最后一条 + 正在等回复"才是流式；历史消息一次性渲染。
          const streaming = !mine && asking && index === messages.length - 1;
          return (
            <MessageRow
              key={message.id}
              message={message}
              attachmentById={attachmentById}
              streaming={streaming}
              task={task}
              sessionId={sessionId}
              onPreview={preview}
              onOpenWorkspaceTarget={openTarget}
              onQuote={quote}
              onEdit={edit}
            />
          );
        })}
        {orphans.map((task) => isAgentActivity(task) ? (
          <MemoAgentActivity key={task.id} task={task} onPreview={preview} onOpenTarget={openTarget} />
        ) : (
          <div key={task.id} className="max-w-[560px]">
            <MemoTaskCardView
              task={task}
              onPreview={preview}
            />
          </div>
        ))}
      </div>
      {asking && messages.every((message) => message.role === "user" && !message.taskId) && (
        <div className="px-1 py-1 text-11" style={{ color: EC.fgSubtle }}>
          {t("正在回答…")}
        </div>
      )}
    </>
  );
});
