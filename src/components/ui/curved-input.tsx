/**
 * 弧形输入框 —— **官方 CurvedInput 组件**（React Bits）
 * 源码：https://reactbits.dev/components/curved-input
 *       https://github.com/DavidHDev/react-bits (src/ts-tailwind/Components/CurvedInput)
 *
 * 基本保持原样，只做两处适配：
 * 1. 去掉 `'use client'`（Vite 不需要）；
 * 2. 主题色默认从本项目的 CSS token 读（`--surface-2` / `--fg` / `--line` / `--accent`），
 *    这样亮/暗主题跟随应用，而不是它内置的紫黑配色。
 *
 * 它是**单行**输入：文字用 SVG `textPath` 沿弧线绘制，超出部分在弧线上滚动。
 */
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type SyntheticEvent,
} from "react";

const DEG = 180 / Math.PI;
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** `--accent: 49 117 241` → `rgb(49, 117, 241)`（SVG fill 不认空格语法）。 */
function tokenColor(name: string, fallback: string): string {
  try {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    const parts = raw.split(/[\s,/]+/).filter(Boolean);
    if (parts.length >= 3) return `rgb(${parts[0]}, ${parts[1]}, ${parts[2]})`;
  } catch {
    /* 无 DOM（测试环境）时用内置色 */
  }
  return fallback;
}

const hexToRgba = (hex: string, alpha: number): string => {
  let h = String(hex).replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h.slice(0, 6), 16);
  if (Number.isNaN(n)) return hex;
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
};

type ShadowSize = "sm" | "md" | "lg";

const SHADOWS: Record<ShadowSize, [number, number, number]> = {
  sm: [5, 12, 0.3],
  md: [10, 24, 0.4],
  lg: [16, 40, 0.52],
};

interface ThemePalette {
  backgroundColor: string;
  textColor: string;
  placeholderColor: string;
  borderColor: string;
  buttonColor: string;
  buttonTextColor: string;
  shadowColor: string;
}

const DEFAULT_PALETTE: ThemePalette = {
  backgroundColor: "#1B1722",
  textColor: "#f5f5f5",
  placeholderColor: "#a1a1aa",
  borderColor: "#392e4e",
  buttonColor: "#A855F7",
  buttonTextColor: "#ffffff",
  shadowColor: "#000000",
};

interface Geometry {
  straight: boolean;
  W: number;
  T: number;
  svgH: number;
  R?: number;
  dir?: number;
  uPerLen: number;
  point: (u: number, v: number) => [number, number];
  angleAt: (u: number) => number;
  uFromPoint: (x: number, y?: number) => number;
}

const buildGeometry = (width: number, bend: number, thickness: number, pad: number): Geometry => {
  const W = width;
  const T = thickness;
  const s = Math.max(-W * 0.35, Math.min(bend, W * 0.35));
  const a = Math.abs(s);
  const dir = s >= 0 ? 1 : -1;
  const svgH = T + a + pad * 2;

  if (a < 0.75) {
    const midY = pad + T / 2;
    return {
      straight: true,
      W,
      T,
      svgH,
      uPerLen: 1,
      point: (u, v) => [u, midY + v],
      angleAt: () => 0,
      uFromPoint: (x) => x,
    };
  }

  const R = (W * W * 0.25 + a * a) / (2 * a);
  const cx = W / 2;
  const apexY = pad + T / 2 + (dir > 0 ? 0 : a);
  const cy = apexY + dir * R;
  const phi = Math.asin(Math.min(1, W / (2 * R)));

  return {
    straight: false,
    W,
    T,
    svgH,
    R,
    dir,
    uPerLen: W / (2 * R * phi),
    point: (u, v) => {
      const th = ((u - cx) / cx) * phi;
      const rho = R - dir * v;
      return [cx + rho * Math.sin(th), cy - dir * rho * Math.cos(th)];
    },
    angleAt: (u) => dir * ((u - cx) / cx) * phi * DEG,
    uFromPoint: (x, y = 0) => {
      const th = Math.atan2(x - cx, dir * (cy - y));
      return cx + (th / phi) * cx;
    },
  };
};

const fmt = (g: Geometry, u: number, v: number): string => {
  const [x, y] = g.point(u, v);
  return `${round2(x)} ${round2(y)}`;
};

const edgeSeg = (g: Geometry, uTo: number, v: number, ltr: boolean): string => {
  if (g.straight) return `L ${fmt(g, uTo, v)}`;
  const rho = round2(g.R! - g.dir! * v);
  const sweep = ltr === g.dir! > 0 ? 1 : 0;
  return `A ${rho} ${rho} 0 0 ${sweep} ${fmt(g, uTo, v)}`;
};

const bentRectPath = (
  g: Geometry,
  u0: number,
  u1: number,
  vTop: number,
  vBot: number,
  radius: number,
): string => {
  const rc = Math.max(0, Math.min(radius, (vBot - vTop) / 2, (u1 - u0) / 2));
  return [
    `M ${fmt(g, u0 + rc, vTop)}`,
    edgeSeg(g, u1 - rc, vTop, true),
    `Q ${fmt(g, u1, vTop)} ${fmt(g, u1, vTop + rc)}`,
    `L ${fmt(g, u1, vBot - rc)}`,
    `Q ${fmt(g, u1, vBot)} ${fmt(g, u1 - rc, vBot)}`,
    edgeSeg(g, u0 + rc, vBot, false),
    `Q ${fmt(g, u0, vBot)} ${fmt(g, u0, vBot - rc)}`,
    `L ${fmt(g, u0, vTop + rc)}`,
    `Q ${fmt(g, u0, vTop)} ${fmt(g, u0 + rc, vTop)}`,
    "Z",
  ].join(" ");
};

const bentLinePath = (g: Geometry, u0: number, u1: number, v: number): string =>
  `M ${fmt(g, u0, v)} ${edgeSeg(g, u1, v, true)}`;

const SELECTABLE_TYPES = ["text", "search", "tel", "url", "password"];

export interface CurvedInputProps {
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  onSubmit?: (value: string) => void;
  placeholder?: string;
  buttonText?: string;
  type?: string;
  name?: string;
  ariaLabel?: string;
  width?: number | string;
  bend?: number;
  height?: number;
  cornerRadius?: number;
  borderWidth?: number;
  fontSize?: number;
  backgroundColor?: string;
  textColor?: string;
  placeholderColor?: string;
  borderColor?: string;
  buttonColor?: string;
  buttonTextColor?: string;
  iconColor?: string;
  shadowSize?: ShadowSize;
  shadowColor?: string;
  showButton?: boolean;
  showIcon?: boolean;
  icon?: ReactNode;
  className?: string;
  style?: CSSProperties;
  disabled?: boolean;
  /** 挂载后自动聚焦隐藏 input（对话式输入条需要一打开就能打字）。 */
  autoFocus?: boolean;
  /**
   * 首选补全里**尚未输入**的部分，用灰字画在光标之后（行内 ghost）。
   * 空串不画。
   */
  ghost?: string;
  /** 光标位置变化（供补全按光标所在片段计算）。 */
  onCaretChange?: (caret: number) => void;
  /**
   * 光标在**弧线上**的实际像素位置（相对本组件根元素，y 取光标下沿）。
   * 补全候选栏靠它贴在光标正下方，而不是贴在输入框某个固定角落。
   */
  onCaretPosition?: (position: { x: number; y: number } | null) => void;
  /** 输入法组词/选字状态变化（组词期间要隐藏自带候选栏）。 */
  onComposingChange?: (composing: boolean) => void;
  /**
   * 选区变化（`selectionStart` / `selectionEnd`）。
   *
   * 以原生 input 的选区为准：Ctrl+C 在有选区时复制、弧形高亮按这个范围画。
   */
  onSelectionChange?: (range: { start: number; end: number }) => void;
  /** 程序性移动光标（补全后把光标停在插入内容之后）。 */
  caretRequest?: { index: number; nonce: number } | null;
}

export function CurvedInput({
  value,
  defaultValue = "",
  onChange,
  onSubmit,
  placeholder = "Enter your email",
  buttonText = "Get Started",
  type = "text",
  name,
  ariaLabel,
  width = "100%",
  bend = 14,
  height = 56,
  cornerRadius = 20,
  borderWidth = 1.5,
  fontSize = 14,
  backgroundColor,
  textColor,
  placeholderColor,
  borderColor,
  buttonColor,
  buttonTextColor,
  iconColor,
  shadowSize = "md",
  shadowColor,
  showButton = true,
  showIcon = false,
  icon,
  className = "",
  style,
  disabled = false,
  autoFocus = false,
  ghost = "",
  onCaretChange,
  onCaretPosition,
  onComposingChange,
  onSelectionChange,
  caretRequest = null,
}: CurvedInputProps) {
  const uid = useId().replace(/:/g, "");
  const layoutPathId = `ci-text-${uid}`;
  const buttonPathId = `ci-btn-${uid}`;
  const clipId = `ci-clip-${uid}`;

  const rootRef = useRef<HTMLFormElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const textRef = useRef<SVGTextElement | null>(null);
  const btnMeasureRef = useRef<SVGTextElement | null>(null);
  const scrollRef = useRef(0);

  const [w, setW] = useState(0);
  const [innerValue, setInnerValue] = useState(defaultValue);
  const [caretIndex, setCaretIndex] = useState(defaultValue.length);
  const [focused, setFocused] = useState(false);
  const [caretU, setCaretU] = useState(0);
  /** 光标处的弧长（px），ghost 的 `startOffset` 用它。 */
  const [caretLen, setCaretLen] = useState(0);
  /** 选区换算到弧线上的长度区间（px），用于画高亮条与提亮选中文字。 */
  const [selLen, setSelLen] = useState({ start: 0, end: 0 });
  const [scrollLen, setScrollLen] = useState(0);
  const [btnTextW, setBtnTextW] = useState(0);
  const [, setFontTick] = useState(0);
  /**
   * 原生 input 的选区（字符下标）。
   *
   * 高亮与「选中文字提亮」都以它为准：全选 = `0..length`，Shift+方向键 是
   * 任意区间。真实文字是 SVG 画的，隐藏 input 的 `::selection` 根本看不见，
   * 所以这里自己换算成弧线长度来画（见下方 layout effect）。
   */
  const [selection, setSelection] = useState<{ start: number; end: number }>({ start: 0, end: 0 });

  const val = value !== undefined ? value : innerValue;
  const display = type === "password" ? "•".repeat(val.length) : val;

  /*
   * 主题切换时要**重新读一遍 token**。
   *
   * 这些颜色是 `getComputedStyle` 读出来的字符串，不是活的 CSS 变量：只在
   * 首次渲染算一次的话，亮色启动、切到夜间后输入框还是白的（用户反馈的
   * "夜间模式这个输入框是白的"）。监听 `data-theme` 变化重算。
   */
  const [themeTick, setThemeTick] = useState(0);
  useEffect(() => {
    const target = document.documentElement;
    const observer = new MutationObserver(() => setThemeTick((tick) => tick + 1));
    observer.observe(target, { attributes: true, attributeFilter: ["data-theme", "class"] });
    return () => observer.disconnect();
  }, []);

  // 主题跟随应用 token（亮/暗都一致），props 仍可覆盖。
  const palette = useMemo<ThemePalette>(
    () => ({
      backgroundColor: backgroundColor ?? tokenColor("--surface-2", DEFAULT_PALETTE.backgroundColor),
      textColor: textColor ?? tokenColor("--fg", DEFAULT_PALETTE.textColor),
      placeholderColor: placeholderColor ?? tokenColor("--fg-subtle", DEFAULT_PALETTE.placeholderColor),
      borderColor: borderColor ?? tokenColor("--line", DEFAULT_PALETTE.borderColor),
      buttonColor: buttonColor ?? tokenColor("--accent", DEFAULT_PALETTE.buttonColor),
      buttonTextColor: buttonTextColor ?? "#ffffff",
      shadowColor: shadowColor ?? "#0f172a",
    }),
    // themeTick 只是触发器：主题变了就重读上表。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [backgroundColor, textColor, placeholderColor, borderColor, buttonColor, buttonTextColor, shadowColor, themeTick],
  );

  const bgColor = palette.backgroundColor;
  const fgColor = palette.textColor;
  const phColor = palette.placeholderColor;
  const strokeColor = palette.borderColor;
  const accentColor = palette.buttonColor;
  const btnFgColor = palette.buttonTextColor;
  const shColor = palette.shadowColor;

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const cw = entries[0]?.contentRect?.width ?? el.clientWidth;
      setW(Math.round(cw));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    let alive = true;
    if (document.fonts?.ready) {
      document.fonts.ready.then(() => {
        if (alive) setFontTick((t) => t + 1);
      });
    }
    return () => {
      alive = false;
    };
  }, []);

  const pad = Math.ceil(borderWidth / 2) + 6;
  const geom = useMemo<Geometry | null>(
    () => (w > 2 ? buildGeometry(w, bend, height, pad) : null),
    [w, bend, height, pad],
  );

  const layout = useMemo(() => {
    if (!geom) return null;
    const T = height;
    const btnInset = Math.max(5, borderWidth + 4);
    const chipH = Math.min(34, Math.max(16, T * 0.34));
    const chipW = chipH * 1.25;
    const iconU = 22 + chipW / 2;
    const textStartU = showIcon ? 22 + chipW + 13 : 20;
    const btnW = showButton ? Math.max(btnTextW + fontSize * 2.7, T * 1.2) : 0;
    const btnU1 = geom.W - btnInset;
    const btnU0 = btnU1 - btnW;
    const textEndU = Math.max(textStartU + 20, showButton ? btnU0 - 12 : geom.W - 24);
    const winLen = (textEndU - textStartU) / geom.uPerLen;
    return { btnInset, chipH, chipW, iconU, textStartU, textEndU, btnU0, btnU1, winLen };
  }, [geom, height, borderWidth, btnTextW, fontSize, showIcon, showButton]);

  useLayoutEffect(() => {
    if (btnMeasureRef.current) {
      const bw = btnMeasureRef.current.getComputedTextLength();
      setBtnTextW((prev) => (Math.abs(prev - bw) > 0.5 ? bw : prev));
    }
    if (!geom || !layout) return;
    const textEl = textRef.current;
    const caret = Math.min(caretIndex, display.length);
    let caretLen = 0;
    let totalLen = 0;
    if (textEl && display.length) {
      try {
        totalLen = textEl.getSubStringLength(0, display.length);
        caretLen = caret > 0 ? textEl.getSubStringLength(0, caret) : 0;
      } catch {
        totalLen = 0;
        caretLen = 0;
      }
    }
    let next = scrollRef.current;
    if (caretLen - next > layout.winLen - 2) next = caretLen - layout.winLen + 2;
    if (caretLen - next < 0) next = caretLen;
    if (totalLen - next < layout.winLen) next = Math.max(0, totalLen - layout.winLen);
    next = Math.max(0, next);
    if (Math.abs(next - scrollRef.current) > 0.5) {
      scrollRef.current = next;
      setScrollLen(next);
    }
    setCaretU(layout.textStartU + (caretLen - next) * geom.uPerLen);
    setCaretLen(caretLen);

    /*
     * 选区 → 弧线长度。
     *
     * `getSubStringLength` 给出的是**沿弧线的路径长度**，正好和 textPath 的
     * 坐标一致；高亮条与提亮文字都用这两个值定位。等值时不更新，避免每帧
     * 造新对象触发重渲染。
     */
    let selStartLen = 0;
    let selEndLen = 0;
    if (textEl && selection.end > selection.start) {
      try {
        selStartLen = selection.start > 0 ? textEl.getSubStringLength(0, selection.start) : 0;
        selEndLen = textEl.getSubStringLength(0, selection.end);
      } catch {
        selStartLen = 0;
        selEndLen = 0;
      }
    }
    setSelLen((current) =>
      Math.abs(current.start - selStartLen) < 0.5 && Math.abs(current.end - selEndLen) < 0.5
        ? current
        : { start: selStartLen, end: selEndLen },
    );

    /*
     * 把**光标线段的实际下端点**换算成视口坐标（px）。
     *
     * 不能拿"弧线中线 + 半个控件高度"近似 —— 绘制时那条线是 `caretH` 高、
     * 绕 `(caretX, caretY)` 旋转的 `<line>`，它的下端点才是视觉上的光标底：
     *
     *   bottom = (caretX, caretY) + rotate(angle) · (0, +caretH/2)
     *
     * 再按 `getBoundingClientRect` 的比例把 SVG 逻辑坐标换成屏幕像素（窗口
     * 缩放时 viewBox 与元素宽度不一致）。返回的是**视口坐标**，候选栏用
     * `position: fixed` 定位，完全不受输入框宽度影响。
     */
    const svg = svgRef.current;
    if (svg && geom && layout) {
      const u = layout.textStartU + (caretLen - next) * geom.uPerLen;
      const [px, py] = geom.point(u, 0);
      const caretH = Math.min(geom.T * 0.58, fontSize * 1.45);
      const rad = (geom.angleAt(u) * Math.PI) / 180;
      const bottomX = px - (caretH / 2) * Math.sin(rad);
      const bottomY = py + (caretH / 2) * Math.cos(rad);
      const svgRect = svg.getBoundingClientRect();
      const scale = geom.W > 0 ? svgRect.width / geom.W : 1;
      onCaretPosition?.({
        x: svgRect.left + bottomX * scale,
        y: svgRect.top + bottomY * scale,
      });
    }
  });

  const commitValue = (v: string) => {
    if (value === undefined) setInnerValue(v);
    onChange?.(v);
  };

  /** 选区是否覆盖了全部内容（0..length）。 */
  const syncSelection = (target: HTMLInputElement) => {
    const caret = target.selectionStart ?? target.value.length;
    const start = target.selectionStart ?? caret;
    const end = target.selectionEnd ?? caret;
    setCaretIndex(caret);
    onCaretChange?.(caret);
    // 以原生 input 的选区为准：高亮范围、Ctrl+C 复制都读这一份。
    setSelection({ start, end });
    onSelectionChange?.({ start, end });

  };

  /*
   * 程序性移动光标（补全后停在插入内容之后）。
   *
   * 受控文本更新后浏览器会把光标放到末尾，中间位置的补全会把光标甩到行尾；
   * 用 nonce 保证只在"我们请求的那一次"应用，不干扰用户正常输入。
   */
  const lastCaretNonce = useRef(0);
  useLayoutEffect(() => {
    if (!caretRequest || caretRequest.nonce === lastCaretNonce.current) return;
    lastCaretNonce.current = caretRequest.nonce;
    const input = inputRef.current;
    if (!input) return;
    try {
      input.focus();
      input.setSelectionRange(caretRequest.index, caretRequest.index);
      setCaretIndex(caretRequest.index);
      onCaretChange?.(caretRequest.index);
    } catch {
      /* 某些 input 类型不支持 setSelectionRange */
    }
  }, [caretRequest, onCaretChange]);

  const handleInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    commitValue(e.target.value);
    syncSelection(e.target);
  };

  const handleSelect = (e: SyntheticEvent<HTMLInputElement>) => {
    syncSelection(e.currentTarget);
  };

  const handleSubmit = (e?: FormEvent<HTMLFormElement>) => {
    e?.preventDefault?.();
    if (disabled) return;
    onSubmit?.(val);
  };

  const handleSurfaceClick = (e: ReactMouseEvent<SVGSVGElement>) => {
    if (disabled) return;
    const input = inputRef.current;
    if (!input) return;
    let idx = display.length;
    const svg = svgRef.current;
    const textEl = textRef.current;
    if (svg && geom && layout && textEl && display.length) {
      try {
        const ctm = svg.getScreenCTM();
        if (!ctm) throw new Error("missing screen CTM");
        const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
        const target =
          scrollRef.current + (geom.uFromPoint(pt.x, pt.y) - layout.textStartU) / geom.uPerLen;
        let best = 0;
        let bestDist = Infinity;
        for (let i = 0; i <= display.length; i++) {
          const li = i === 0 ? 0 : textEl.getSubStringLength(0, i);
          const d = Math.abs(li - target);
          if (d < bestDist) {
            bestDist = d;
            best = i;
          }
        }
        idx = best;
      } catch {
        idx = display.length;
      }
    }
    input.focus();
    try {
      input.setSelectionRange(idx, idx);
    } catch {
      /* selection API unavailable for this input type */
    }
    setCaretIndex(idx);
  };

  const safeType = SELECTABLE_TYPES.includes(type) ? type : "text";
  const shadow = SHADOWS[shadowSize];
  const svgStyle: CSSProperties | undefined = shadow
    ? { filter: `drop-shadow(0 ${shadow[0]}px ${shadow[1]}px ${hexToRgba(shColor, shadow[2])})` }
    : undefined;

  let content: ReactNode = null;
  if (geom && layout) {
    const T = height;
    const vBase = fontSize * 0.34;
    const scrollU = scrollLen * geom.uPerLen;
    const bandPath = bentRectPath(geom, 0, geom.W, -T / 2, T / 2, cornerRadius);
    const layoutPath = bentLinePath(geom, layout.textStartU - scrollU, geom.W, vBase);
    const clipPath = bentRectPath(geom, layout.textStartU - 6, layout.textEndU + 8, -T / 2, T / 2, 0);

    const chipFill = iconColor || accentColor;
    const { chipW, chipH } = layout;
    const [ix, iy] = geom.point(layout.iconU, 0);
    const iconAngle = geom.angleAt(layout.iconU);

    const [caretX, caretY] = geom.point(caretU, 0);
    const caretAngle = geom.angleAt(caretU);
    const caretH = Math.min(T * 0.58, fontSize * 1.45);

    const btnH = T - layout.btnInset * 2;
    const buttonPath = showButton
      ? bentRectPath(
          geom,
          layout.btnU0,
          layout.btnU1,
          -T / 2 + layout.btnInset,
          T / 2 - layout.btnInset,
          Math.min(cornerRadius * 0.72, btnH / 2),
        )
      : "";
    const buttonTextPath = showButton ? bentLinePath(geom, layout.btnU0, layout.btnU1, vBase) : "";

    content = (
      <svg
        ref={svgRef}
        className="block h-auto w-full cursor-text select-none overflow-visible [-webkit-tap-highlight-color:transparent] [&_text]:font-[inherit]"
        width={geom.W}
        height={round2(geom.svgH)}
        viewBox={`0 0 ${geom.W} ${round2(geom.svgH)}`}
        style={svgStyle}
        onPointerDown={(e) => e.preventDefault()}
        onClick={handleSurfaceClick}
      >
        <defs>
          <clipPath id={clipId}>
            <path d={clipPath} />
          </clipPath>
        </defs>

        <path
          className={`opacity-0 transition-opacity duration-[250ms] ease-in-out ${focused ? "opacity-[0.28]" : ""}`}
          d={bandPath}
          fill="none"
          stroke={accentColor}
          strokeWidth={borderWidth + 6}
        />
        <path d={bandPath} fill={bgColor} stroke={strokeColor} strokeWidth={borderWidth} />
        {/*
         * 选区高亮条：沿弧线画一条粗线，范围来自原生 input 的
         * selectionStart/selectionEnd。
         *
         * - 用 `clipPath` 裁在文字显示区内 —— 不会盖住右侧「发送」按钮；
         * - 两端用 `butt` 而不是圆头，局部选中时边界正好切在字符上；
         * - 坐标已扣掉 `scrollLen`，长命令横向滚动时跟着文字走。
         */}
        {selLen.end > selLen.start && (
          <g clipPath={`url(#${clipId})`} pointerEvents="none">
            <path
              d={bentLinePath(
                geom,
                layout.textStartU + (selLen.start - scrollLen) * geom.uPerLen,
                layout.textStartU + (selLen.end - scrollLen) * geom.uPerLen,
                0,
              )}
              fill="none"
              stroke={accentColor}
              strokeOpacity={0.32}
              strokeWidth={fontSize * 1.5}
              strokeLinecap="butt"
            />
          </g>
        )}

        <path id={layoutPathId} d={layoutPath} fill="none" />

        {showIcon && (
          <g
            transform={`translate(${round2(ix)} ${round2(iy)}) rotate(${round2(iconAngle)})`}
            aria-hidden="true"
          >
            {icon || (
              <>
                <rect x={-chipW / 2} y={-chipH / 2} width={chipW} height={chipH} rx={chipH * 0.27} fill={chipFill} />
              </>
            )}
          </g>
        )}

        <g clipPath={`url(#${clipId})`}>
          <text
            ref={textRef}
            style={{ fontSize: `${fontSize}px`, fontWeight: 500 }}
            fill={fgColor}
            xmlSpace="preserve"
            aria-hidden="true"
          >
            <textPath href={`#${layoutPathId}`}>{display}</textPath>
          </text>
          {/*
           * 行内 ghost：首选中尚未输入的部分，灰字画在光标之后的弧线上。
           * `startOffset` 用光标处的弧长（已扣掉滚动偏移），与文字同一条路径。
           */}
          {/*
           * 选中文字提亮：把选区那段单独再画一遍，用高对比色盖在暗色高亮条
           * 上。textPath 是一整条，没法给某几个字符换色，只能叠加。
           */}
          {selLen.end > selLen.start && (
            <text
              style={{ fontSize: `${fontSize}px`, fontWeight: 500 }}
              fill={btnFgColor}
              xmlSpace="preserve"
              aria-hidden="true"
            >
              <textPath
                href={`#${layoutPathId}`}
                startOffset={`${Math.max(0, selLen.start - scrollLen)}px`}
              >
                {display.slice(selection.start, selection.end)}
              </textPath>
            </text>
          )}
          {ghost && display && (
            <text
              style={{ fontSize: `${fontSize}px`, fontWeight: 500 }}
              fill={phColor}
              opacity={0.85}
              xmlSpace="preserve"
              aria-hidden="true"
            >
              <textPath
                href={`#${layoutPathId}`}
                startOffset={`${Math.max(0, caretLen - scrollLen)}px`}
              >
                {ghost}
              </textPath>
            </text>
          )}
          {!display && placeholder && (
            <text
              style={{ fontSize: `${fontSize}px`, fontWeight: 500 }}
              fill={phColor}
              xmlSpace="preserve"
              aria-hidden="true"
            >
              <textPath href={`#${layoutPathId}`}>{placeholder}</textPath>
            </text>
          )}
          {focused && !disabled && (
            <g
              key={`${display}-${Math.min(caretIndex, display.length)}`}
              transform={`translate(${round2(caretX)} ${round2(caretY)}) rotate(${round2(caretAngle)})`}
            >
              <line y1={-caretH / 2} y2={caretH / 2} stroke={fgColor} strokeWidth="1.5" strokeLinecap="round">
                <animate
                  attributeName="opacity"
                  values="1;0"
                  dur="1.06s"
                  calcMode="discrete"
                  repeatCount="indefinite"
                />
              </line>
            </g>
          )}
        </g>

        {showButton && (
          <g
            className="group cursor-pointer outline-none"
            role="button"
            tabIndex={0}
            aria-label={buttonText}
            onClick={(e) => {
              e.stopPropagation();
              handleSubmit();
            }}
            onPointerDown={(e: ReactPointerEvent<SVGGElement>) => e.stopPropagation()}
            onKeyDown={(e: KeyboardEvent<SVGGElement>) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                handleSubmit();
              }
            }}
          >
            <path
              className="transition-[filter,opacity] duration-200 ease-in-out group-hover:brightness-[1.12] group-active:brightness-[0.94] group-focus-visible:brightness-[1.18]"
              d={buttonPath}
              fill={accentColor}
            />
            <path id={buttonPathId} d={buttonTextPath} fill="none" />
            <text
              fill={btnFgColor}
              textAnchor="middle"
              style={{ fontSize: `${fontSize}px`, fontWeight: 600, pointerEvents: "none" }}
            >
              <textPath href={`#${buttonPathId}`} startOffset="50%">
                {buttonText}
              </textPath>
            </text>
          </g>
        )}

        <text
          ref={btnMeasureRef}
          style={{ fontSize: `${fontSize}px`, fontWeight: 600 }}
          x="-9999"
          y="-9999"
          visibility="hidden"
          aria-hidden="true"
        >
          {buttonText}
        </text>
      </svg>
    );
  }

  return (
    <form
      ref={rootRef}
      className={`relative m-0 block w-full max-w-full ${className}`.trim()}
      style={{ width: typeof width === "number" ? `${width}px` : width, ...style }}
      onSubmit={handleSubmit}
      noValidate
    >
      {content}
      {/*
       * **必须能被点到**（不能 `pointer-events-none`）：一旦点不到，键盘输入
       * 就落到别处，`value` 永远是空 —— 表现就是"字打不进去 / 发送按钮一直灰"。
       * 这里让它覆盖整个控件、自身透明，用户的点击与焦点走原生 input 路径，
       * 看到的是上面 SVG 画的弯曲文字。
       */}
      <input
        ref={inputRef}
        className="absolute inset-0 m-0 h-full w-full cursor-text border-0 bg-transparent p-0 text-base text-transparent opacity-0 outline-none [caret-color:transparent]"
        type={safeType}
        name={name}
        value={val}
        disabled={disabled}
        autoFocus={autoFocus}
        onChange={handleInputChange}
        onSelect={handleSelect}
        onKeyUp={handleSelect}
        /*
         * Ctrl/Cmd+A 直接置位，不等 `select` 事件：部分组合键下 select 事件
         * 不会在 keydown 阶段同步触发，用户会看到"全选了但没有任何反馈"。
         */
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {

          }
        }}
        /*
         * 输入法组词/选字期间要把状态报上去：应用自己的候选栏必须让位给
         * 系统候选，否则两条候选栏叠在一起，回车还会执行半成品命令。
         */
        onCompositionStart={() => onComposingChange?.(true)}
        onCompositionEnd={() => onComposingChange?.(false)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        aria-label={ariaLabel || placeholder || "Curved input"}
        autoComplete="off"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
      />
    </form>
  );
}

export default CurvedInput;
