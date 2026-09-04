/**
 * 终端智能补全的统一契约。
 *
 * 以前 `TerminalSuggest` 里堆着一层层 `if/else`（是不是 cd？是不是 docker？），
 * 每加一种补全就要改渲染层。这里改成**提供器注册制**：
 *
 * ```text
 * 输入行 + 光标位置
 *   → parseLine()（切 token，尊重引号）
 *   → 每个 Provider.matches(parsed) 决定"这一种补全归我管吗"
 *   → 命中的 Provider 产出统一 CompletionItem
 *   → 渲染层只认 CompletionItem
 * ```
 *
 * 关键约束：
 * - **按光标所在的参数位**决定 Provider，而不是只看整行结尾；
 * - `insertText` 必须是**可以直接写进 shell 的文本**（已转义/加引号），
 *   原始用户路径绝不拼接进命令；
 * - `replaceRange` 是相对**整行**的替换范围，由渲染层换算成按键序列。
 */

import type { CommandSearchHit } from "@/api/ops-api";
import type {
  NginxContainer,
  NginxEnvironment,
  SuggestedCommand,
} from "@/api/types/environment";

/** 补全来源（也是 Provider 的 id）。 */
export type CompletionSource =
  | "environment"
  | "docker"
  | "service"
  | "process"
  | "remote-directory"
  | "file"
  | "knowledge";

/** 候选项的语义类型（决定图标与后续处理）。 */
export type CompletionItemType =
  | "command"
  | "directory"
  | "file"
  | "container"
  | "image"
  | "network"
  | "volume"
  | "service"
  | "process";

export type CompletionIcon = CompletionItemType;

/** 一个统一候选。 */
export interface CompletionItem {
  /** 展示名。 */
  label: string;
  /** 写入 shell 的文本（已转义）。 */
  insertText: string;
  /** 右侧说明（相对路径、镜像、状态…）。 */
  detail: string;
  icon: CompletionIcon;
  type: CompletionItemType;
  /** 相对整行的替换范围：`[start, end)`。 */
  replaceRange: { start: number; end: number };
  /** 排序优先级，大者在前。 */
  priority: number;
  source: CompletionSource;
  /** 已输入部分的高亮范围（相对 `label`）。 */
  highlight?: { start: number; length: number };
  /** 知识库候选：走占位符 / 二级参数选择流程。 */
  hit?: CommandSearchHit;
  /** 环境生成的真实命令（风险等级来自后端）。 */
  command?: SuggestedCommand;
  /** 需要用户选择的容器（多容器环境）。 */
  container?: NginxContainer;
  /** 该候选只是提示，不可选中（如"没有匹配"）。 */
  disabled?: boolean;
}

/** 一个 token（切分时保留引号信息）。 */
export interface LineToken {
  /** 原文（含引号）。 */
  raw: string;
  /** 去引号、去转义后的值。 */
  value: string;
  start: number;
  end: number;
}

/** 解析后的命令行 + 光标位置。 */
export interface ParsedLine {
  command: string;
  tokens: LineToken[];
  /** 光标所在 token 的下标；光标在空白之后时等于 `tokens.length`（新 token）。 */
  index: number;
  /** 光标所在 token（新 token 时为 null）。 */
  token: LineToken | null;
  /** 光标所在 token 从开头到光标的**原文**片段。 */
  prefix: string;
}

/** 补全上下文（Provider 唯一输入）。 */
export interface CompletionContext {
  line: string;
  cursor: number;
  sessionId: string;
  /** 当前远程目录（来自 cwd 追踪器）；未知时为 null。 */
  cwd: string | null;
  /** 远程家目录；未知时为 null。 */
  home: string | null;
  /** 服务器运行环境（Nginx 探测结果）；未探测时为 null。 */
  environment?: NginxEnvironment | null;
  signal?: AbortSignal;
}

/** Provider 的返回。 */
export interface CompletionResult {
  items: CompletionItem[];
  /** 面板底部说明（如"没有匹配的远程目录"）。 */
  notice?: string;
  /**
   * 本次请求的标识（一般是"补全什么"的摘要）。调度器用它丢弃过期响应 ——
   * 快速输入时旧请求不会覆盖新结果。
   */
  requestKey: string;
}

export interface CompletionProvider {
  id: CompletionSource;
  /** 是否接管这个"命令 + 参数位"。 */
  matches(parsed: ParsedLine): boolean;
  complete(ctx: CompletionContext, parsed: ParsedLine): Promise<CompletionResult>;
}
