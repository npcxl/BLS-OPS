import { useEffect, useMemo, useRef } from "react";
import { gsap } from "gsap";
import StrokeText from "@/components/ui/StrokeText";

/**
 * 软件开屏动画 —— 应用启动时的全屏过渡层（盖在 Workbench 上，数据加载与
 * 动画并行，动画结束整屏淡出后由父组件卸载）。
 *
 * 时序（与 StrokeText 内部节奏对齐，fillDuration = drawDuration * 0.5）：
 * ```
 * 0s    只有文字，整体正中；逐字描边起笔
 * 1.6s  描边完成
 * 1.8s  填充从左到右擦入（0.8s）
 * 2.1s  LOGO 揭幕：占位层从 0 长高，把文字挤下去，整组始终保持居中（0.7s）
 * 3.4s  整屏淡出（0.55s）→ onFinished
 * ```
 *
 * - 背景白色是产品裁决（开屏是品牌瞬间，不随主题）；文字颜色运行时从
 *   tokens 读取（`--accent` 描边 / `--fg` 填充），跟随亮暗主题不写死色值；
 * - `prefers-reduced-motion`：跳过动画直接呈现终态，短暂停留即淡出；
 * - 点击或按任意键可跳过（快进到淡出）。
 */

/** 与 StrokeText 节奏对齐的关键帧（秒）。 */
const LOGO_ENTER_AT = 2.1;
const FADE_OUT_AT = 3.4;
/** LOGO 显示尺寸与文字间距（px）—— 占位层动画的终值，与 JSX 的 Tailwind 类一致。 */
const LOGO_SIZE = 96;
const LOGO_GAP = 28;
const BRAND = "Ops Workbench";

/** SVG 的 presentation attribute 不解析 `var()`，这里运行时读出令牌值拼成具体色。 */
function tokenColor(name: string): string {
  try {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return raw ? `rgb(${raw})` : "currentColor";
  } catch {
    return "currentColor";
  }
}

export function SplashScreen({ onFinished }: { onFinished: () => void }) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const finishedRef = useRef(false);
  // onFinished 只在动画末尾/跳过时调用一次，用 ref 解除 effect 对 props 的依赖。
  const onFinishedRef = useRef(onFinished);
  onFinishedRef.current = onFinished;

  // 开屏只读一次主题色（Splash 存续期间主题不会变，也没必要响应）。
  const colors = useMemo(() => ({ accent: tokenColor("--accent"), fg: tokenColor("--fg") }), []);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    const wrap = root.querySelector("[data-splash-logo-wrap]");
    const logo = root.querySelector("[data-splash-logo]");
    if (!wrap || !logo) return undefined;

    const finish = () => {
      if (finishedRef.current) return;
      finishedRef.current = true;
      onFinishedRef.current();
    };

    const prefersReducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (prefersReducedMotion) {
      // 终态：占位层撑满、LOGO 直接呈现，短停留后淡出。
      gsap.set(wrap, { height: LOGO_SIZE, marginBottom: LOGO_GAP });
      gsap.set(logo, { opacity: 1, y: 0, scale: 1 });
      const call = gsap.delayedCall(0.9, finish);
      return () => {
        call.kill();
      };
    }

    const timeline = gsap.timeline();
    // 揭幕 = 占位层长高（0 → 96px + 间距）：flex 容器始终 justify-center，
    // 每一帧整组都会重新居中 —— 文字是被"平滑挤下去"的，不是跳变。
    timeline.fromTo(
      wrap,
      { height: 0, marginBottom: 0 },
      { height: LOGO_SIZE, marginBottom: LOGO_GAP, duration: 0.7, ease: "power3.out" },
      LOGO_ENTER_AT,
    );
    timeline.fromTo(
      logo,
      { opacity: 0, y: 14, scale: 0.86 },
      { opacity: 1, y: 0, scale: 1, duration: 0.7, ease: "power3.out" },
      LOGO_ENTER_AT,
    );
    timeline.to(root, { opacity: 0, duration: 0.55, ease: "power1.inOut", onComplete: finish }, FADE_OUT_AT);

    // 跳过：快进到末尾（触发 onComplete → finish → 卸载）。
    const skip = () => timeline.progress(1);
    root.addEventListener("pointerdown", skip);
    window.addEventListener("keydown", skip);
    return () => {
      root.removeEventListener("pointerdown", skip);
      window.removeEventListener("keydown", skip);
      timeline.kill();
    };
  }, []);

  return (
    <div
      ref={rootRef}
      role="status"
      aria-label={BRAND}
      data-testid="splash-screen"
      className="fixed inset-0 z-[200] flex cursor-default flex-col items-center justify-center bg-white"
    >
      {/* LOGO 揭幕层：初始 0 高（第一帧起就不占位，文字正中），进场时长到
          LOGO_SIZE 把文字挤下去 —— overflow-hidden 让图片从裁切边缘"升出"。 */}
      <div data-splash-logo-wrap className="h-0 overflow-hidden">
        <img
          src="/logo.png"
          alt=""
          data-splash-logo
          draggable={false}
          className="h-24 w-24 opacity-0"
        />
      </div>
      {/* StrokeText 的 SVG 铺满容器宽，限定一个开屏合适的宽度让文字居中。 */}
      <div className="w-full max-w-[640px] px-6">
        <StrokeText
          text={BRAND}
          strokeColor={colors.accent}
          fillColor={colors.fg}
          strokeWidth={1.2}
          drawDuration={1.6}
          fillDelay={0.2}
          stagger={0.05}
          ease="power2.out"
          trigger="mount"
          fillMode="wipe"
          fontSize={64}
          fontWeight={800}
          letterSpacing={-2}
        />
      </div>
    </div>
  );
}
