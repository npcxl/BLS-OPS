import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowRight, ChevronLeft, ChevronRight, Globe, RefreshCw } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { opsApi } from "@/api/ops-api";
import { useExtremeStore } from "@/stores/extreme-store";

/**
 * 右栏内置浏览器。
 *
 * 网页由 Rust 侧的**独立子 WebView** 渲染；这里只画工具栏与一块占位区域，
 * 并把占位区域的位置/尺寸同步过去。状态拆成三件事：
 *
 * * `created`：子 WebView 是否已经在后端创建（创建时是隐藏的）；
 * * `generation`：本次挂载 / 本条对话的请求版本，迟到的旧请求一律丢弃；
 * * `visible`：当前是否真的显示。只有布局有效、标签可见、没有弹窗 / 拖动
 *   遮挡，并且 bounds 已经成功落下之后才 show。
 *
 * 外部页面拿不到应用的 Tauri 命令：子 WebView 没有 capability，初始化脚本
 * 还会删掉 `__TAURI_INTERNALS__`。
 */
export function BrowserPane({
  workspaceId,
  url,
  onUrlChange,
}: {
  workspaceId: string;
  /** 这条对话上次打开的地址；为空时显示地址输入。 */
  url: string | null;
  onUrlChange: (url: string) => void;
}) {
  const { t } = useTranslation();
  const hostRef = useRef<HTMLDivElement>(null);
  const [address, setAddress] = useState(url ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [modalBlocked, setModalBlocked] = useState(false);
  const modalBlockedRef = useRef(false);
  const paneDragging = useExtremeStore((state) => state.paneDragging);

  const current = useRef("");
  const created = useRef(false);
  const visible = useRef(false);
  const generation = useRef(0);
  const navGuardUntil = useRef(0);
  const onUrlChangeRef = useRef(onUrlChange);
  onUrlChangeRef.current = onUrlChange;

  /** 占位区域相对窗口客户区的边界；原生子 WebView 用同一套逻辑坐标。 */
  const rectOf = useCallback(() => {
    const node = hostRef.current;
    if (!node) return null;
    if (!node.isConnected || node.offsetParent === null) return null;
    const rect = node.getBoundingClientRect();
    // 原生子视图不会遵守父元素的 overflow：坐标越界就会盖住左侧工作台。
    // 这里先夹回窗口客户区，宁可少 1px，也不能让网页铺到整个应用上。
    const x = Math.max(0, Math.min(rect.left, window.innerWidth - 48));
    const y = Math.max(0, Math.min(rect.top, window.innerHeight - 48));
    const width = Math.min(rect.width, window.innerWidth - x);
    const height = Math.min(rect.height, window.innerHeight - y);
    if (width < 20 || height < 20) return null;
    return { x, y, width, height };
  }, []);

  const hide = useCallback(async () => {
    visible.current = false;
    await opsApi.extremeBrowserShow(false).catch(() => undefined);
  }, []);

  /**
   * 只同步边界，不导航、不显示。
   *
   * 返回是否落成功。失败（越界 / 容器太小 / 原生不可用）一律保持隐藏，
   * 并把原因交给右栏显示。
   */
  const syncBounds = useCallback(async (): Promise<boolean> => {
    const rect = rectOf();
    if (!rect) {
      await hide();
      setError(t("网页区域太小或不可用"));
      return false;
    }
    try {
      await opsApi.extremeBrowserBounds(rect);
      return true;
    } catch (cause) {
      await hide();
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    }
  }, [hide, rectOf, t]);

  /** 边界已经有效后才显示；任何异步返回都要核对请求版本。 */
  const showIfPossible = useCallback(
    async (token: number) => {
      if (token !== generation.current) return;
      if (!created.current) return;
      if (visible.current) return;
      const ok = await syncBounds();
      if (!ok || token !== generation.current) return;
      if (modalBlockedRef.current || useExtremeStore.getState().paneDragging) return;
      await opsApi.extremeBrowserShow(true).catch((cause: unknown) => {
        visible.current = false;
        setError(cause instanceof Error ? cause.message : String(cause));
      });
      if (token !== generation.current) {
        // 迟到的旧请求不能把网页盖回新对话 / 新标签。
        await hide();
        return;
      }
      visible.current = true;
    },
    [hide, syncBounds],
  );

  /** 打开 / 导航到地址；创建时后端只落 bounds 并保持隐藏。 */
  const openAt = useCallback(
    async (target: string) => {
      const token = generation.current;
      const rect = rectOf();
      if (!rect) {
        setError(t("网页区域太小或不可用"));
        return;
      }
      setBusy(true);
      setError(null);
      try {
        if (!created.current) {
          await opsApi.extremeBrowserOpen({
            url: target,
            session: `${workspaceId}:${token}`,
            ...rect,
          });
          created.current = true;
        } else {
          await opsApi.extremeBrowserNavigate(target, `${workspaceId}:${token}`);
        }
        if (token !== generation.current) return;
        current.current = target;
        await showIfPossible(token);
      } catch (cause) {
        if (token !== generation.current) return;
        created.current = false;
        await hide();
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (token === generation.current) setBusy(false);
      }
    },
    [hide, rectOf, showIfPossible, t, workspaceId],
  );

  /**
   * 切对话 / 换地址：先隐藏旧页面，再按新归属打开。
   *
   * `created` 重置为 false 也意味着下次 open 会重新落一次 bounds；子 WebView
   * 后端会复用同一个 label，不会泄漏窗口。
   */
  const lastWorkspace = useRef(workspaceId);
  useEffect(() => {
    const workspaceChanged = lastWorkspace.current !== workspaceId;
    if (workspaceChanged) {
      lastWorkspace.current = workspaceId;
      generation.current += 1;
      created.current = false;
      visible.current = false;
      navGuardUntil.current = Date.now() + 500;
      void opsApi.extremeBrowserShow(false).catch(() => undefined);
      setBusy(false);
      setError(null);
    }
    setAddress(url ?? "");
    if (!url) {
      void hide();
      return undefined;
    }
    // 同一对话里点链接 / 地址栏导航：当前页面已经在这个地址了，不重开。
    if (!workspaceChanged && url === current.current) return undefined;

    const token = generation.current;
    const frame = requestAnimationFrame(() => {
      if (token === generation.current) void openAt(url);
    });
    return () => cancelAnimationFrame(frame);
  }, [workspaceId, url, hide, openAt]);

  // 标签 / 对话卸载：立即隐藏（页面和地址由后端保留，下次复用）。
  useEffect(
    () => () => {
      generation.current += 1;
      visible.current = false;
      void opsApi.extremeBrowserShow(false).catch(() => undefined);
    },
    [],
  );

  // 尺寸 / 位置变化只更新 bounds；不重新导航，也不把已隐藏的网页重新显示。
  useEffect(() => {
    const node = hostRef.current;
    if (!node) return undefined;
    const observer = new ResizeObserver(() => {
      if (!created.current) return;
      void syncBounds();
    });
    observer.observe(node);
    const onResize = () => {
      if (created.current) void syncBounds();
    };
    window.addEventListener("resize", onResize);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", onResize);
    };
  }, [syncBounds]);

  // 拖动期间临时隐藏；边界落定后再显示（地址与页面都在）。
  useEffect(() => {
    if (!created.current) return undefined;
    if (paneDragging) {
      void hide();
      return undefined;
    }
    const token = generation.current;
    const frame = requestAnimationFrame(() => {
      void showIfPossible(token);
    });
    return () => cancelAnimationFrame(frame);
  }, [hide, paneDragging, showIfPossible]);

  // 外部导航（点网页里的链接 / 重定向）：地址栏跟上，并按对话记住。
  useEffect(() => {
    let disposed = false;
    const unlisten = listen<{ url: string; session: string }>(
      "extreme-browser-navigated",
      (event) => {
        const { url: next, session } = event.payload ?? {};
        if (disposed || typeof next !== "string" || !/^https?:\/\//i.test(next)) return;
        // 事件必须属于**当前对话 + 当前请求版本**：旧页面 / 旧对话的迟到导航不能盖回来。
        if (session !== `${workspaceId}:${generation.current}`) return;
        // 切对话后的短时间内旧页面可能还在发导航事件：不能盖回新页面。
        if (Date.now() < navGuardUntil.current) return;
        setAddress(next);
        current.current = next;
        onUrlChangeRef.current(next);
      },
    ).catch(() => undefined);
    return () => {
      disposed = true;
      void unlisten.then((stop) => stop?.());
    };
  }, [workspaceId]);

  /*
   * Modal 会盖在主 WebView 上，但子 WebView 是原生同级视图，会浮在最上面。
   * 监听 `aria-modal` 对话框：出现就隐藏网页，关掉再显示。
   */
  useEffect(() => {
    let frame = 0;
    const sync = () => {
      frame = 0;
      const blocked = Boolean(document.querySelector('[role="dialog"][aria-modal="true"]'));
      modalBlockedRef.current = blocked;
      setModalBlocked((value) => (value === blocked ? value : blocked));
    };
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(sync);
    };
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });
    schedule();
    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  useEffect(() => {
    if (!created.current) return undefined;
    if (modalBlocked) {
      void hide();
      return undefined;
    }
    const token = generation.current;
    const frame = requestAnimationFrame(() => {
      void showIfPossible(token);
    });
    return () => cancelAnimationFrame(frame);
  }, [hide, modalBlocked, showIfPossible]);

  const navigate = async (raw: string) => {
    const next = raw.trim();
    if (!/^https?:\/\//i.test(next)) {
      setError(t("只支持 http / https 网址"));
      return;
    }
    if (!created.current) {
      await openAt(next);
      onUrlChange(next);
      return;
    }

    const token = generation.current;
    setBusy(true);
    setError(null);
    try {
      await opsApi.extremeBrowserNavigate(next, `${workspaceId}:${token}`);
      if (token !== generation.current) return;
      current.current = next;
      onUrlChange(next);
      await showIfPossible(token);
    } catch (cause) {
      if (token !== generation.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (token === generation.current) setBusy(false);
    }
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div className="flex min-w-0 items-center gap-1 overflow-hidden border-b border-line/70 px-2 py-1.5">
        <Button
          variant="ghost"
          size="xs"
          aria-label={t("后退")}
          title={t("后退")}
          onClick={() => void opsApi.extremeBrowserHistory(-1).catch(() => undefined)}
        >
          <ChevronLeft size={13} />
        </Button>
        <Button
          variant="ghost"
          size="xs"
          aria-label={t("前进")}
          title={t("前进")}
          onClick={() => void opsApi.extremeBrowserHistory(1).catch(() => undefined)}
        >
          <ChevronRight size={13} />
        </Button>
        <Button
          variant="ghost"
          size="xs"
          aria-label={t("刷新")}
          title={t("刷新")}
          onClick={() => void opsApi.extremeBrowserReload().catch(() => undefined)}
        >
          <RefreshCw size={13} />
        </Button>
        <form
          className="flex min-w-0 flex-1 items-center gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            void navigate(address);
          }}
        >
          <Globe size={12} className="shrink-0 text-fg-subtle" />
          <input
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            placeholder={t("输入网址，回车打开")}
            aria-label={t("浏览器地址")}
            spellCheck={false}
            className="min-w-0 flex-1 rounded-[5px] border border-line bg-surface-1 px-2 py-0.5 font-mono text-10 text-fg outline-none focus:border-accent"
          />
        </form>
        <Button
          variant="ghost"
          size="xs"
          className="shrink-0"
          disabled={!current.current}
          aria-label={t("在 Chrome 中打开")}
          title={t("在 Chrome 中打开")}
          onClick={() => {
            if (current.current) void openUrl(current.current).catch(() => undefined);
          }}
        >
          <ArrowRight size={13} />
        </Button>
      </div>

      {error && (
        <p
          role="status"
          className="border-b border-danger/40 bg-danger/10 px-2 py-1 text-10 text-danger"
        >
          {error}
        </p>
      )}
      {/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])([:/]|$)/i.test(current.current || address) && (
        <p
          role="status"
          className="border-b border-warning/40 bg-warning/10 px-2 py-1 text-10 text-warning"
        >
          {t(
            "这是桌面客户端的本机地址；要访问服务器自己的 127.0.0.1，请先建立端口转发或改用可访问的地址。",
          )}
        </p>
      )}
      {busy && (
        <div className="border-b border-line/70 px-2 py-1 text-10 text-fg-subtle">
          {t("加载中…")}
        </div>
      )}

      <div ref={hostRef} className="relative min-h-0 flex-1 bg-surface-2">
        {!url && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-4 text-center text-11 text-fg-subtle">
            {t("网址会在这里打开；也可以直接输入地址。")}
          </div>
        )}
      </div>
    </div>
  );
}
