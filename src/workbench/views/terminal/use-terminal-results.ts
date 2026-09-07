import { useCallback, useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { useTranslation } from "react-i18next";
import { Terminal, type IMarker } from "@xterm/xterm";
import { opsApi } from "@/api/ops-api";
import type { SuggestedRisk } from "@/api/types/environment";
import { hasUnresolvedPlaceholder } from "@/workbench/views/command-center/complete";
import { extractTerminalSnapshot } from "./extract-terminal-snapshot";
import { planCommandSubmission, type CommandSource, type SubmitMode } from "./command-plan";
import { readEnhancedTerminal, saveEnhancedTerminal } from "./terminal-preferences";
import type { CommandBoundaryParser } from "./command-boundary";
import {
  TerminalCommandCoordinator,
  type CapturedResult,
  type RenderOutcome,
} from "./TerminalCommandCoordinator";

export interface TerminalResultsHost {
  sessionId: string;
  terminalRef: RefObject<Terminal | null>;
  boundaryParserRef: RefObject<CommandBoundaryParser | null>;
  /** 记历史 + `cd` 跟随（任何来源的执行都要留下痕迹）。 */
  noteExecutedCommand: (command: string) => void;
  /** 参数类可见提示（如"还有未替换的参数"）—— 绝不静默失败。 */
  setParamHint: (value: string | null) => void;
}

/**
 * 命令结果面板的全部状态与**唯一提交入口**。
 *
 * 从 `TerminalView` 拆出来是为了让"结果怎么产生、怎么关闭、怎么重运行"
 * 有一个完整归属：
 *
 * - 增强终端开关（关着 → 不注入标记、不产出结果、撤掉已有结果）；
 * - 捕获起点 marker 与 xterm 快照的消费；
 * - 结果 Tab 管理与按**真实风险**门控的重运行。
 *
 * 提交链路（唯一入口 `execute`）：
 *
 * ```text
 * execute(command, source, options)
 *   → coordinator.submit(command, source, plan)   // 开始捕获 + 记边界起点
 *   → 注册 xterm 起始行 marker                     // 快照起点（一次一个）
 *   → sshInput(command + 受控标记)                 // 只写一次
 *   → OSC 133 D → 渲染完成后抓快照 → 新建结果 Tab
 * ```
 */
export function useTerminalResults(host: TerminalResultsHost) {
  const { sessionId, terminalRef, boundaryParserRef, noteExecutedCommand, setParamHint } = host;
  const { t } = useTranslation();

  /**
   * **增强终端开关**（默认开）：只有打开时命令才会注入受控标记、捕获输出并
   * 生成结果面板；关着时终端就是纯终端 —— 不注入任何标记、不产生任何结果
   * Tab。默认关会让新用户看不到任何结果 Tab / JSON Tab（表现为"功能写了但
   * 界面没反应"），所以只有用户**主动关过**才保持关闭
   * （读写细节见 `terminal-preferences.ts`）。
   */
  const [enhanced, setEnhanced] = useState<boolean>(readEnhancedTerminal);
  /** 协调器只创建一次，onResult / 提交决策都要读到**当前**开关值。 */
  const enhancedRef = useRef(enhanced);
  enhancedRef.current = enhanced;
  useEffect(() => {
    saveEnhancedTerminal(enhanced);
  }, [enhanced]);

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
  if (!coordinatorRef.current) {
    coordinatorRef.current = new TerminalCommandCoordinator({
      match: (text) => opsApi.commandMatchText(text),
      onResult: (result) => {
        // 增强终端关着时不产出任何结果面板（含飞行中捕获的迟到结果）。
        if (!enhancedRef.current) return;
        setResults((current) => [...current, result]);
        setActiveId(result.id);
        setDrawerCollapsed(false);
        setDrawerClosed(false);
      },
      // 护栏兜底（受控标记始终没来）：主动向终端要一次当前快照。
      captureNow: () => consumeTerminalSnapshot(captureMarkerRef.current),
    });
  }
  useEffect(
    () => () => {
      coordinatorRef.current?.dispose();
      releaseCaptureMarker();
    },
    [releaseCaptureMarker],
  );

  /**
   * 本次会话的命令结果（快照 + 原始流，最新在后）。与是否命中知识库无关：
   * 只要是可捕获命令（非交互式、不读 stdin）都会产出一条；命令本身的输出
   * 为空也是有效结果（显示为空，不回落）。
   */
  const [results, setResults] = useState<CapturedResult[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [drawerCollapsed, setDrawerCollapsed] = useState(false);
  const [drawerClosed, setDrawerClosed] = useState(false);
  /**
   * 结果面板内容区高度（px）；null = 默认 38vh。顶部把手可拖拽调节：
   * 默认高度（38vh）就是上限，拖到最低会自动收起（交互见 TerminalResultDrawer）。
   * 放在 hook 里与 collapsed/closed 同层 —— 抽屉因关闭/清空卸载后再出现时，
   * 高度不无故回到默认。
   */
  const [drawerHeight, setDrawerHeight] = useState<number | null>(null);
  /** 重运行前的确认（按真实风险门控，依赖唯一提交入口）。 */
  const [rerunConfirm, setRerunConfirm] = useState<CapturedResult | null>(null);
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
      // 增强终端关着 → 不注入受控标记、不捕获输出（命令照常发往 shell）。
      const plan = planCommandSubmission(trimmed, mode, { capture: enhancedRef.current });
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

  /** 重运行：按**真实风险**门控（只读直接跑；修改型 / 未知必须确认；删除类不提供）。 */
  const rerun = (item: CapturedResult) => {
    if (!item.canExecute) return;
    if (item.mutability === "delete") return; // 删除类走软删除流程（已移出 P4）
    // 知识库未命中 → `unknown`，同样要确认：绝不把未知命令假装成只读。
    if (item.mutability === "change" || item.mutability === "unknown") {
      setRerunConfirm(item);
      return;
    }
    noteExecutedCommand(item.command);
    execute(item.command, "rerun");
  };
  const confirmRerun = () => {
    const item = rerunConfirm;
    setRerunConfirm(null);
    if (!item) return;
    noteExecutedCommand(item.command);
    execute(item.command, "rerun");
  };

  /** 关闭单个结果 Tab：优先选择右侧相邻，没有则选左侧。 */
  const closeTab = (id: string) => {
    setResults((current) => {
      const index = current.findIndex((item) => item.id === id);
      if (index === -1) return current;
      const next = current.filter((item) => item.id !== id);
      setActiveId((activeId) => {
        if (activeId !== id) return activeId;
        // 右侧优先，没有则左侧；全部关完 → null（抽屉隐藏）。
        return next[index] ? next[index].id : (next[index - 1]?.id ?? null);
      });
      return next;
    });
  };
  const closeOthers = (id: string) => {
    setResults((current) => current.filter((item) => item.id === id));
    setActiveId(id);
  };
  const clearAll = () => {
    setResults([]);
    setActiveId(null);
    setDrawerClosed(true);
  };

  /**
   * **就一个开关**：开 → 命令结果面板随结果自动出现；关 → 纯终端，什么都没有
   * （结果面板、已存结果全部撤掉）。面板自己的 × 只是临时收起，下一条命令
   * 的结果会重新展开它 —— 不再需要第二个"显示/隐藏结果"按钮。
   */
  const toggleEnhanced = useCallback(() => {
    const next = !enhancedRef.current;
    setEnhanced(next);
    if (!next) {
      // 关掉 = 回到纯终端：已有结果面板全部撤掉，飞行中的捕获也会被丢弃。
      setResults([]);
      setActiveId(null);
      setDrawerClosed(true);
    } else {
      // 重新打开：面板跟着新结果出来（之前只是被 × 收起）。
      setDrawerClosed(false);
    }
  }, []);

  return {
    enhanced,
    toggleEnhanced,
    results,
    activeId,
    setActiveId: setActiveId as Dispatch<SetStateAction<string | null>>,
    drawerCollapsed,
    setDrawerCollapsed,
    drawerClosed,
    setDrawerClosed,
    drawerHeight,
    setDrawerHeight,
    closeTab,
    closeOthers,
    clearAll,
    coordinatorRef,
    captureMarkerRef,
    consumeTerminalSnapshot,
    execute,
    rerun,
    rerunConfirm,
    setRerunConfirm,
    confirmRerun,
    runConfirm,
    setRunConfirm,
  };
}
