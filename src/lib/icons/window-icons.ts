import type { IconifyIcon } from "@iconify/react";

/**
 * Windows caption glyphs (最小化 / 最大化 / 向下还原 / 关闭).
 *
 * They are drawn on a 10×10 grid — the same grid the native Segoe MDL2 glyphs
 * use — so a 1-unit stroke lands exactly on one device pixel at their native
 * 10px size instead of being anti-aliased into grey mush.
 *
 * Like `vscode-file-icons.ts` the data is inlined as `IconifyIcon` objects:
 * @iconify/react renders them straight from memory and never calls the Iconify
 * API, so the window buttons look the same offline.
 */
export const WINDOW_ICONS = {
  minimize: {
    body: '<path fill="currentColor" d="M1 5h8v1H1z"/>',
    width: 10,
    height: 10,
  },
  maximize: {
    body: '<path fill="currentColor" d="M1 1h8v8H1V1zm1 1v6h6V2H2z"/>',
    width: 10,
    height: 10,
  },
  /** 向下还原：前景方框 + 后景窗口露出的上边与右边。 */
  restore: {
    body:
      '<path fill="currentColor" d="M1 3h6v6H1V3zm1 1v4h4V4H2z"/>' +
      '<path fill="currentColor" d="M3 1h6v1H3zM8 1v6h1V1z"/>',
    width: 10,
    height: 10,
  },
  close: {
    body:
      '<path fill="currentColor" d="M1.2 0 0 1.2 3.8 5 0 8.8 1.2 10 5 6.2 8.8 10 10 8.8 ' +
      '6.2 5 10 1.2 8.8 0 5 3.8z"/>',
    width: 10,
    height: 10,
  },
} satisfies Record<string, IconifyIcon>;
