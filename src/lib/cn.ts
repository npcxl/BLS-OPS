import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * `text-10/11/12/13/14/16/20` 是本项目的字号 token（见 `styles/tokens.css`）。
 *
 * tailwind-merge 不认识这几个名字，会把 `text-11` 归进**文字颜色**组，于是
 * `cn("text-11", "text-fg-muted")` 只留下颜色、字号被当成冲突删掉，大小退回继承值。
 * 平时继承的是正文 13px，看不出来；但一放进自己设了字号的容器里（例如
 * LiquidGlass 内层写死的 `font: 500 20px/1`）就会突然变成 20px —— 表现为
 * 「次要按钮的字比正文还大」。这里把它们登记进 font-size 组，冲突只在同组内发生。
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: ["10", "11", "12", "13", "14", "16", "20"] }],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
