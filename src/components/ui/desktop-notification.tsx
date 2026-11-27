/**
 * 桌面通知卡片 —— 一个独立透明窗口里的一张卡片。
 *
 * # 首帧直接是玻璃
 *
 * 卡片有三个阶段（由窗口侧状态机驱动）：
 * - `waiting`：整张卡（含文字）透明。窗口已经定位到最终位置，GlassSurface
 *   在后台准备纹理，不显示任何东西；
 * - `glass`：首帧真正画完之后，整张卡**一次性**淡入 —— 不会先看到白底；
 * - `solid`：采集不支持 / 超时 / WebGL 失败，直接淡入实色主题底，并且
 *   本条通知保持这个材质，避免几秒后突然变脸。
 *
 * # 材质
 *
 * 玻璃用 ReactBits 的 `GlassSurface`（WebGL 渲染器），纹理来自窗口侧的
 * **实时 canvas**（Rust 的 WGC 采集按窗口矩形裁剪）。卡片自己不画边框：
 * 外圈白线来自组件的 `FRAME_SHADOW`，通过 `showFrame={false}` 关掉；
 * `borderWidth` 仍然参与位移图，折射边缘不受影响。
 *
 * 圆角与窗口一致（16px），外层 `overflow-hidden` 同时裁 canvas 与内容，
 * 浅色/深色/高 DPI 下都不会漏出方角。
 */
import type { RefObject } from "react";
import GlassSurface from "@/components/ui/glass-surface";
import { X } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { i18n } from "@/i18n";
import { cn } from "@/lib/cn";

export type DesktopNotificationTone = "info" | "success" | "warning" | "danger";

/** 卡片当前阶段：等待首帧 / 显示玻璃 / 已回退实色 / 退场中。 */
export type DesktopNotificationPhase = "waiting" | "glass" | "solid" | "leaving";

export interface DesktopNotificationAction {
  label: string;
  onClick: () => void;
}

export interface DesktopNotificationItem {
  id: string;
  /**
   * 色调：**不画在卡片上**（状态图标/圆点会顶掉应用 logo）。正式接入时
   * 用于标题强调色或系统提示音，玻璃表面始终是同一材质。
   */
  tone?: DesktopNotificationTone;
  /** 来源行：应用名 / 分类，例如「批量命令」「SSH 会话」。 */
  source?: string;
  title: string;
  /** 正文，最多三行，超出省略。 */
  body?: string;
  /** 补充信息行，例如「3 台成功 · 0 台失败 · 12.4s」。 */
  meta?: string;
  /** 右上角时间，例如「刚刚」。 */
  time?: string;
  actions?: DesktopNotificationAction[];
  onDismiss?: () => void;
}

export function DesktopNotificationCard({
  item,
  canvasRef,
  phase = "solid",
  showGlass = false,
  reduced = false,
  onActivate,
  onFirstFrame,
}: {
  item: DesktopNotificationItem;
  /** 实时纹理源：窗口侧每帧把裁剪好的桌面画进去。 */
  canvasRef?: RefObject<HTMLCanvasElement | null>;
  /** 当前阶段；`waiting` / `leaving` 时整卡透明。 */
  phase?: DesktopNotificationPhase;
  /** 是否已经收到有效帧（决定要不要挂 GlassSurface）。 */
  showGlass?: boolean;
  /** 系统"减少动画"：只保留简短淡入淡出，不做位移。 */
  reduced?: boolean;
  /** 点击整张卡片：由窗口侧把 action 转给主窗口。 */
  onActivate?: () => void;
  onFirstFrame?: () => void;
}) {
  const hidden = phase === "waiting" || phase === "leaving";
  const leaving = phase === "leaving";

  return (
    <div
      onClick={onActivate}
      className={cn(
        "relative w-full overflow-hidden rounded-[16px] transition-opacity ease-out",
        // 退场比入场快：关闭/到期 120ms，入场 200ms。
        leaving ? "duration-[120ms]" : reduced ? "duration-[90ms]" : "duration-200",
        hidden ? "opacity-0" : "opacity-100",
        onActivate && "cursor-pointer",
      )}
    >
      {/*
       * 实色底只属于 `solid` 阶段。玻璃阶段这层必须不存在：浅色主题下
       * `bg-surface-1` 是白的，玻璃 canvas 圆角边缘会透出 1px 白线。
       */}
      {phase === "solid" && (
        <div aria-hidden="true" className="absolute inset-0 bg-surface-1" />
      )}

      {/* 纹理源：不可见，只给 GlassSurface 上传纹理用。 */}
      <canvas
        ref={canvasRef}
        width={360}
        height={96}
        className="pointer-events-none absolute inset-0 h-full w-full opacity-0"
      />

      {showGlass && phase !== "solid" && phase !== "leaving" && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 z-[1]"
        >
          <GlassSurface
            // WebGL 是唯一真正采样 backdrop 的路径；auto 在 Chromium 会走
            // backdrop-filter（透明窗口里采样不到桌面），必须显式指定。
            renderer="webgl"
            backdrop={canvasRef}
            width="100%"
            height="100%"
            /*
             * 圆角交给最外层卡片裁一次。
             *
             * GlassSurface 内部还有一层 `overflow-hidden` + canvas 的
             * `rounded-[inherit]`：WebGL 画面本身是不透明的，两层圆角各自
             * 抗锯齿叠在一起，边缘就会混出一圈白线（浅色桌面尤其明显）。
             * 这里让玻璃保持方角，只由卡片外层的 16px 圆角统一裁切。
             */
            borderRadius={0}
            borderWidth={0.08}
            blur={9}
            displace={0.6}
            saturation={1.2}
            distortionScale={-70}
            redOffset={0}
            greenOffset={4}
            blueOffset={8}
            backgroundOpacity={0.42}
            // 通知不要组件自带的高光描边（外圈白线）；位移图仍按 borderWidth 算。
            showFrame={false}
            // 组件内层内容槽写死 p-2，这里没有真实内容，收掉即可。
            className="[&>div:last-child]:!p-0"
            onFirstFrame={onFirstFrame}
          >
            <span className="block h-full w-full" />
          </GlassSurface>
        </div>
      )}

      {/*
       * 内容层：始终可读，压在玻璃之上。
       * 入场时从下方 4px 轻移到最终位置 —— 只动内容，不动玻璃层，
       * 折射区域始终和实际桌面严格对齐。
       */}
      <div
        className={cn(
          "relative z-[2] flex w-full items-start gap-2.5 px-3 py-2.5",
          !reduced && "transition-transform duration-200 ease-out",
          !reduced && phase === "waiting" ? "translate-y-1" : "translate-y-0",
        )}
      >
        <img
          src="/logo.png"
          alt=""
          draggable={false}
          className="mt-px size-6 shrink-0 object-contain"
        />

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            {item.source && (
              <span className="min-w-0 truncate text-11 font-semibold tracking-[0.04em] uppercase text-black">
                {item.source}
              </span>
            )}
            {item.time && (
              <span className="ml-auto shrink-0 text-11 tabular-nums text-black">
                {item.time}
              </span>
            )}
          </div>

          <p className="mt-0.5 break-words text-12 font-semibold leading-snug text-black">
            {item.title}
          </p>
          {item.body && (
            <p className="mt-0.5 line-clamp-3 break-words text-11 leading-relaxed text-black">
              {item.body}
            </p>
          )}
          {item.meta && <p className="mt-1 text-11 text-black">{item.meta}</p>}

          {item.actions && item.actions.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5 [&_button]:!text-black">
              {item.actions.map((action) => (
                <Button
                  key={action.label}
                  variant="secondary"
                  size="xs"
                  onClick={(event) => {
                    event.stopPropagation();
                    action.onClick();
                  }}
                >
                  {action.label}
                </Button>
              ))}
            </div>
          )}
        </div>

        {item.onDismiss && (
          <button
            type="button"
            aria-label={i18n.t("关闭通知")}
            className="-mr-0.5 -mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-[5px] text-black transition-colors hover:bg-black/8"
            onClick={(event) => {
              event.stopPropagation();
              item.onDismiss?.();
            }}
          >
            <X size={11} />
          </button>
        )}
      </div>
    </div>
  );
}
