import { useEffect, useMemo, useRef, useState } from "react";
import { resolveCompletions } from "./completion/registry";
import type { CompletionContext, CompletionItem } from "./completion/types";
import { parseLine } from "./completion/path-input";
import { COMMAND_NAMES, commandMatchScore } from "./completion/providers/command";
import type { NginxEnvironment } from "@/api/types/environment";

/**
 * 弧形输入栏的补全数据源。
 *
 * **本地优先，远程补位**（2026-11-13 用户裁决）：
 * - 命令名（内置表）与当前服务器历史是**纯内存**计算，输入那一刻就能显示，
 *   不再跟远程一起等 60ms 防抖 —— `doc` 必须立刻看到 `docker`；
 * - 目录、服务、容器这些要走 IPC 的候选异步补进来，按快照校验后才合并。
 *
 * 候选与"哪台服务器 + 哪段输入 + 哪个光标"强绑定：改字、移光标、切服务器后
 * 远程结果立即失效（回退到本地候选），Tab 不会把过期内容填进新输入。
 */

/** 候选在界面上的来源补充：历史命令。 */
export interface ComposerItem extends CompletionItem {
  fromHistory?: boolean;
}

/** 生成一批候选时的输入快照；消费方必须先比对再用。 */
export interface ComposerSnapshot {
  text: string;
  caret: number;
  sessionId: string;
}

export interface ComposerCompletionInput {
  sessionId: string;
  text: string;
  caret: number;
  enabled: boolean;
  cwd: string | null;
  home: string | null;
  environment?: NginxEnvironment | null;
  /** **当前服务器**的历史命令，新的在前。 */
  history: string[];
}

/** 远程补全的防抖：本地候选已经先显示了，这里只影响目录/服务/容器。 */
const REMOTE_DEBOUNCE_MS = 40;
const MAX_HISTORY_ITEMS = 5;
const MAX_LOCAL_COMMANDS = 8;

/** 按 `source + label` 去重，先出现的（远程上下文）优先。 */
export function mergeUnique(primary: ComposerItem[], extra: ComposerItem[]): ComposerItem[] {
  const seen = new Set(primary.map((item) => `${item.source}:${item.label}`));
  const merged = [...primary];
  for (const item of extra) {
    const key = `${item.source}:${item.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return merged;
}

/**
 * 使用统计：按**命令 + 子命令**分别计数，而不是都算到首词头上。
 *
 * 每条历史记录会同时给它的 1~2 个词前缀各记一次：
 * `docker logs nginx` → `docker` +1、`docker logs` +1。
 * 这样 `docker logs` 和 `docker ps` 是两条独立记录 —— 前者常用了，
 * `docker ` 之后的 `logs` 会排到前面，而 `ps` 不会跟着被抬高。
 */
export function usageStats(history: string[]): {
  counts: Map<string, number>;
  /** 越小越近（历史数组是新的在前）。 */
  recency: Map<string, number>;
} {
  const counts = new Map<string, number>();
  const recency = new Map<string, number>();
  history.forEach((command, index) => {
    const tokens = command.trim().split(/\s+/).slice(0, 2);
    for (let n = 1; n <= tokens.length; n += 1) {
      const key = tokens.slice(0, n).join(" ").toLowerCase();
      if (!key) continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      if (!recency.has(key)) recency.set(key, index);
    }
  });
  return { counts, recency };
}

/**
 * 候选排序：**上下文优先，使用习惯加权**。
 *
 * 1. `priority` 高者在前（提供器已经按输入匹配度 / 参数位置排过）；
 * 2. 同优先级里按**使用次数**（×10）加**最近使用**（越近分越高）排序；
 * 3. 都没用过 → 保持命令库默认顺序（`sort` 是稳定的，返回 0 即可）。
 */
export function rankByUsage(
  items: ComposerItem[],
  history: string[],
  command: string | null,
): ComposerItem[] {
  if (history.length === 0) return items;
  const { counts, recency } = usageStats(history);
  const keyOf = (item: ComposerItem): string => {
    // 子命令（`docker ` 之后的 logs）用「命令 + 子命令」作为键。
    const isSubcommand =
      command !== null &&
      item.source === "command" &&
      !item.fromHistory &&
      item.label.toLowerCase() !== command.toLowerCase();
    return (isSubcommand ? `${command} ${item.label}` : item.label).toLowerCase();
  };
  const weight = (item: ComposerItem): number => {
    const key = keyOf(item);
    const used = (counts.get(key) ?? 0) * 10;
    const recent = recency.has(key) ? Math.max(0, 100 - (recency.get(key) ?? 0)) : 0;
    return used + recent;
  };
  return [...items].sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    const diff = weight(b) - weight(a);
    return diff !== 0 ? diff : 0;
  });
}

/**
 * 用历史给命令名候选加权：越近执行过的越靠前。
 *
 * 只调整**已经命中上下文**的候选顺序，不凭空造候选。
 */
export function rankByHistory(items: ComposerItem[], history: string[]): ComposerItem[] {
  if (history.length === 0) return items;
  const recency = new Map<string, number>();
  history.forEach((command, index) => {
    const head = command.trim().split(/\s+/)[0];
    if (!head) return;
    if (!recency.has(head)) recency.set(head, history.length - index);
  });
  return [...items].sort((a, b) => {
    const scoreA = a.priority + (recency.get(a.label) ?? 0);
    const scoreB = b.priority + (recency.get(b.label) ?? 0);
    return scoreB - scoreA;
  });
}

/**
 * **同步**的命令名候选：直接用内置命令表匹配当前词。
 *
 * 这是"输入即出首选"的关键：不发 IPC、不等防抖，`doc` 的这次渲染里就有
 * `docker`。只接管命令词位置（带 `/` 的是路径，交给远程目录提供器）。
 */
export function localCommandItems(text: string, caret: number): ComposerItem[] {
  const parsed = parseLine(text, caret);
  if (parsed.index !== 0) return [];
  const head = parsed.prefix.trim();
  if (!head || head.includes("/")) return [];

  const start = parsed.token?.start ?? 0;
  const end = parsed.token?.end ?? text.length;
  return COMMAND_NAMES.map((command) => ({
    command,
    score: commandMatchScore(head, command.name),
  }))
    .filter((entry): entry is { command: (typeof COMMAND_NAMES)[number]; score: number } => entry.score !== null)
    .sort((a, b) => a.score - b.score || a.command.name.length - b.command.name.length)
    .slice(0, MAX_LOCAL_COMMANDS)
    .map(({ command }) => ({
      label: command.name,
      insertText: `${command.name} `,
      detail: command.about,
      icon: "command" as const,
      type: "command" as const,
      replaceRange: { start, end },
      priority: 1,
      source: "command" as const,
    }));
}

/**
 * 常见命令的**一级子命令**（纯本地表，`docker ` 立刻就能出 ps / logs / exec）。
 *
 * 这些是高频且稳定的子命令，没必要为了它们等一次知识库请求；表里没有的
 * 命令仍然交给远程 provider（`docker logs ` 的容器名之类也要靠它）。
 */
const SUBCOMMANDS: Record<string, { name: string; about: string }[]> = {
  docker: [
    { name: "ps", about: "列出容器" },
    { name: "logs", about: "查看容器日志" },
    { name: "exec", about: "在容器里执行命令" },
    { name: "run", about: "运行新容器" },
    { name: "images", about: "列出镜像" },
    { name: "pull", about: "拉取镜像" },
    { name: "rm", about: "删除容器" },
    { name: "restart", about: "重启容器" },
    { name: "compose", about: "Compose 编排" },
  ],
  "docker-compose": [
    { name: "up", about: "启动服务" },
    { name: "down", about: "停止并移除" },
    { name: "ps", about: "列出服务状态" },
    { name: "logs", about: "查看服务日志" },
    { name: "restart", about: "重启服务" },
  ],
  systemctl: [
    { name: "status", about: "查看服务状态" },
    { name: "start", about: "启动服务" },
    { name: "stop", about: "停止服务" },
    { name: "restart", about: "重启服务" },
    { name: "reload", about: "重载配置" },
    { name: "enable", about: "开机自启" },
    { name: "disable", about: "取消自启" },
    { name: "list-units", about: "列出单元" },
  ],
  journalctl: [
    { name: "-u", about: "指定服务单元" },
    { name: "-f", about: "持续跟随" },
    { name: "-n", about: "最近 N 行" },
    { name: "--since", about: "起始时间" },
  ],
  git: [
    { name: "status", about: "工作区状态" },
    { name: "log", about: "提交历史" },
    { name: "diff", about: "查看差异" },
    { name: "pull", about: "拉取" },
    { name: "push", about: "推送" },
    { name: "commit", about: "提交" },
    { name: "add", about: "暂存" },
    { name: "checkout", about: "切换分支" },
  ],
  kubectl: [
    { name: "get", about: "查询资源" },
    { name: "describe", about: "查看详情" },
    { name: "logs", about: "查看日志" },
    { name: "exec", about: "进入容器" },
    { name: "apply", about: "应用配置" },
    { name: "delete", about: "删除资源" },
  ],
  nginx: [
    { name: "-t", about: "检查配置" },
    { name: "-s", about: "发送信号" },
    { name: "-v", about: "版本" },
  ],
};

/**
 * **同步**的子命令候选：`docker ` / `docker p` 立刻出 `ps`、`logs`、`exec`。
 *
 * 只在"命令 + 第一个参数位"生效（`index === 1`），再往后是容器名/镜像名，
 * 那些必须走远程 provider。
 */
export function localSubcommandItems(text: string, caret: number): ComposerItem[] {
  const parsed = parseLine(text, caret);
  if (parsed.index !== 1 || parsed.tokens.length === 0 || parsed.tokens.length > 1) return [];
  const command = parsed.tokens[0]?.value?.trim().toLowerCase() ?? "";
  const table = SUBCOMMANDS[command];
  if (!table) return [];

  const head = parsed.prefix.trim();
  const start = parsed.token?.start ?? text.trimEnd().length + 1;
  const end = parsed.token?.end ?? text.length;
  // 空前缀（刚敲完空格）就直接把常用子命令全列出来。
  const matched = head
    ? table
        .map((entry) => ({ entry, score: commandMatchScore(head, entry.name) }))
        .filter(
          (row): row is { entry: { name: string; about: string }; score: number } =>
            row.score !== null,
        )
        .sort((a, b) => a.score - b.score || a.entry.name.length - b.entry.name.length)
        .map((row) => row.entry)
    : table;

  return matched.slice(0, MAX_LOCAL_COMMANDS).map((entry) => ({
    label: entry.name,
    insertText: `${entry.name} `,
    detail: entry.about,
    icon: "command" as const,
    type: "command" as const,
    replaceRange: { start, end },
    priority: 2,
    source: "command" as const,
  }));
}

/**
 * 从历史召回"命令库没有"的命令。
 *
 * **只在输入框整行只有一个命令词时**提供：历史是整条命令，插进参数中间
 * （`docker logs ng|inx --tail 100`）会把后面的参数一起覆盖掉。
 */
export function historyItems(text: string, caret: number, history: string[]): ComposerItem[] {
  const parsed = parseLine(text, caret);
  if (parsed.index !== 0 || parsed.tokens.length > 1) return [];
  const head = parsed.prefix.trim();
  if (!head) return [];

  const needle = head.toLowerCase();
  const seen = new Set<string>();
  const items: ComposerItem[] = [];
  for (const command of history) {
    const trimmed = command.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    const lower = trimmed.toLowerCase();
    const firstWord = lower.split(/\s+/)[0] ?? "";
    if (!lower.startsWith(needle) && !firstWord.includes(needle)) continue;
    seen.add(trimmed);
    items.push({
      label: trimmed.length > 60 ? `${trimmed.slice(0, 60)}…` : trimmed,
      insertText: trimmed,
      detail: "history",
      icon: "command",
      type: "command",
      replaceRange: {
        start: parsed.token?.start ?? 0,
        end: parsed.token?.end ?? text.length,
      },
      priority: 0,
      source: "history",
      fromHistory: true,
    });
    if (items.length >= MAX_HISTORY_ITEMS) break;
  }
  return items;
}

/** 候选是否还适用于当前输入（远程结果合并前必须过这一关）。 */
export function snapshotMatches(snapshot: ComposerSnapshot, current: ComposerSnapshot): boolean {
  return (
    snapshot.sessionId === current.sessionId &&
    snapshot.text === current.text &&
    snapshot.caret === current.caret
  );
}

export function useComposerCompletion({
  sessionId,
  text,
  caret,
  enabled,
  cwd,
  home,
  environment = null,
  history,
}: ComposerCompletionInput): {
  items: ComposerItem[];
  snapshot: ComposerSnapshot;
  /** 候选是否可用（本地候选永远对应当前输入）。 */
  usable: boolean;
  /** 远程部分是否还在算（本地候选已经在显示了）。 */
  loading: boolean;
} {
  /** 远程结果 + 它对应的输入快照。 */
  const [remote, setRemote] = useState<{ items: ComposerItem[]; snapshot: ComposerSnapshot } | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const seqRef = useRef(0);

  /** 当前命令行的首词：把子命令的使用记录挂到「命令 + 子命令」名下。 */
  const command = useMemo(
    () => parseLine(text, caret).tokens[0]?.value?.trim().toLowerCase() ?? null,
    [caret, text],
  );

  /**
   * 本地候选：**同步**计算，输入那一刻就有。
   *
   * 顺序：历史（最贴合这台机器）→ 子命令（`docker ` 立刻出 ps/logs）→ 命令名。
   */
  const immediate = useMemo(() => {
    if (!enabled) return [];
    const subcommands = rankByUsage(localSubcommandItems(text, caret), history, command);
    const commands = rankByUsage(localCommandItems(text, caret), history, command);
    return mergeUnique(historyItems(text, caret, history), [...subcommands, ...commands]);
  }, [caret, command, enabled, history, text]);

  useEffect(() => {
    if (!enabled) {
      setRemote(null);
      setLoading(false);
      return;
    }
    const seq = (seqRef.current += 1);
    const request: ComposerSnapshot = { text, caret, sessionId };
    const context: CompletionContext = {
      line: text,
      cursor: caret,
      sessionId,
      cwd,
      home,
      environment,
    };
    setLoading(true);
    const timer = window.setTimeout(() => {
      void resolveCompletions(context)
        .then((result) => {
          // 迟到的响应：用户又敲了字 / 换了服务器 → 整批丢弃。
          if (seq !== seqRef.current) return;
          setRemote({
            items: rankByUsage(
              result.items.filter((item) => !item.disabled),
              history,
              command,
            ),
            snapshot: request,
          });
          setLoading(false);
        })
        .catch(() => {
          if (seq !== seqRef.current) return;
          setRemote(null);
          setLoading(false);
        });
    }, REMOTE_DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [caret, cwd, enabled, environment, history, home, sessionId, text]);

  const current: ComposerSnapshot = { text, caret, sessionId };
  // 远程结果只在快照仍然匹配时参与合并，否则退回本地候选（绝不显示旧内容）。
  const remoteUsable = remote !== null && snapshotMatches(remote.snapshot, current);
  const items = remoteUsable ? mergeUnique(remote.items, immediate) : immediate;

  return { items, snapshot: current, usable: enabled && items.length > 0, loading };
}
