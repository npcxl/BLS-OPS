import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SplashScreen } from "../SplashScreen";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** jsdom 没有 matchMedia；Splash 与 StrokeText 都靠它判定 reduced-motion。 */
function stubMatchMedia(reducedMotion: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: reducedMotion && query.includes("prefers-reduced-motion"),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
  }));
}

describe("SplashScreen —— 开屏动画", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it("渲染 LOGO（在文字上方）与品牌名 aria，背景全屏白色", () => {
    stubMatchMedia(false);
    act(() => root.render(<SplashScreen onFinished={() => undefined} />));

    const splash = host.querySelector<HTMLElement>("[data-testid='splash-screen']");
    expect(splash).not.toBeNull();
    expect(splash?.getAttribute("aria-label")).toBe("Ops Workbench");
    expect(splash?.className).toContain("bg-white");

    // LOGO 在揭幕层里、位于文字上方；初始占位层 0 高 → 文字正中。
    const wrap = splash?.querySelector("[data-splash-logo-wrap]");
    const logo = wrap?.querySelector("img[data-splash-logo]");
    expect(logo?.getAttribute("src")).toBe("/logo.png");
    expect(wrap?.className).toContain("h-0");
    const textSvg = splash?.querySelector("svg");
    expect(logo && textSvg && logo.compareDocumentPosition(textSvg) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("点击（pointerdown）跳过动画 → onFinished 被调用", () => {
    stubMatchMedia(false);
    const onFinished = vi.fn();
    act(() => root.render(<SplashScreen onFinished={onFinished} />));

    const splash = host.querySelector("[data-testid='splash-screen']")!;
    act(() => {
      splash.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    });
    expect(onFinished).toHaveBeenCalledTimes(1);
  });

  it("prefers-reduced-motion：直接呈现终态（LOGO 可见），不再等待长动画", () => {
    stubMatchMedia(true);
    const onFinished = vi.fn();
    act(() => root.render(<SplashScreen onFinished={onFinished} />));

    const logo = host.querySelector("img[data-splash-logo]") as HTMLElement | null;
    if (!logo) throw new Error("splash logo missing");
    // gsap.set 写入内联样式 → 直接是终态：LOGO 可见、占位层已撑满。
    expect(logo.style.opacity).toBe("1");
    const wrap = host.querySelector("[data-splash-logo-wrap]") as HTMLElement;
    expect(wrap.style.height).toBe("96px");
  });
});
