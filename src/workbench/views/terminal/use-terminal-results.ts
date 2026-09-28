import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { Terminal, type IMarker } from "@xterm/xterm";
import { opsApi } from "@/api/ops-api";
import type { SuggestedRisk } from "@/api/types/environment";
import { hasUnresolvedPlaceholder } from "@/workbench/views/command-center/complete";
import { extractTerminalSnapshot } from "./extract-terminal-snapshot";
import { planCommandSubmission, type CommandSource, type SubmitMode } from "./command-plan";
import type { CommandBoundaryParser } from "./command-boundary";
import {
  beginBlock,
  disposeBlocks,
  finishBlock,
  type CommandBlock,
} from "./terminal-command-blocks";
import {
  TerminalCommandCoordinator,
  type RenderOutcome,
} from "./TerminalCommandCoordinator";

export interface TerminalResultsHost {
  sessionId: string;
  terminalRef: RefObject<Terminal | null>;
  boundaryParserRef: RefObject<CommandBoundaryParser | null>;
  /** 参数类可见提示（如"还有未替换的参数"）—— 绝不静默失败。 */
  setParamHint: (value: string | null) => void;
}

/**
 * 终端命令的提交入口 + 命令块（悬浮复制）的状态。
 *
 * ⚠️ **结果抽屉（命令结果面板）已按用户要求移除**：终端下方不再出现结果列表，
 * 也不再累积 `CapturedResult`。但**捕获链路整体保留** —— 命令块悬浮复制
 * （鼠标悬停命令时的复制按钮）要用它的边界退出码与渲染快照。所以每个可捕获
 * 命令仍会注入受控标记、仍会跑一次知识库匹配与 JSON 检测。
 *
 * 提交链路（唯一入口 `execute`）：
 *
 * ```text
 * execute(command, source, options)
 *   → coordinator.submit(command, source, plan)   // 开始捕获 + 记边界起点
 *   → 注册 xterm 起始行 marker                     // 块起点（一次一个）
 *   → sshInput(command + 受控标记)                 // 只写一次
 *   → OSC 133 D → 渲染完成后封口命令块
 * ```
 */
export function useTerminalResults(host: TerminalResultsHost) {
  const { sessionId, terminalRef, boundaryParserRef, setParamHint } = host;
  const { t } = useTranslation();

  /**
   * 捕获命令在 xterm 缓冲里的**起始行**（提交时注册一次）。
   *
   * 命令输出滚出回滚缓冲 / 清屏时 xterm 会把 marker 置为失效（line = -1）
   * 并自动丢弃 —— 快照取不到就由协调器降级（见 consumeTerminalSnapshot），
   * 绝不在错误的行上猜起点。
   */
  const captureMarkerRef = useRef<{ marker: IMarker } | null>(null);
  const releaseCaptureMarker = useCallback(() => {
    const held = captureMarkerRef.current;
    captureMarkerRef.current = null;
    if (held) held.marker.dispose();
  }, []);

  /**
   * 从已渲染的 xterm buffer 提取命令区快照并**消费**（释放）本次的起始行
   * marker。只释放传入的那个 marker —— 异步快照期间可能有新命令提交登记了
   * 新的 marker，绝不能误放别人的。
   */
  const consumeTerminalSnapshot = useCallback(
    (held: { marker: IMarker } | null): RenderOutcome => {
      const instance = terminalRef.current;
      const line = held ? held.marker.line : -1;
      if (held) {
        if (captureMarkerRef.current === held) captureMarkerRef.current = null;
        held.marker.dispose();
      }
      // marker 失效 / 终端已销毁 → { text: null }：协调器走原始流降级。
      if (!instance || line < 0) return { text: null };
      const buffer = instance.buffer.active;
      return {
        text: extractTerminalSnapshot({
          // IBuffer.getLine 返回 undefined，纯函数以 null 为缺省值 —— 包一层。
          buffer: { length: buffer.length, getLine: (index) => buffer.getLine(index) ?? null },
          startLine: line,
        }),
      };
    },
    [terminalRef],
  );

  const coordinatorRef = useRef<TerminalCommandCoordinator | null>(null);

  /**
   * 命令块（悬浮复制）：一次提交的"命令回显 + 输出"在终端里的行范围。
   *
   * - 起点：`execute` 里注册捕获 marker 的同一行（提交时光标所在行）；
   * - 终点：`onResult` 时刻再注册一枚 marker —— OSC 133 D 已写完输出、
   *   提示符尚未回写，所以终点正好是输出最后一行；
   * - 文本 / 退出码来自 `CapturedResult.renderedText` / `boundary.exitCode`
   *   （与终端里看到的同一份渲染快照）。
   *
   * `blocksRef` 是写路径的真源（begin/finish 都发生在事件回调里，不在
   * render 期），组件侧只读 `commandBlocks`。
   */
  const [commandBlocks, setCommandBlocks] = useState<CommandBlock[]>([]);
  const blocksRef = useRef<CommandBlock[]>([]);
  blocksRef.current = commandBlocks;
  const blockIdRef = useRef(0);

  const applyBlocks = useCallback((mutation: { blocks: CommandBlock[]; evicted: CommandBlock[] }) => {
    disposeBlocks(mutation.evicted);
    blocksRef.current = mutation.blocks;
    setCommandBlocks(mutation.blocks);
  }, []);

  const clearCommandBlocks = useCallback(() => {
    applyBlocks({ blocks: [], evicted: blocksRef.current });
  }, [applyBlocks]);

  if (!coordinatorRef.current) {
    coordinatorRef.current = new TerminalCommandCoordinator({
      match: (text) => opsApi.commandMatchText(text),
      onResult: (result) => {
        // 命令块封口：此刻 D 标记后的输出已写完渲染、提示符还没回写，
        // 在当前光标行注册终点 marker 正好停在输出最后一行。
        const instance = terminalRef.current;
        const endMarker = instance?.registerMarker(0) ?? null;
        applyBlocks(
          finishBlock(blocksRef.current, result.boundary.exitCode, endMarker, result.renderedText),
        );
      },
      // 护栏兜底（受控标记始终没来）：主动向终端要一次当前快照。
      captureNow: () => consumeTerminalSnapshot(captureMarkerRef.current),
    });
  }
  useEffect(
    () => () => {
      coordinatorRef.current?.dispose();
      releaseCaptureMarker();
      clearCommandBlocks();
    },
    [clearCommandBlocks, releaseCaptureMarker],
  );

  /**
   * 补全候选的"补全并立即执行"也要按**真实风险**门控：
   * `nginx -s reload` / `docker compose restart` 是"需确认"，确认前不写 shell。
   */
  const [runConfirm, setRunConfirm] = useState<{ command: string; risk: SuggestedRisk } | null>(
    null,
  );

  /**
   * **唯一命令提交入口**（详见本文件顶部注释）。
   *
   * `options.prefix` 是需要**原样**先发出去的按键数据（用户敲的回车、建议
   * 补全的字符）—— 命令文本就是这么被"敲"进终端的，不能重复发送。
   */
  const execute = useCallback(
    (
      command: string,
      source: CommandSource,
      options?: { prefix?: string; mode?: SubmitMode },
    ) => {
      const trimmed = command.trim();
      if (!trimmed) return;
      // 未解析占位符绝不进 shell（bash 会当成输入重定向）。
      if (hasUnresolvedPlaceholder(trimmed)) {
        setParamHint(
          t("The command still has unfilled parameters ({{command}}); please select values for them first", {
            command: trimmed,
          }),
        );
        return;
      }
      // 命令真正要执行了：手填参数的顶部提示已完成使命（补参前它常驻，
      // 补完执行后还留着就是过期噪音），在这里一并清掉。
      setParamHint(null);
      const mode: SubmitMode =
        options?.mode ?? (options?.prefix === undefined ? "full" : "line-ready");
      // 要不要捕获由命令本身决定（交互式 / 读 stdin / 无输出内建命令不捕获）。
      const plan = planCommandSubmission(trimmed, mode);
      coordinatorRef.current?.submit(trimmed, source, plan);
      boundaryParserRef.current?.expect(plan.markers);
      // 捕获起点：当前光标行 = 命令回显所在行。一次提交只注册一个 marker，
      // 等输出结束后（D 标记 / 兜底）由 consumeTerminalSnapshot 消费释放。
      if (plan.capture) {
        releaseCaptureMarker();
        const instance = terminalRef.current;
        if (instance) {
          const marker = instance.registerMarker(0);
          captureMarkerRef.current = marker ? { marker } : null;
          // 命令块起点：**独立** marker（同一行）。捕获 marker 在快照消费时
          // 会被 dispose —— dispose 后不再跟随回滚 trim，块若共用它，输出
          // 一多就会圈到错误的行；块需要全程跟随缓冲，必须有自己的 marker。
          if (marker) {
            const blockMarker = instance.registerMarker(0);
            if (blockMarker) {
              blockIdRef.current += 1;
              applyBlocks(beginBlock(blocksRef.current, `block-${blockIdRef.current}`, trimmed, blockMarker));
            }
          }
        }
      }
      const prefix = options?.prefix ?? "";
      if (!prefix && !plan.write) return;
      // `line-ready` 依赖调用方把回车一起发出来；没有（如 Ctrl+C 放弃行）
      // 就补一个，否则命令不会被提交。
      const needsSubmit = mode === "line-ready" && prefix.length > 0 && !/[\r\n]$/.test(prefix);
      void opsApi
        .sshInput(sessionId, prefix + (needsSubmit ? "\r" : "") + plan.write)
        .catch(() => undefined);
    },
    [boundaryParserRef, releaseCaptureMarker, sessionId, setParamHint, t, terminalRef],
  );

  return {
    commandBlocks,
    coordinatorRef,
    captureMarkerRef,
    consumeTerminalSnapshot,
    execute,
    runConfirm,
    setRunConfirm,
  };
}
