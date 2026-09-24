import { useSyncExternalStore } from "react";

import {
  getTerminalFontId,
  setTerminalFontId,
  subscribeTerminalFont,
} from "@/workbench/views/terminal/terminal-font";

/**
 * 终端 / 命令输出字体 —— **设置页是唯一入口**，终端只是订阅者。
 *
 * 与 `useThemeMode` 同款（localStorage + `useSyncExternalStore`）：
 * 任意一处改字体，另一边立刻跟着变 —— 不用重开终端，也不用等下一次挂载。
 *
 * 字体只切 CSS font stack（项目不打包字体文件），机器没装对应字体时按栈内
 * 后续字体回退，显示效果取决于本机已装字体。
 */
export function useTerminalFont(): {
  fontId: string;
  setFontId: (id: string) => void;
} {
  const fontId = useSyncExternalStore(subscribeTerminalFont, getTerminalFontId, getTerminalFontId);
  return { fontId, setFontId: setTerminalFontId };
}
