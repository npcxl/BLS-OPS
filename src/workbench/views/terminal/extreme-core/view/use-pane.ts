/**
 * 右栏（工作区面板）的**几何与显隐**。
 *
 * 只在窗口内自适应：分栏要求「聊天 ≥ 320、右栏 ≥ 300」，放不下就让右栏浮在
 * 聊天上，而不是把聊天挤成一条。外缘外拖会临时加宽窗口，收起时只回收自己
 * 加出来的那一段。
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { opsApi } from "@/api/ops-api";
import { toAppError } from "@/lib/app-error";
import { useExtremeStore, type TerminalPane, type WorkspacePane } from "@/stores/extreme-store";
import { beginPaneOuterDrag } from "../pane-outer-drag";
import { paneLayout } from "../pane-layout";

export interface PaneDeps {
  workspaceId: string | null;
  setAskError: Dispatch<SetStateAction<string | null>>;
}

export function usePane({ workspaceId, setAskError }: PaneDeps) {
  /** 统一右栏：已打开标签 + 收起 / 分栏 / 展开。 */
  const paneTab = useExtremeStore((state) => state.paneTab);
  const paneLists = useExtremeStore((state) => state.paneLists);
  const closePane = useExtremeStore((state) => state.closePane);
  const paneView = useExtremeStore((state) => state.paneView);
  const paneWidth = useExtremeStore((state) => state.paneWidth);
  const terminalPane = useExtremeStore((state) => state.terminalPane);

  const setPaneTab = useExtremeStore((state) => state.setPaneTab);
  const setPaneView = useExtremeStore((state) => state.setPaneView);
  const setPaneWidth = useExtremeStore((state) => state.setPaneWidth);
  const setPaneDragging = useExtremeStore((state) => state.setPaneDragging);
  const setTerminalPane = useExtremeStore((state) => state.setTerminalPane);
  const openPane = useExtremeStore((state) => state.openPane);
  /** 文件变更摘要：事件与右栏查询都写进 store（正文按需加载）。 */
  const fileChanges = useExtremeStore((state) => state.fileChanges);
  // 欢迎页（没有对话）不显示右栏；持久化的 split / expanded 只对正式对话生效。
  const paneShown = paneView !== "hidden" && Boolean(workspaceId);
  /** 「文件变更」标签上的角标：只数**当前对话**里还没放行的那些。 */
  const pendingChangeCount = useMemo(
    () =>
      Object.values(fileChanges).filter(
        (change) => change.workspaceId === workspaceId && change.status === "proposed",
      ).length,
    [fileChanges, workspaceId],
  );
  /**
   * 打开右栏的某个标签：顶栏按钮、输入区 ＋、AI 打开文件/日志、附件进来、
   * 上传完成都走它。
   *
   * **不改窗口尺寸**：以前这里是"把外框往右扩一段"，用户会看到窗口自己变宽
   * （收起再开、切服务器时宽度还会对不上）。现在一律在窗口内分栏，宽度由
   * 容器自己算（见下面的 `paneFit` / `paneOverlay`）。
   */
  const openPaneTab = useCallback(
    (tab: WorkspacePane, terminal?: TerminalPane) => {
      openPane(tab, terminal);
    },
    [openPane],
  );
  /**
   * 「查看变更 / 查看实际变更」的定位目标。
   *
   * `nonce` 让"同一个文件再点一次"也能重新滚过去：只比较 taskId / changeId 时
   * 第二次点击不会触发 effect。打开的是右栏标签，**不会**产生第二张审批卡。
   */
  const [changeFocus, setChangeFocus] = useState<{
    taskId: string;
    changeId?: string;
    nonce: number;
  } | null>(null);
  const openChanges = useCallback(
    (taskId: string, changeId?: string) => {
      setChangeFocus({ taskId, changeId, nonce: Date.now() });
      openPaneTab("changes");
    },
    [openPaneTab],
  );
  // 换对话：聊天里点开的定位目标属于上一条对话，不能带过去。
  useEffect(() => {
    setChangeFocus(null);
  }, [workspaceId]);
  /** 外拖实际加宽了多少：收起右栏时只回收这一段（用户手动改过窗口就不动）。 */
  const paneOuterWidenRef = useRef<{ baseWindow: number; added: number } | null>(null);
  /**
   * 收起右栏：只回收**这次外拖实际加出来**的窗口宽度。
   *
   * 用户后来手动拉过窗口（当前宽度对不上）就保留他的尺寸；内拖产生的宽度
   * 不在窗口上，不收。
   */
  const collapsePane = useCallback(() => {
    const widened = paneOuterWidenRef.current;
    paneOuterWidenRef.current = null;
    setPaneView("hidden");
    if (!widened || widened.added <= 0) return;
    if (Math.abs(window.innerWidth - (widened.baseWindow + widened.added)) > 3) return;
    void opsApi.extremePanelResize(widened.baseWindow, true).catch(() => undefined);
  }, [setPaneView]);
  /**
   * 右栏开关 = 会话工作区的显隐。
   *
   * 收起只影响界面；后台命令、上传与日志监听都继续跑，再打开就回到上次那个
   * 标签。
   */
  const togglePane = useCallback(() => {
    if (paneShown) collapsePane();
    else setPaneView("split");
  }, [collapsePane, paneShown, setPaneView]);
  /*
   * 右栏宽度：**在窗口内自适应**。
   *
   * 量的是内容行的可用宽度（去掉左栏自己那一截）：分栏要求"聊天 ≥ 520、
   * 右栏 ≥ 300"，放不下就让右栏改成浮在聊天上，而不是把聊天挤到只剩一条。
   * 量一次的代价是零（ResizeObserver），换来拖拽与缩放窗口时都不会越界。
   */
  const rowRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const [roomWidth, setRoomWidth] = useState(0);
  useEffect(() => {
    const row = rowRef.current;
    if (!row) return undefined;
    const measure = () => {
      const rail = railRef.current?.clientWidth ?? 0;
      setRoomWidth(Math.max(0, row.clientWidth - rail));
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    if (railRef.current) observer.observe(railRef.current);
    return () => observer.disconnect();
  }, []);
  /**
   * `paneWidth` = 用户首选宽度（持久化）；
   * `paneFit` = 当前窗口实际能显示出来的宽度（临时压缩，不写回 store）。
   *
   * 约束集中在 `paneLayout`：聊天最少 320，右栏最少 300，放不下切浮层。
   */
  const layout = paneLayout(paneWidth, roomWidth);
  const paneOverlay = layout.overlay;
  const paneFit = layout.actual;

  /**
   * 右栏外缘外拖：窗口向右长，新增宽度全部给右栏。
   *
   * 内拖仍走 `onWidthChange`（受聊天最小宽度约束）；外拖用绝对窗口目标，
   * 由 Rust 按显示器工作区夹紧。没有外扩空间 / 最大化时退化成窗口内分栏。
   */
  const onPaneOuterDragStart = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (paneView !== "split") return;
      paneOuterWidenRef.current = null;
      const basePane = paneFit;
      beginPaneOuterDrag(event, {
        basePaneWidth: basePane,
        onPaneWidth: (next, persist) => {
          /*
           * 首选宽度 > 当前实际：说明窗口缩小把右栏压过，保留首选，让窗口
           * 变宽时自然恢复；否则把这次外拖的新宽度记成新的首选。
           */
          const preferred = useExtremeStore.getState().paneWidth;
          const nextPreferred = preferred > basePane + 1 ? Math.max(preferred, next) : next;
          setPaneWidth(nextPreferred, { persist });
        },
        onDraggingChange: setPaneDragging,
        onCommitted: (info) => {
          paneOuterWidenRef.current = info.added > 0 ? info : null;
        },
        onError: (cause) => setAskError(toAppError(cause).message),
      });
    },
    [paneFit, paneView, setAskError, setPaneDragging, setPaneWidth],
  );
  // 拖到一半被卸载（退出超能 / 换会话）：别把"正在拖"留给浏览器隐藏逻辑。
  useEffect(() => () => setPaneDragging(false), [setPaneDragging]);

  return {
    paneTab,
    paneLists,
    closePane,
    paneView,
    terminalPane,
    setPaneTab,
    setPaneView,
    setPaneWidth,
    setPaneDragging,
    setTerminalPane,
    openPane,
    paneShown,
    pendingChangeCount,
    openPaneTab,
    changeFocus,
    openChanges,
    collapsePane,
    togglePane,
    rowRef,
    railRef,
    paneFit,
    paneOverlay,
    onPaneOuterDragStart,
  };
}
