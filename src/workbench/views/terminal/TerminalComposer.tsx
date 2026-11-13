import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { CurvedInput } from "@/components/ui/curved-input";
import { SquareTerminal } from "@/components/icons";
import { cn } from "@/lib/cn";
import type { NginxEnvironment } from "@/api/types/environment";
import { replaceSegment, resolveComposerKey } from "./composer-keys";
import { useComposerCompletion, type ComposerItem } from "./use-composer-completion";

/**
 * 终端输入条 —— 对话式输入 + **横向候选栏**（微软输入法式）。
 *
 * 三条关键约束（2026-11-13 用户裁决）：
 * 1. **本地先出**：命令名与当前服务器历史同步计算，`doc` 在本次渲染里就有
 *    `docker`；目录/服务/容器异步补进来，不阻塞首选。
 * 2. **同一份列表**：界面只画前 5 条，键盘 ↑↓ 与 Tab 也只在**这 5 条**里走，
 *    不会选中屏幕上根本看不见的候选。
 * 3. **贴着光标**：位置来自 CurvedInput 报的**光标线段下端点**（视口坐标），
 *    候选栏用 `position: fixed` 独立定位，不受输入框宽度影响。
 */
export function TerminalComposer({
  sessionId,
  cwd,
  home,
  environment,
  disabled,
  interactive,
  history,
  onSubmit,
  onInterrupt,
}: {
  sessionId: string;
  cwd: string | null;
  home: string | null;
  environment?: NginxEnvironment | null;
  disabled: boolean;
  interactive: boolean;
  history: string[];
  onSubmit: (command: string) => void;
  onInterrupt: () => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [caretRequest, setCaretRequest] = useState<{ index: number; nonce: number } | null>(null);
  const caretNonce = useRef(0);
  /** 用户是否手动收起了候选栏（Esc / Ctrl+Space）。 */
  const [barHidden, setBarHidden] = useState(false);
  /** 输入法组词中：隐藏自带候选栏，让系统候选独占。 */
  const [composing, setComposing] = useState(false);
  const [inputFocused, setInputFocused] = useState(false);
  /** 光标线段下端点的**视口坐标**。 */
  const [caretPos, setCaretPos] = useState<{ x: number; y: number } | null>(null);
  /**
   * **选中的候选用稳定 ID 记录**（`source:label`），不用下标。
   *
   * 异步结果插到前面、翻页、列表重排之后，下标会指向另一条；ID 不会。
   * 屏幕高亮、编号、Tab 填入全部由它派生，三者永远一致。
   */
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** 原生 input 的选区：有选区时 Ctrl+C 复制，而不是清草稿。 */
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  /**
   * Ctrl+Space 主动打开。
   *
   * 行尾是空格时自动提示会收起（避免和"刚打完一个词"打架），但用户可能
   * 就是想看当前位置有什么可选（子命令 / 路径 / 容器）—— 这个开关让它能
   * 主动调出来，哪怕当前词是空的。
   */
  const [forceOpen, setForceOpen] = useState(false);
  const [historyCursor, setHistoryCursor] = useState(-1);
  const draftBeforeHistory = useRef("");
  const barRef = useRef<HTMLDivElement>(null);
  const [barPos, setBarPos] = useState<{ left: number; top: number } | null>(null);
  const blocked = disabled || interactive;

  const { items, usable } = useComposerCompletion({
    sessionId,
    text,
    caret,
    enabled: !blocked && text.trim().length > 0,
    cwd,
    home,
    environment,
    history,
  });

  /** 候选的稳定标识：来源 + 展示名（同一来源里不会重复）。 */
  const idOf = useCallback(
    (item: ComposerItem) => `${item.source}:${item.label}`,
    [],
  );

  /** 每页条数：界面上的序号 1-6 与数字键一一对应。 */
  const PAGE_SIZE = 6;
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(items.length / PAGE_SIZE));

  // 候选变少时页码不能越界。
  useEffect(() => {
    setPage((current) => Math.min(current, pageCount - 1));
  }, [pageCount]);

  /**
   * **屏幕上真正画出来的那几条**（当前页）。
   *
   * 渲染、键盘 ↑↓、数字 1-6、Tab 全部只看这一份切片；第 0 页还会把用户
   * 已选定那条**提回列表**，避免异步结果插到前面把高亮项挤出去。
   */
  const visible = useMemo(() => {
    if (page > 0) return items.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
    const head = items.slice(0, PAGE_SIZE);
    if (!selectedId) return head;
    const pinned = items.find((item) => idOf(item) === selectedId);
    if (!pinned || head.includes(pinned)) return head;
    return [pinned, ...items.filter((item) => item !== pinned).slice(0, PAGE_SIZE - 1)];
  }, [idOf, items, page, selectedId]);

  /**
   * 当前高亮项：**由 `selectedId` 在可见列表里反查下标**。
   *
   * 这就是"看到的那条 = 高亮的那条 = Tab 填入的那条"的唯一真源：
   * 远程结果插入、翻页之后重新查一次，绝不会指到另一条。
   */
  const active = useMemo(() => {
    if (visible.length === 0) return 0;
    if (!selectedId) return 0;
    const index = visible.findIndex((item) => idOf(item) === selectedId);
    return index >= 0 ? index : 0;
  }, [idOf, selectedId, visible]);

  /*
   * **按实际编辑位置判断空格**：光标前一个字符是空格就算"刚敲了空格"。
   *
   * 只看 `text.endsWith(" ")` 漏掉了"在命令中间插入空格"——`dock|er` 中间
   * 插一个空格后，行尾仍是 `r`，于是旧候选还挂着、Tab 还能选中。现在行尾和
   * 中间一视同仁：只插入空格，候选与灰字收起，补全自带尾随空格同理。
   *
   * 要继续看候选：接着输入下一个词（`l` → `logs`），或 **Ctrl+Space** 主动
   * 打开（`autoAllowed` 放行）。
   */
  const justAfterSpace = caret > 0 && text[caret - 1] === " ";
  const autoAllowed = !justAfterSpace || forceOpen;
  const barVisible =
    inputFocused &&
    usable &&
    !barHidden &&
    !composing &&
    caretPos !== null &&
    visible.length > 0 &&
    autoAllowed;

  // 光标坐标去抖：CurvedInput 每帧都报，等值也要跳过，否则形成渲染循环。
  const updateCaretPos = useCallback((next: { x: number; y: number } | null) => {
    setCaretPos((current) => {
      if (!next) return null;
      if (current && Math.abs(current.x - next.x) < 0.5 && Math.abs(current.y - next.y) < 0.5) {
        return current;
      }
      return next;
    });
  }, []);

  /*
   * 窄窗口：键盘选到右侧候选时把它滚进可视区（候选栏本身可横向滚动）。
   */
  useEffect(() => {
    if (!barVisible) return;
    const node = barRef.current?.querySelector<HTMLElement>("[data-active='true']");
    node?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active, barVisible, page]);

  /**
   * 候选栏定位：贴光标下沿 7px；右边界向左收，底部不足翻上方。
   *
   * 用 `position: fixed` + 视口尺寸判断，**完全独立于输入框宽度** —— 输入框
   * 再窄，候选栏也能按自己的实际宽度找位置，不会被裁掉。
   */
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar || !caretPos) return;
    const position = () => {
      const { width, height } = bar.getBoundingClientRect();
      const left = Math.max(8, Math.min(caretPos.x, window.innerWidth - width - 8));
      const below = caretPos.y + 7;
      const top = below + height <= window.innerHeight - 8
        ? below
        : Math.max(8, caretPos.y - height - 7);
      setBarPos(current => current?.left === left && current.top === top ? current : { left, top });
    };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(bar);
    window.addEventListener("resize", position);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", position);
    };
  }, [barVisible, caretPos]);

  /** 行内 ghost：首选里还没输入的部分（候选栏可见时不画，避免重复）。 */
  const ghost = useMemo(() => {
    const first = visible[0];
    /*
     * 不画灰字的四种情况：
     * - 候选栏正显示（重复提示）；
     * - 候选与当前输入不匹配 / 已过期；
     * - 空格之后（那是"上一轮"的提示，先让用户看到自己打的空格）；
     * - **用户按 Esc 主动收起**（`barHidden`）—— 灰字也必须一起消失，
     *   否则 Tab 仍会把它当成"可接受的候选"填进去。
     */
    if (
      !usable ||
      barVisible ||
      barHidden ||
      !first ||
      first.fromHistory ||
      justAfterSpace ||
      !autoAllowed
    ) {
      return "";
    }
    const typed = text.slice(first.replaceRange.start, caret);
    const insert = first.insertText;
    if (!typed) return insert;
    if (!insert.startsWith(typed)) return "";
    return insert.slice(typed.length);
  }, [barVisible, caret, text, usable, visible]);

  /**
   * **唯一"可接受"状态**：候选栏或灰字真的显示在屏幕上。
   *
   * Tab 只看这个值 —— 空格后候选被收起（`autoAllowed=false`），即使 `items`
   * 里还有上一轮结果、`usable` 仍为 true，也**不能**被 Tab 选中；此时 Tab
   * 恢复浏览器的正常焦点导航。
   */
  const canAccept = barVisible || ghost !== "";

  const resetCaret = useCallback((index: number) => {
    caretNonce.current += 1;
    setCaretRequest({ index, nonce: caretNonce.current });
    setCaret(index);
  }, []);

  /** 只替换光标所在的词，前后参数/引号/管道原样保留。 */
  const apply = useCallback(
    (item: ComposerItem) => {
      if (!usable || blocked || composing) return;
      const next = replaceSegment(text, item.replaceRange, item.insertText);
      setText(next.text);
      resetCaret(next.caret);
      // 填入后光标停在插入内容之后（`resetCaret`），选中态清掉。
      setSelectedId(null);
      setHistoryCursor(-1);
    },
    [blocked, composing, resetCaret, text, usable],
  );

  /**
   * **唯一的选择入口**：鼠标点击、↑↓ + Tab、Alt+数字 全部走这里。
   *
   * 用稳定 ID 回到**当前列表**里取最新版本再填入 —— 点击瞬间候选可能刚被
   * 异步结果刷新过，直接填手上这份旧对象会写进过期文本。
   */
  const applySelection = useCallback(
    (target: ComposerItem) => {
      const fresh = items.find((item) => idOf(item) === idOf(target)) ?? target;
      apply(fresh);
    },
    [apply, idOf, items],
  );

  const submit = useCallback(() => {
    const command = text.trim();
    if (!command || blocked) return;
    onSubmit(command);
    setText("");
    setCaret(0);
    setBarHidden(false);
    setHistoryCursor(-1);
    draftBeforeHistory.current = "";
  }, [blocked, onSubmit, text]);

  const recall = useCallback(
    (delta: 1 | -1) => {
      if (history.length === 0) return;
      const next = historyCursor + delta;
      if (next < -1) return;
      if (next >= history.length) {
        setHistoryCursor(-1);
        setText(draftBeforeHistory.current);
        resetCaret(draftBeforeHistory.current.length);
        return;
      }
      if (historyCursor === -1 && delta === 1) draftBeforeHistory.current = text;
      setHistoryCursor(next);
      const value = history[next] ?? "";
      setText(value);
      resetCaret(value.length);
    },
    [history, historyCursor, resetCaret, text],
  );

  return (
    <div
      className="shrink-0 bg-surface-1 px-3 pb-2 pt-2.5"
      onFocusCapture={(event) => {
        if (event.target instanceof HTMLInputElement) setInputFocused(true);
      }}
      onBlurCapture={(event) => {
        if (event.target instanceof HTMLInputElement) setInputFocused(false);
      }}
      onKeyDown={(event) => {
        if (!(event.target instanceof HTMLInputElement)) return;
        // 输入框里的 Ctrl+C 只清草稿，不发 SIGINT（中断走显式按钮）。
        if (event.key === "c" && event.ctrlKey && !event.nativeEvent.isComposing) {
          // 有选区 = 复制选中文字，**草稿保持原样**（这是用户的命令，不能清掉）。
          if (selection.end > selection.start) {
            event.preventDefault();
            void navigator.clipboard?.writeText(text.slice(selection.start, selection.end));
            return;
          }
          // 没有选区才是"清草稿"（也不发 SIGINT，中断走显式按钮）。
          event.preventDefault();
          setText("");
          setCaret(0);
          setHistoryCursor(-1);
          return;
        }

        const action = resolveComposerKey(
          {
            key: event.key,
            code: event.code,
            ctrlKey: event.ctrlKey,
            shiftKey: event.shiftKey,
            altKey: event.altKey,
            isComposing: event.nativeEvent.isComposing,
          },
          {
            listOpen: barVisible,
            // 只有屏幕上真有候选或灰字，Tab 才填入；否则放行给焦点导航。
            hasUsableItems: canAccept,
            hasItems: visible.length > 0,
            hasDraft: text.length > 0,
            pageCount,
          },
        );

        switch (action.type) {
          case "none":
            return;
          case "complete": {
            event.preventDefault();
            // 统一入口：Tab 与鼠标点击走同一条 `applySelection`。
            const pick = (barVisible ? visible[active] : visible[0]) ?? visible[0];
            if (pick) applySelection(pick);
            return;
          }
          case "submit": {
            event.preventDefault();
            submit();
            return;
          }
          case "list-toggle": {
            event.preventDefault();
            /*
             * Ctrl+Space：**主动查看当前候选**。
             *
             * 行尾是空格时自动提示本来是收起的；这个键强制打开（`forceOpen`），
             * 所以 `docker ` 之后也能看子命令 / 路径 / 容器。再按一次收起。
             */
            if (barVisible) {
              setBarHidden(true);
              setForceOpen(false);
            } else {
              setBarHidden(false);
              setForceOpen(true);
            }
            setSelectedId(null);
            return;
          }
          case "move": {
            event.preventDefault();
            // 只在**可见的这几条**里循环，永远选不到屏幕外的候选。
            const nextIndex = (() => {
              const next = active + action.delta;
              if (next < 0) return visible.length - 1;
              if (next >= visible.length) return 0;
              return next;
            })();
            const pick = visible[nextIndex];
            setSelectedId(pick ? idOf(pick) : null);
            return;
          }
          case "history": {
            event.preventDefault();
            recall(action.delta === 1 ? -1 : 1);
            return;
          }
          case "close-list": {
            // 只收候选，草稿一字不动；空格不会把它重新打开（见 onChange）。
            event.preventDefault();
            setBarHidden(true);
            setForceOpen(false);
            return;
          }
          case "pick": {
            // Alt+1~6：越界（这一页没那么多条）就放行，让按键正常输入。
            const pick = visible[action.index];
            if (!pick) return;
            event.preventDefault();
            applySelection(pick);
            return;
          }
          case "page": {
            event.preventDefault();
            setPage((current) => {
              const next = current + action.delta;
              if (next < 0) return pageCount - 1;
              if (next >= pageCount) return 0;
              return next;
            });
            setSelectedId(null);
            return;
          }
        }
      }}
    >
      {interactive && (
        <div className="mb-1.5 flex items-center gap-1.5 px-1 text-10 text-warning">
          <SquareTerminal size={11} />
          {t("A full-screen program is running — type directly in the terminal above")}
        </div>
      )}

      {/*
       * 横向候选栏：`fixed` + 视口坐标定位，不占布局、不受输入框宽度裁切。
       * 每条两行：命令名 + 说明（历史候选标「历史」），末尾「Tab 补全」。
       */}
      {barVisible && createPortal(
        <div
          ref={barRef}
          style={{
            left: barPos?.left ?? -9999,
            top: barPos?.top ?? -9999,
            maxWidth: "calc(100vw - 16px)",
            visibility: barPos ? "visible" : "hidden",
          }}
          /*
           * `max-w` + `overflow-x-auto`：窄窗口下候选栏**不会伸出屏幕**；
           * 条数多、文字长时改为横向滚动，而不是把最右边那条裁掉看不见。
           */
          className="fixed z-50 flex max-w-[calc(100vw-16px)] items-stretch gap-0.5 overflow-x-auto rounded-[10px] border border-line bg-surface-1 px-1 py-1 shadow-[0_4px_14px_rgb(15_23_42/0.16)] [scrollbar-width:none]"
        >
          {visible.map((item, index) => (
            <button
              // 稳定 key：列表重排 / 翻页时节点复用，mousedown 不会落空。
              key={idOf(item)}
              type="button"
              tabIndex={-1}
              data-active={index === active}
              /*
               * **mousedown 而不是 click**：候选栏会随输入/异步结果重渲染，
               * 元素在 mouseup 前被换掉时 click 根本不触发 —— 这就是"能看到
               * 候选但点不中"的根因。mousedown 先 preventDefault 保住输入框
               * 焦点，再直接走统一选择入口，不依赖 click 是否落到同一个节点上。
               */
              onMouseDown={(event) => {
                event.preventDefault();
                applySelection(item);
              }}
              onMouseEnter={() => {
                setSelectedId(idOf(item));
              }}
              title={item.insertText}
              className={cn(
                "flex min-w-0 max-w-[200px] flex-col items-start rounded-[6px] px-1.5 py-0.5 text-left",
                index === active ? "bg-accent/12" : "hover:bg-surface-hover",
              )}
            >
              <span className="flex max-w-full items-center gap-1">
                {/* 序号与数字键一一对应：按 1 就选这一条。 */}
                <span className="shrink-0 text-9 tabular-nums text-fg-subtle">{index + 1}</span>
                <span className="truncate font-mono text-11 text-fg">{item.label}</span>
              </span>
              <span className="max-w-full truncate pl-3 text-9 text-fg-subtle">
                {item.fromHistory ? t("history") : t(item.detail)}
              </span>
            </button>
          ))}
          <span className="shrink-0 self-center whitespace-nowrap px-1 text-9 text-fg-subtle">
            {pageCount > 1 ? `${page + 1}/${pageCount} · ` : ""}
            {t("Tab to fill")}
          </span>
        </div>,
        document.body,
      )}

      <div className="relative">
        <CurvedInput
          value={text}
          onChange={(next) => {
            setText(next);
            // 输入变了：之前选中的候选与页码都作废，从第一页重新开始。
            setSelectedId(null);
            setPage(0);
            setForceOpen(false);
            /*
             * 空格**不重开**候选：Esc 收起之后按空格保持收起，补全自己加的
             * 尾随空格也一样（"等用户继续输入或主动打开候选"）。其它字符
             * 一按就恢复自动提示。
             *
             * 两种位置都要识别：行尾追加（`docker `，endsWith 命中）和命令
             * 中间插入（`dock er`，行尾不是空格，但插入点后一位是空格）。
             */
            const insertedSpace = next.endsWith(" ") || next[caret] === " ";
            if (!insertedSpace) setBarHidden(false);
            setHistoryCursor(-1);
          }}
          onSubmit={submit}
          onCaretChange={setCaret}
          onCaretPosition={updateCaretPos}
          onComposingChange={setComposing}
          onSelectionChange={setSelection}
          caretRequest={caretRequest}
          ghost={ghost}
          placeholder={
            disabled
              ? t("Not connected")
              : interactive
                ? t("Input is captured by the running program")
                : t("Type a command, Enter to run · Tab to complete · Ctrl+Space for the list")
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
          {barVisible
            ? t("1-6 pick · = / - page · Tab to fill · Esc to close")
            : t("Tab fills the suggestion · Enter runs it · ↑↓ for history")}
        </span>
        <button
          type="button"
          disabled={blocked}
          onClick={onInterrupt}
          className="rounded px-1 text-fg-subtle transition-colors hover:bg-danger/10 hover:text-danger disabled:pointer-events-none disabled:opacity-40"
        >
          {t("Interrupt")}
        </button>
      </div>
    </div>
  );
}
