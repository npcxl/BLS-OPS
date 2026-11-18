/*
 * 官方 React Bits Line Sidebar（LineSidebar-TS-TW）。
 * https://reactbits.dev/components/line-sidebar
 *
 * 许可同 React Bits：MIT + Commons Clause —— 可以随应用分发，但不得单独
 * 转售 / 再分发组件本身。
 *
 * # 本项目的五处适配（不改动效模型）
 *
 * 1. 去掉 `'use client'`（Vite 不需要）；
 * 2. 补受控 `activeIndex`（`undefined` 时仍用内部状态，`defaultActive` 保留）；
 * 3. `showLabel = false`：只留刻度。刻度在流内、由真正的 `<button>` 承载，
 *    点击区域比线本身大，键盘可聚焦、Enter / Space 可触发；
 * 4. `wrapTick` / `itemLabel`：把刻度包进项目现有 Tooltip，并提供无障碍名称；
 * 5. `useReducedMotion`：减少动态效果时不做缓动，直接落到目标值。
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode
} from 'react';
import { useReducedMotion } from 'motion/react';

type Falloff = 'linear' | 'smooth' | 'sharp';

export interface LineSidebarProps {
  items?: string[];
  accentColor?: string;
  textColor?: string;
  markerColor?: string;
  showIndex?: boolean;
  showMarker?: boolean;
  /** 是否显示常驻标题。本项目的时间轴传 false，只留刻度。 */
  showLabel?: boolean;
  proximityRadius?: number;
  maxShift?: number;
  falloff?: Falloff;
  markerLength?: number;
  markerGap?: number;
  tickScale?: number;
  scaleTick?: boolean;
  itemGap?: number;
  fontSize?: number;
  smoothing?: number;
  /** 受控高亮；不传时由组件内部维护（初始值取 `defaultActive`）。 */
  activeIndex?: number | null;
  defaultActive?: number | null;
  onItemClick?: (index: number, label: string) => void;
  /** tick 模式下包裹刻度按钮（Tooltip 用）；返回的元素必须能接收 ref。 */
  wrapTick?: (index: number, label: string, tick: ReactElement) => ReactNode;
  /** 刻度的无障碍名称（tick 模式下没有可见标题）。 */
  itemLabel?: (index: number, label: string) => string;
  className?: string;
}

const FALLOFF_CURVES: Record<Falloff, (p: number) => number> = {
  linear: p => p,
  smooth: p => p * p * (3 - 2 * p),
  sharp: p => p * p * p
};

const DEFAULT_ITEMS = [
  'Overview',
  'Components',
  'Animations',
  'Backgrounds',
  'Showcase',
  'Playground',
  'Templates',
  'Changelog',
  'Community',
  'Resources',
  'Documentation',
  'Support'
];

const LineSidebar = ({
  items = DEFAULT_ITEMS,
  accentColor = '#A855F7',
  textColor = '#c4c4c4',
  markerColor = '#6c6c6c',
  showIndex = true,
  showMarker = true,
  showLabel = true,
  proximityRadius = 100,
  maxShift = 30,
  falloff = 'smooth',
  markerLength = 60,
  markerGap = 0,
  tickScale = 0.5,
  scaleTick = true,
  itemGap = 20,
  fontSize = 1.1,
  smoothing = 100,
  activeIndex,
  defaultActive = null,
  onItemClick,
  wrapTick,
  itemLabel,
  className = ''
}: LineSidebarProps) => {
  const reduce = useReducedMotion();
  const listRef = useRef<HTMLUListElement>(null);
  const itemRefs = useRef<(HTMLLIElement | null)[]>([]);
  const targetsRef = useRef<number[]>([]);
  const currentRef = useRef<number[]>([]);
  const rafRef = useRef<number | null>(null);
  const lastRef = useRef(0);
  const smoothingRef = useRef(smoothing);
  const reduceRef = useRef(reduce);
  const [innerActive, setInnerActive] = useState<number | null>(defaultActive);
  /** 受控优先；`undefined` 才算非受控（`null` 是"没有高亮"的有效值）。 */
  const resolvedActive = activeIndex !== undefined ? activeIndex : innerActive;
  const activeRef = useRef<number | null>(resolvedActive);

  activeRef.current = resolvedActive;
  smoothingRef.current = smoothing;
  reduceRef.current = reduce;

  // Single rAF loop that eases every item's --effect toward its target using
  // frame-rate independent exponential smoothing, so color, shift and scale
  // all move together without staggering CSS transitions.
  const runFrame = useCallback((now: number) => {
    const dt = Math.min((now - lastRef.current) / 1000, 0.05);
    lastRef.current = now;
    const tau = Math.max(smoothingRef.current, 1) / 1000;
    const k = reduceRef.current ? 1 : 1 - Math.exp(-dt / tau);

    let moving = false;
    const items = itemRefs.current;
    for (let i = 0; i < items.length; i++) {
      const el = items[i];
      if (!el) continue;
      const target = Math.max(targetsRef.current[i] || 0, activeRef.current === i ? 1 : 0);
      const cur = currentRef.current[i] || 0;
      const next = cur + (target - cur) * k;
      const settled = reduceRef.current || Math.abs(target - next) < 0.0015;
      const value = settled ? target : next;
      currentRef.current[i] = value;
      el.style.setProperty('--effect', value.toFixed(4));
      if (!settled) moving = true;
    }

    rafRef.current = moving ? requestAnimationFrame(runFrame) : null;
  }, []);

  const startLoop = useCallback(() => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
    }
    lastRef.current = performance.now();
    rafRef.current = requestAnimationFrame(runFrame);
  }, [runFrame]);

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLUListElement>) => {
      const list = listRef.current;
      if (!list) return;
      const rect = list.getBoundingClientRect();
      const pointerY = e.clientY - rect.top;
      const ease = FALLOFF_CURVES[falloff] ?? FALLOFF_CURVES.linear;
      const items = itemRefs.current;
      for (let i = 0; i < items.length; i++) {
        const el = items[i];
        if (!el) continue;
        const center = el.offsetTop + el.offsetHeight / 2;
        const distance = Math.abs(pointerY - center);
        targetsRef.current[i] = ease(Math.max(0, 1 - distance / proximityRadius));
      }
      startLoop();
    },
    [falloff, proximityRadius, startLoop]
  );

  const handlePointerLeave = useCallback(() => {
    targetsRef.current = targetsRef.current.map(() => 0);
    startLoop();
  }, [startLoop]);

  const handleClick = useCallback(
    (index: number, label: string) => {
      if (activeIndex === undefined) setInnerActive(index);
      onItemClick?.(index, label);
    },
    [activeIndex, onItemClick]
  );

  useEffect(() => {
    startLoop();
  }, [resolvedActive, startLoop]);

  useEffect(
    () => () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    },
    []
  );

  const tickClass = showMarker
    ? `after:absolute after:left-[calc(-1*var(--marker-length)-var(--marker-gap))] after:top-[calc(100%+var(--item-gap)/2)] after:h-px after:opacity-50 after:content-[''] last:after:content-none after:[background-color:var(--marker-color)] after:[width:calc(var(--marker-length)*var(--tick-scale))] ${
        scaleTick
          ? "after:origin-left after:[transform:translateY(-50%)_scaleX(calc(0.7+var(--effect,0)*0.6))]"
          : 'after:-translate-y-1/2'
      }`
    : '';

  return (
    <nav
      className={`relative flex justify-start${
        showLabel && showMarker ? ' [padding-left:calc(var(--marker-length)+var(--marker-gap))]' : ''
      }${className ? ` ${className}` : ''}`}
      style={
        {
          '--accent-color': accentColor,
          '--text-color': textColor,
          '--marker-color': markerColor,
          '--marker-length': `${markerLength}px`,
          '--marker-gap': `${markerGap}px`,
          '--tick-scale': tickScale,
          '--max-shift': `${maxShift}px`,
          '--item-gap': `${itemGap}px`,
          '--font-size': `${fontSize}rem`,
          '--smoothing': `${smoothing}ms`
        } as CSSProperties
      }
    >
      <ul
        ref={listRef}
        onPointerMove={handlePointerMove}
        onPointerLeave={handlePointerLeave}
        className={`m-0 flex list-none flex-col [gap:var(--item-gap)] ${showLabel ? 'py-4' : 'py-0'}`}
      >
        {items.map((label, index) => {
          const current = resolvedActive === index;
          if (!showLabel) {
            /*
             * 刻度模式：线在流内，外面是真正的 button，点击区域 28×16，
             * 键盘可聚焦、Enter / Space 原生触发。
             */
            const tick = (
              <button
                type="button"
                aria-label={itemLabel?.(index, label)}
                aria-current={current ? 'true' : undefined}
                onClick={() => handleClick(index, label)}
                className="group flex h-4 w-7 cursor-pointer touch-manipulation items-center border-0 bg-transparent p-0 outline-none select-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                <span
                  aria-hidden="true"
                  className="block h-px w-[length:var(--marker-length)] origin-left [background-color:color-mix(in_srgb,var(--accent-color)_calc(var(--effect,0)*100%),var(--marker-color))] [transform:scaleX(calc(0.7+var(--effect,0)*0.5))] group-focus-visible:[background-color:var(--accent-color)] group-focus-visible:[transform:scaleX(1)]"
                />
              </button>
            );
            return (
              <li
                key={`${label}-${index}`}
                ref={el => {
                  itemRefs.current[index] = el;
                }}
                data-line-item={index}
                data-active={current ? '' : undefined}
                className="relative flex h-4 w-7 flex-none items-center"
              >
                {wrapTick ? wrapTick(index, label, tick) : tick}
              </li>
            );
          }

          return (
            <li
              key={`${label}-${index}`}
              ref={el => {
                itemRefs.current[index] = el;
              }}
              aria-current={current ? 'true' : undefined}
              data-line-item={index}
              data-active={current ? '' : undefined}
              onClick={() => handleClick(index, label)}
              className={`relative cursor-pointer before:absolute before:-inset-x-12 before:-inset-y-[6px] before:content-[''] ${tickClass}`}
            >
              {showMarker && (
                <span
                  aria-hidden="true"
                  className="absolute left-[calc(-1*var(--marker-length)-var(--marker-gap))] top-1/2 h-px w-[length:var(--marker-length)] origin-left [background-color:color-mix(in_srgb,var(--accent-color)_calc(var(--effect,0)*100%),var(--marker-color))] [transform:translateY(-50%)_scaleX(calc(0.7+var(--effect,0)*0.5))]"
                />
              )}
              <span className="relative inline-flex items-baseline leading-[1.2] [color:color-mix(in_srgb,var(--accent-color)_calc(var(--effect,0)*100%),var(--text-color))] [font-size:var(--font-size)] [transform:translateX(calc(var(--effect,0)*var(--max-shift)))]">
                {showIndex && (
                  <span className="mr-[0.6rem] font-mono text-[0.85em] [opacity:calc(0.55+var(--effect,0)*0.45)]">
                    {String(index + 1).padStart(2, '0')}
                  </span>
                )}
                <span>{label}</span>
              </span>
            </li>
          );
        })}
      </ul>
    </nav>
  );
};

export default LineSidebar;
