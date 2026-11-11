import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CurvedInput } from "@/components/ui/curved-input";
import { SquareTerminal } from "@/components/icons";
import { cn } from "@/lib/cn";
import { COMMAND_NAMES, commandMatchScore } from "./completion/providers/command";

/**
 * 终端输入条 —— **对话式输入**（用户裁决 2026-11-11）。
 *
 * 输入框用 React Bits 的官方 **CurvedInput**（`components/ui/curved-input.tsx`）：
 * 文字、光标、按钮全部由 SVG `textPath` 沿弧线绘制，超出部分在弧线上滚动。
 *
 * 它本身是**单行**控件（弧线上的文字没法换行），所以这里不再做多行 textarea：
 * 需要多行的场景（粘贴脚本）走历史记录或直接在终端里执行。
 *
 * 补全：命令词阶段弹本地候选（前缀 + 缩写），Tab 接受、↑↓ 选择、Esc 关闭。
 */
export function TerminalComposer({
  disabled,
  interactive,
  history,
  onSubmit,
  onInterrupt,
}: {
  disabled: boolean;
  interactive: boolean;
  history: string[];
  onSubmit: (command: string) => void;
  onInterrupt: () => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  /** 历史游标：-1 = 正在编辑新命令。 */
  const [cursor, setCursor] = useState(-1);
  /** 补全高亮。 */
  const [active, setActive] = useState(0);
  /** Esc 主动关掉补全后，输入变化前不再弹。 */
  const [dismissed, setDismissed] = useState(false);
  const draftBeforeHistory = useRef("");
  const blocked = disabled || interactive;

  /**
   * 命令名补全：只在**第一个词**阶段给（后续参数交给远端 shell）。
   * 与终端里的 provider 共用同一张命令表与同一个打分函数。
   */
  const suggestions = useMemo(() => {
    const head = text.trimStart();
    if (!head || /\s/.test(head)) return [];
    return COMMAND_NAMES.map((command) => ({
      command,
      score: commandMatchScore(head, command.name),
    }))
      .filter(
        (entry): entry is { command: (typeof COMMAND_NAMES)[number]; score: number } =>
          entry.score !== null,
      )
      .sort((a, b) => a.score - b.score || a.command.name.length - b.command.name.length)
      .slice(0, 6)
      .map((entry) => entry.command);
  }, [text]);

  const showSuggestions = !blocked && !dismissed && suggestions.length > 0;

  // 补全列表变短时高亮不能越界。
  useEffect(() => {
    setActive((current) => Math.min(current, Math.max(suggestions.length - 1, 0)));
  }, [suggestions.length]);

  const submit = () => {
    const command = text.trim();
    if (!command || blocked) return;
    onSubmit(command);
    setText("");
    setCursor(-1);
    setDismissed(false);
    draftBeforeHistory.current = "";
  };

  const accept = (name: string) => {
    setText(`${name} `);
    setCursor(-1);
    setDismissed(true);
  };

  const recall = (delta: 1 | -1) => {
    if (history.length === 0) return;
    const next = cursor + delta;
    if (next < -1) return;
    if (next >= history.length) {
      setCursor(-1);
      setText(draftBeforeHistory.current);
      return;
    }
    if (cursor === -1 && delta === 1) draftBeforeHistory.current = text;
    setCursor(next);
    setText(history[next] ?? "");
  };

  return (
    <div
      className="shrink-0 bg-surface-1 px-3 pb-2 pt-2.5"
      /*
       * 键盘统一在最外层接：CurvedInput 内部的 `<input>` 是透明覆盖层，
       * keydown 会冒泡到这里，Tab / ↑↓ / Esc 都在这里处理。
       */
      onKeyDown={(event) => {
        // 中文输入法组合期间不拦（Enter 是上屏，不是发送）。
        if (event.nativeEvent.isComposing) return;
        /*
         * Enter 显式发送，不依赖 `<form onSubmit>`。
         *
         * CurvedInput 内部那层 `<input>` 是透明覆盖层，焦点/表单提交在不同
         * 输入法下并不可靠（用户反馈"回车发送不了"）；在最外层直接接住 Enter，
         * 与按钮点同一条路径，行为可预期。
         */
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          submit();
          return;
        }
        /*
         * 候选列表左侧印着 1-9，**数字键就必须能选**（用户反馈：按 1 结果把
         * "1" 输进了输入框）。只在候选浮层显示、且序号真的存在时拦截，
         * 带空格之后的参数位置不受影响。
         */
        if (showSuggestions && /^[1-9]$/.test(event.key)) {
          const index = Number(event.key) - 1;
          if (index < suggestions.length) {
            event.preventDefault();
            accept(suggestions[index].name);
            return;
          }
        }
        if (showSuggestions && event.key === "Tab") {
          event.preventDefault();
          accept(suggestions[active]?.name ?? suggestions[0].name);
          return;
        }
        if (showSuggestions && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
          event.preventDefault();
          const delta = event.key === "ArrowDown" ? 1 : -1;
          setActive((current) => {
            const next = current + delta;
            if (next < 0) return suggestions.length - 1;
            if (next >= suggestions.length) return 0;
            return next;
          });
          return;
        }
        if (event.key === "Escape") {
          if (showSuggestions) {
            event.preventDefault();
            setDismissed(true);
            return;
          }
          if (text) {
            event.preventDefault();
            setText("");
            setCursor(-1);
          }
          return;
        }
        // 补全浮层关着时，↑↓ 翻历史命令。
        if (!showSuggestions && event.key === "ArrowUp") {
          event.preventDefault();
          recall(1);
          return;
        }
        if (!showSuggestions && event.key === "ArrowDown" && cursor !== -1) {
          event.preventDefault();
          recall(-1);
          return;
        }
        if (event.key === "c" && event.ctrlKey) {
          event.preventDefault();
          onInterrupt();
          setText("");
          setCursor(-1);
        }
      }}
    >
      {interactive && (
        <div className="mb-1.5 flex items-center gap-1.5 px-1 text-10 text-warning">
          <SquareTerminal size={11} />
          {t("A full-screen program is running — type directly in the terminal above")}
        </div>
      )}

      <div className="relative">
        {/* 补全浮层：绝对定位在输入框上方，不占布局、不推挤终端。 */}
        {showSuggestions && (
          <div className="absolute bottom-full left-2 right-2 z-20 mb-1 overflow-hidden rounded-[12px] border border-line bg-surface-1 py-0.5 shadow-[0_6px_20px_rgb(15_23_42/0.16)]">
            {suggestions.map((command, index) => (
              <button
                key={command.name}
                type="button"
                // mousedown：抢在 input 失焦前完成补全。
                onMouseDown={(event) => {
                  event.preventDefault();
                  accept(command.name);
                }}
                onMouseEnter={() => setActive(index)}
                className={cn(
                  "flex w-full items-center gap-2 px-2.5 py-1 text-left",
                  index === active ? "bg-accent/10" : "hover:bg-surface-hover",
                )}
              >
                <span className="w-3 shrink-0 text-center text-9 tabular-nums text-fg-subtle">
                  {index < 9 ? index + 1 : ""}
                </span>
                <code className="shrink-0 font-mono text-11 text-fg">{command.name}</code>
                <span className="min-w-0 flex-1 truncate text-10 text-fg-subtle">
                  {t(command.about)}
                </span>
              </button>
            ))}
          </div>
        )}

        <CurvedInput
          value={text}
          onChange={(next) => {
            setText(next);
            setCursor(-1);
            setDismissed(false);
          }}
          onSubmit={submit}
          placeholder={
            disabled
              ? t("Not connected")
              : interactive
                ? t("Input is captured by the running program")
                : t("Type a command, Enter to send · ↑↓ for history")
          }
          buttonText={t("Send")}
          ariaLabel={t("Terminal command")}
          disabled={blocked}
          autoFocus={!blocked}
          showButton
          showIcon={false}
          bend={14}
          height={54}
          fontSize={13}
          cornerRadius={20}
          shadowSize="sm"
        />
      </div>

      <div className="mt-1 flex items-center justify-between px-3 text-9 text-fg-subtle">
        <span>
          {showSuggestions
            ? t("1-9 or Tab to complete · ↑↓ to pick · Esc to dismiss")
            : t("{{count}} commands in history · ↑↓ to recall", { count: history.length })}
        </span>
        <span>{t("Ctrl+C interrupts")}</span>
      </div>
    </div>
  );
}
