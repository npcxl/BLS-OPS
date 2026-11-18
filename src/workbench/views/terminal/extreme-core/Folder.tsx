import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";

/**
 * 文件夹（对齐 React Bits 的 Folder：flap 模式 + 弹簧动画）。
 *
 * 动画全部保留：
 * * **intro** —— 第一次出现时，纸页从上方错落落进文件夹；
 * * **peek** —— 合着的时候鼠标靠近，纸页会微微探出；
 * * **开合** —— 前盖以底边为轴向前倒下（-64°），纸页按各自的倾角扇形摊开；
 * * **悬停** —— 摊开的纸页单独抬起（位移 + 放大 + 阴影）；
 * * **倾斜** —— 指针在文件夹上移动时整体做轻微视差。
 *
 * 组件本身**只做显示**：点纸页触发 `onItemClick`，右键触发 `onContextMenu`，
 * 其它交互（重命名、删除、预览）由外层决定。
 */

export interface FolderItem {
  /** 纸页上的标题（文件名）。 */
  title?: string;
  /** 第二行（大小 / 来源）。 */
  description?: string;
  /** 自定义内容（给了就不画默认纸页）。 */
  content?: ReactNode;
}

export interface FolderProps {
  items: FolderItem[];
  /** 顶部标签（文件夹名）。 */
  label?: string;
  /** 主色。 */
  color?: string;
  /** 纸页底色。 */
  paperColor?: string;
  /** 整体缩放（1 = 224×176）。 */
  size?: number;
  /** 展开方式：点封面 / 悬停。 */
  openOn?: "click" | "hover";
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  onItemClick?: (item: FolderItem, index: number) => void;
  onItemContextMenu?: (item: FolderItem, index: number, event: ReactMouseEvent) => void;
  /** 首次出现的落入动画。 */
  intro?: boolean;
  theme?: "dark" | "light";
  className?: string;
  style?: CSSProperties;
}

/* ── 与官方一致的几何与姿态表 ─────────────────────────────────────── */

const FLAP_ANGLE = { open: -64, rest: 0 };
const FLAP_REST = [
  { x: 0.16, rise: 0, r: 3 },
  { x: -0.17, rise: 0.05, r: -3.5 },
  { x: 0, rise: 0.1, r: 0.5 },
  { x: 0.25, rise: 0.08, r: 5 },
  { x: -0.25, rise: 0.09, r: -5.5 },
  { x: 0.08, rise: 0.12, r: 1.5 },
];
const SPREAD_TURN = [4, -5, 3, -6, 5, -3];
const SPREAD_DROP = [0.03, -0.04, 0.05, -0.02, 0.04, -0.05];
const TAU = Math.PI * 2;
const STEP = 1 / 240;
const MAX_ITEMS = 6;

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

interface Spring {
  value: number;
  velocity: number;
}

const spring = (value: number): Spring => ({ value, velocity: 0 });

/** 弹簧积分（与官方同一套半隐式欧拉，分步长跑）。 */
function integrate(item: Spring, target: number, omega: number, zeta: number, dt: number) {
  const k = omega * omega;
  const d = 2 * zeta * omega;
  const steps = Math.max(1, Math.ceil(dt / STEP));
  const step = dt / steps;
  for (let i = 0; i < steps; i += 1) {
    item.velocity += (k * (target - item.value) - d * item.velocity) * step;
    item.value += item.velocity * step;
  }
  return Math.abs(target - item.value) > 0.01 || Math.abs(item.velocity) > 0.01;
}

function snap(item: Spring, value: number) {
  item.value = value;
  item.velocity = 0;
}

function parseColor(value: string): [number, number, number] {
  if (typeof document === "undefined") return [61, 139, 255];
  const canvas = document.createElement("canvas").getContext("2d", {
    willReadFrequently: true,
  });
  if (!canvas) return [61, 139, 255];
  canvas.fillStyle = "#3d8bff";
  canvas.fillStyle = value;
  canvas.fillRect(0, 0, 1, 1);
  return Array.from(canvas.getImageData(0, 0, 1, 1).data.slice(0, 3)) as [
    number,
    number,
    number,
  ];
}

const mix = (rgb: [number, number, number], target: [number, number, number], amount: number) =>
  rgb.map((channel, index) => Math.round(channel + (target[index] - channel) * amount)) as [
    number,
    number,
    number,
  ];
const css = (rgb: [number, number, number]) => `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
const luma = (rgb: [number, number, number]) =>
  (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;

/** 文件夹背板的形状：顶部带一个标签缺口。 */
function backPath(g: ReturnType<typeof measure>) {
  const { w, h, tabX, tabW, tabH, shoulder } = g;
  const top = tabH;
  const bottom = tabH + h;
  return [
    `M 0 ${top + g.r}`,
    `Q 0 ${top} ${g.r} ${top}`,
    `L ${tabX - shoulder} ${top}`,
    `C ${tabX} ${top} ${tabX} 0 ${tabX + shoulder} 0`,
    `L ${tabX + tabW - shoulder} 0`,
    `C ${tabX + tabW} 0 ${tabX + tabW} ${top} ${tabX + tabW + shoulder} ${top}`,
    `L ${w - g.r} ${top}`,
    `Q ${w} ${top} ${w} ${top + g.r}`,
    `L ${w} ${bottom - g.r}`,
    `Q ${w} ${bottom} ${w - g.r} ${bottom}`,
    `L ${g.r} ${bottom}`,
    `Q 0 ${bottom} 0 ${bottom - g.r}`,
    "Z",
  ].join(" ");
}

function measure(scale: number, labelWidth: number, hasLabel: boolean) {
  const w = 224 * scale;
  const h = 176 * scale;
  const tabH = 20 * scale;
  const r = 12 * scale;
  const shoulder = tabH * 0.75;
  const frontTop = tabH + h * 0.3;
  const maxTab = w - r * 2 - shoulder * 2 - 10 * scale;
  const tabW = clamp(hasLabel ? labelWidth + 14 * scale + shoulder : w * 0.34, w * 0.3, maxTab);
  const tabX = w - r - 5 * scale - shoulder - tabW;
  const docW = w * 0.54;
  return {
    scale,
    w,
    h,
    tabH,
    r,
    shoulder,
    tabX,
    tabW,
    frontTop,
    frontH: tabH + h - frontTop,
    docW,
    docH: docW * 1.22,
  };
}

/* ── 纸页 ──────────────────────────────────────────────────────── */

function DocumentCard({
  title,
  description,
  ink,
  strong,
  text,
  scale,
}: {
  title?: string;
  description?: string;
  ink: string;
  strong: string;
  text: string;
  scale: number;
}) {
  const line = (width: string) => (
    <span
      style={{
        height: 4 * scale,
        width,
        borderRadius: 2 * scale,
        background: ink,
        display: "block",
        flex: "none",
      }}
    />
  );
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6 * scale,
        padding: `${14 * scale}px ${13 * scale}px`,
        height: "100%",
        boxSizing: "border-box",
      }}
    >
      {title ? (
        <span
          style={{
            color: text,
            fontSize: 11 * scale,
            fontWeight: 600,
            lineHeight: 1.2,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            marginBottom: 4 * scale,
          }}
        >
          {title}
        </span>
      ) : (
        <span
          style={{
            height: 7 * scale,
            width: "56%",
            borderRadius: 4 * scale,
            background: strong,
            display: "block",
            flex: "none",
            marginBottom: 4 * scale,
          }}
        />
      )}
      {description && (
        <span
          style={{
            color: strong,
            fontSize: 9 * scale,
            lineHeight: 1.3,
            marginTop: -6 * scale,
            marginBottom: 4 * scale,
          }}
        >
          {description}
        </span>
      )}
      {line("92%")}
      {line("84%")}
      {line("88%")}
      <span
        style={{
          height: 40 * scale,
          margin: `${3 * scale}px 0`,
          borderRadius: 5 * scale,
          background: ink,
          opacity: 0.75,
          display: "block",
          flex: "none",
        }}
      />
      {line("80%")}
      {line("62%")}
    </div>
  );
}

/* ── 主体 ──────────────────────────────────────────────────────── */

export function Folder({
  items,
  label,
  color = "#3d8bff",
  paperColor = "#ffffff",
  size = 1,
  openOn = "click",
  open,
  defaultOpen = false,
  onOpenChange,
  onItemClick,
  onItemContextMenu,
  intro = true,
  theme = "dark",
  className = "",
  style,
}: FolderProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const backRef = useRef<HTMLDivElement>(null);
  const frontRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);
  const measureRef = useRef<HTMLSpanElement>(null);

  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const [labelWidth, setLabelWidth] = useState(0);
  const isOpen = open === undefined ? internalOpen : open;

  const scale = clamp(Number(size) || 1, 0.3, 3);
  const rgb = useMemo(() => parseColor(color), [color]);
  const paper = useMemo(() => parseColor(paperColor), [paperColor]);
  const backTone = mix(rgb, [0, 0, 0], 0.16);
  const insideTop = css(mix(rgb, [0, 0, 0], 0.08));
  const insideBottom = css(backTone);
  const g = useMemo(
    () => measure(scale, labelWidth, Boolean(label)),
    [scale, labelWidth, label],
  );
  const total = g.tabH + g.h;
  const entries = items.slice(0, MAX_ITEMS);

  /* 供 rAF 读的“最新设置”，避免闭包拿到旧值。 */
  const settings = useRef({
    open: isOpen,
    openOn,
    count: entries.length,
    g,
    rgb,
    intro,
    theme,
  });
  settings.current = { open: isOpen, openOn, count: entries.length, g, rgb, intro, theme };

  /** 引擎的唤醒函数：外部改 `open` 时用它，而不是自己去派发假事件。 */
  const wakeRef = useRef<() => void>(() => undefined);

  const setOpenRef = useRef<(next: boolean) => void>(() => undefined);
  const setOpen = useCallback(
    (next: boolean) => {
      if (next === isOpen) return;
      if (open === undefined) setInternalOpen(next);
      onOpenChange?.(next);
    },
    [isOpen, open, onOpenChange],
  );
  setOpenRef.current = setOpen;

  /* 标签宽度：字体加载完要重新量一次（否则标签会偏窄）。 */
  useEffect(() => {
    const node = measureRef.current;
    if (!node) return undefined;
    let active = true;
    const read = () => active && setLabelWidth(node.offsetWidth);
    read();
    document.fonts?.ready.then(read);
    return () => {
      active = false;
    };
  }, [label, scale]);

  /* 动画引擎：一次 rAF 只写 transform，不在 React 里 setState。 */
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

    const state = {
      raf: 0,
      last: 0,
      ready: false,
      hovered: false,
      pointerX: 0,
      pointerY: 0,
      hoveredItem: -1,
      open: false,
      closedAt: 0,
      front: spring(0),
      rx: spring(0),
      ry: spring(0),
      lift: spring(0),
      items: [] as {
        x: Spring;
        y: Spring;
        r: Spring;
        s: Spring;
        hover: Spring;
        alpha: Spring;
      }[],
      introStart: 0,
      introDone: !settings.current.intro || reduce,
    };

    const ensure = (count: number) => {
      while (state.items.length < count) {
        state.items.push({
          x: spring(0),
          y: spring(0),
          r: spring(0),
          s: spring(1),
          hover: spring(0),
          alpha: spring(1),
        });
      }
      state.items.length = count;
    };

    /** 合着时的姿态（peek 时探出一点）。 */
    const restSlot = (rank: number, peek: number) => {
      const { g: geo } = settings.current;
      const base =
        FLAP_REST[rank] ?? { x: 0, rise: 0.1, r: SPREAD_TURN[rank % 6] ?? 0 };
      const part = 1 + peek * 0.3;
      const floor = geo.tabH + geo.h - 5 * geo.scale - geo.docH / 2;
      return {
        x: geo.w / 2 + base.x * geo.w * part,
        y: floor - (base.rise + peek * 0.1) * geo.h,
        r: base.r * (1 + peek * 0.6),
        s: 1,
      };
    };

    /** 摊开时的姿态：纸页按各自的倾角扇形排开。 */
    const spreadSlot = (rank: number, count: number) => {
      const { g: geo } = settings.current;
      const gap = 12 * geo.scale;
      // 摊开的纸页总宽收在背板宽度内：原来按 2.3 倍背板宽铺，纸页会从蓝色
      // 文件夹里"溢"出去，看起来像散落的卡片而不是被夹住的附件。
      const fit = Math.min(0.94, (geo.w - gap * (count - 1)) / Math.max(1, count * geo.docW));
      const step = geo.docW * fit + gap;
      const mid = (count - 1) / 2;
      return {
        x: geo.w / 2 + (rank - mid) * step,
        y: geo.tabH - geo.h * 0.02 + (SPREAD_DROP[rank] ?? 0) * geo.h * 0.7,
        r: (SPREAD_TURN[rank] ?? 0) * 0.55,
        s: fit,
      };
    };

    const write = () => {
      const { g: geo, open: opened } = settings.current;
      const front = frontRef.current;
      if (stageRef.current) {
        stageRef.current.style.transform = `rotateX(${state.rx.value}deg) rotateY(${state.ry.value}deg) scale(${
          (1 + state.lift.value * 0.012) * 0.98
        })`;
      }
      if (front) {
        const theta = state.front.value;
        front.style.transform = `translate3d(0, ${geo.tabH + geo.h}px, 2px) rotateX(${theta}deg) translate3d(0, ${
          -geo.frontH
        }px, 0)`;
        const facing = Math.sin((-theta * Math.PI) / 180) * 0.5 + Math.cos((theta * Math.PI) / 180) * 0.86;
        front.style.setProperty("--glint", clamp((facing - 1) * 0.9, 0, 0.18).toFixed(3));
        front.style.setProperty("--dim", clamp((1 - facing) * 0.22, 0, 0.5).toFixed(3));
        // 闭合时给封面留一圈蓝色外轮廓：打开到一半以后前盖朝向背面，
        // 这圈光要收掉，否则会落在纸页上显得脏。
        front.style.setProperty("--edge", clamp(facing, 0, 1).toFixed(3));
        front.style.zIndex = theta < -45 ? "6" : "40";
      }
      state.items.forEach((item, index) => {
        const node = itemRefs.current[index];
        if (!node) return;
        // 姿态里的 (x, y) 是纸页**中心**（与官方矩阵一致）：先减去半宽半高。
        node.style.transform = `translate3d(${item.x.value - geo.docW / 2}px, ${
          item.y.value - geo.docH / 2
        }px, ${3 + item.hover.value * 26}px) rotate(${item.r.value}deg) scale(${
          item.s.value * (1 + item.hover.value * 0.05)
        })`;
        node.style.opacity = item.alpha.value < 0.999 ? item.alpha.value.toFixed(3) : "";
        node.style.zIndex = String(
          state.hoveredItem === index && opened ? 60 : 10 + settings.current.count - index,
        );
        node.style.setProperty("--lift", clamp(item.hover.value, 0, 1.6).toFixed(3));
      });
    };

    const frame = (now: number) => {
      state.raf = 0;
      const { count, g: geo, open: opened, openOn: on } = settings.current;
      ensure(count);
      const time = now / 1000;
      const dt = state.last ? Math.min(0.05, (now - state.last) / 1000) : 1 / 60;
      state.last = now;

      if (state.open !== opened) {
        state.open = opened;
        state.closedAt = now;
      }

      const zeta = reduce ? 1 : 0.62;
      const frontOmega = TAU * 2;
      const itemOmega = TAU * 2.1;
      let busy = false;

      // 开合：前盖
      busy = integrate(state.front, opened ? FLAP_ANGLE.open : FLAP_ANGLE.rest, frontOmega, zeta, dt) || busy;

      // 整体倾斜 / 抬起
      const engaged = state.hovered && !reduce;
      busy = integrate(state.rx, engaged ? -state.pointerY * 8 * 0.5 : 0, TAU * 1.6, 1, dt) || busy;
      busy = integrate(state.ry, engaged ? state.pointerX * 10 * 0.5 : 0, TAU * 1.6, 1, dt) || busy;
      busy = integrate(state.lift, state.hovered && !opened ? 1 : 0, TAU * 1.6, 1, dt) || busy;

      // 首次落入
      if (!state.introDone) {
        if (!state.introStart) state.introStart = time;
        const elapsed = time - state.introStart;
        const span = 0.5 + count * 0.085;
        if (elapsed > span + 0.2) state.introDone = true;
        else busy = true;
      }

      state.items.forEach((item, rank) => {
        const peek = !opened && state.hovered && on === "hover" ? 1 : 0;
        const slot = opened ? spreadSlot(rank, count) : restSlot(rank, peek);
        let targetY = slot.y;
        let targetR = slot.r;
        let targetS = slot.s;
        let alpha = 1;

        if (!state.introDone && !opened) {
          // 从上方错落落进文件夹。
          const delay = 0.16 + (count - 1 - rank) * 0.085;
          const progress = clamp((time - state.introStart - delay) / 0.42, 0, 1);
          if (progress < 1) {
            targetY = slot.y - (geo.h * 0.8 + geo.docH * 0.5) * (1 - progress);
            targetR = slot.r + (rank % 2 ? 9 : -7) * (1 - progress);
            alpha = progress;
            busy = true;
          }
        }

        const hovered = state.hoveredItem === rank && opened;
        busy = integrate(item.x, slot.x, itemOmega, zeta, dt) || busy;
        busy = integrate(item.y, targetY + (hovered ? -6 * geo.scale : 0), itemOmega, zeta, dt) || busy;
        busy = integrate(item.r, hovered ? 0 : targetR, itemOmega, zeta, dt) || busy;
        busy = integrate(item.s, targetS, itemOmega, zeta, dt) || busy;
        busy = integrate(item.hover, hovered ? 1 : 0, TAU * 2.4, 0.8, dt) || busy;
        busy = integrate(item.alpha, alpha, TAU * 3, 1, dt) || busy;
      });

      write();

      // 第一次：直接落到目标姿态（避免首帧从 (0,0) 飞来）。
      if (!state.ready) {
        state.ready = true;
        snap(state.front, opened ? FLAP_ANGLE.open : FLAP_ANGLE.rest);
        state.items.forEach((item, rank) => {
          const slot = opened ? spreadSlot(rank, count) : restSlot(rank, 0);
          snap(item.x, slot.x);
          snap(item.y, slot.y);
          snap(item.r, slot.r);
          snap(item.s, slot.s);
          snap(item.alpha, state.introDone ? 1 : 0);
        });
        write();
      }

      if (busy) state.raf = requestAnimationFrame(frame);
      else state.last = 0;
    };

    const wake = () => {
      if (!state.raf) state.raf = requestAnimationFrame(frame);
    };
    wakeRef.current = wake;

    const onMove = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      const box = root.getBoundingClientRect();
      state.pointerX = clamp(((event.clientX - box.left) / box.width) * 2 - 1, -1.5, 1.5);
      state.pointerY = clamp(((event.clientY - box.top) / box.height) * 2 - 1, -1.5, 1.5);
      const target = (event.target as Element | null)?.closest?.("[data-folder-item]");
      const index =
        target && root.contains(target) ? Number(target.getAttribute("data-folder-item")) : -1;
      state.hoveredItem = Number.isFinite(index) ? index : -1;
      if (!state.hovered) {
        state.hovered = true;
        if (settings.current.openOn === "hover") setOpenRef.current(true);
      }
      wake();
    };

    const onLeave = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      state.hovered = false;
      state.hoveredItem = -1;
      if (settings.current.openOn === "hover") setOpenRef.current(false);
      wake();
    };

    root.addEventListener("pointermove", onMove);
    root.addEventListener("pointerleave", onLeave);
    wake();

    return () => {
      cancelAnimationFrame(state.raf);
      root.removeEventListener("pointermove", onMove);
      root.removeEventListener("pointerleave", onLeave);
    };
  }, []);

  // 外部改变 open：唤醒引擎（内部状态机自己会走向目标角度）。
  useEffect(() => {
    wakeRef.current();
  }, [isOpen]);

  const toggle = () => {
    if (openOn === "hover") return;
    setOpen(!isOpen);
  };

  const ink = css(mix(paper, [0, 0, 0], 0.11));
  const strong = css(mix(paper, [0, 0, 0], 0.28));
  const text = css(mix(paper, [0, 0, 0], 0.72));
  const shape = backPath(g);

  const vars = {
    "--folder-tab-ink": luma(backTone) > 0.6 ? "rgba(0,0,0,0.72)" : "rgba(255,255,255,0.92)",
    width: g.w,
    height: total,
  } as CSSProperties;

  return (
    <div
      ref={rootRef}
      data-folder-root=""
      data-open={isOpen ? "" : undefined}
      data-theme={theme}
      className={`relative inline-block select-none align-middle [-webkit-tap-highlight-color:transparent] ${className}`.trim()}
      style={{ ...vars, ...style }}
    >
      <div
        className="absolute inset-0 isolate cursor-pointer outline-none"
        role="button"
        tabIndex={0}
        aria-expanded={isOpen}
        aria-label={label ? `${label} folder` : "Folder"}
        style={{ perspective: `${Math.max(g.w, g.h) * 5}px`, perspectiveOrigin: "50% 60%" }}
        onClick={toggle}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            toggle();
          }
        }}
      >
        <div ref={stageRef} className="absolute inset-0" style={{ transformStyle: "preserve-3d" }}>
          {/* 背板 + 标签 */}
          <div
            ref={backRef}
            className="absolute left-0 top-0 h-full w-full"
            style={{ transformStyle: "preserve-3d" }}
            aria-hidden="true"
          >
            <div
              className="absolute inset-0"
              style={{
                clipPath: `path('${shape}')`,
                background: `linear-gradient(180deg, ${insideTop} 0%, ${insideBottom} 100%)`,
              }}
            />
            {label && (
              <span
                className="absolute left-0 top-0 flex items-center justify-center overflow-hidden whitespace-nowrap font-semibold leading-none"
                style={{
                  left: g.tabX,
                  width: g.tabW,
                  height: g.tabH,
                  paddingTop: 1 * g.scale,
                  fontSize: 10.5 * g.scale,
                  color: "var(--folder-tab-ink)",
                  letterSpacing: "-0.005em",
                }}
                title={label}
              >
                {label}
              </span>
            )}
          </div>

          {/* 纸页 */}
          {entries.map((item, index) => {
            const content = item.content ?? (
              <DocumentCard
                title={item.title}
                description={item.description}
                ink={ink}
                strong={strong}
                text={text}
                scale={g.scale}
              />
            );
            return (
              <div
                key={`${index}-${item.title ?? ""}`}
                ref={(node) => {
                  itemRefs.current[index] = node;
                }}
                data-folder-item={index}
                role={isOpen ? "button" : undefined}
                tabIndex={isOpen ? 0 : -1}
                className="absolute left-0 top-0 overflow-hidden will-change-transform outline-none focus-visible:outline-2 focus-visible:outline-offset-2"
                style={{
                  width: g.docW,
                  height: g.docH,
                  borderRadius: 7 * g.scale,
                  background: css(paper),
                  cursor: isOpen ? "pointer" : undefined,
                  boxShadow:
                    "0 0 0 0.5px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.12), 0 calc((2px + var(--lift, 0) * 16px)) calc((5px + var(--lift, 0) * 26px)) rgba(0,0,0, calc(0.1 + var(--lift, 0) * 0.14))",
                }}
                onClick={(event) => {
                  if (!isOpen) return;
                  event.stopPropagation();
                  onItemClick?.(item, index);
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onItemContextMenu?.(item, index, event);
                }}
              >
                {content}
              </div>
            );
          })}

          {/* 前盖：以底边为轴向前倒下 */}
          <div
            ref={frontRef}
            className="absolute left-0 top-0 origin-top-left will-change-transform"
            style={{
              width: g.w,
              height: g.frontH,
              transformStyle: "preserve-3d",
              zIndex: 40,
            }}
            aria-hidden="true"
          >
            <div
              className="absolute inset-0"
              style={{
                borderRadius: g.r,
                background: `linear-gradient(160deg, ${css(
                  mix(rgb, [255, 255, 255], 0.12),
                )} 0%, ${css(rgb)} 48%, ${css(mix(rgb, [0, 0, 0], 0.06))} 100%)`,
                boxShadow:
                  "inset 0 1px 0 rgba(255,255,255,0.28), inset 0 0 0 1px rgba(255,255,255,0.05)",
              }}
            >
              <span
                className="pointer-events-none absolute inset-0"
                style={{
                  borderRadius: g.r,
                  background:
                    "linear-gradient(rgba(255,255,255,var(--glint, 0)), rgba(255,255,255,var(--glint, 0))), rgba(0,0,0,var(--dim, 0))",
                }}
              />
              {/* 闭合时的蓝色外包：一圈细描边 + 外侧柔光，让封面别再"塌"进背景。 */}
              <span
                className="pointer-events-none absolute inset-0"
                style={{
                  borderRadius: g.r,
                  opacity: "var(--edge, 1)",
                  boxShadow: `0 0 0 0.5px rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0.55), 0 8px 18px rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0.32)`,
                }}
              />
            </div>
          </div>
        </div>
      </div>

      {label && (
        <span
          ref={measureRef}
          className="pointer-events-none invisible absolute left-0 top-0 flex items-center justify-center whitespace-nowrap font-semibold leading-none"
          style={{ padding: 0, fontSize: 10.5 * g.scale }}
          aria-hidden="true"
        >
          {label}
        </span>
      )}
    </div>
  );
}
