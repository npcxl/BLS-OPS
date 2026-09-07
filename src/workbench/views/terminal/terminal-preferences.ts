/**
 * 终端相关的本地偏好（只存开关，不含任何假状态）。
 *
 * **增强终端默认开启**：关着时终端不注入受控标记、不捕获输出、不生成
 * 结果 Tab —— 默认关会让新用户看不到结果/JSON Tab，表现为"功能写了但
 * 界面没反应"。因此只有用户**主动关过**（写进 `"0"`）才保持关闭；
 * 读不到 localStorage（隐私模式）也按开启处理。
 */
export const ENHANCED_TERMINAL_KEY = "bls-ops.terminal.enhanced";

export function readEnhancedTerminal(): boolean {
  try {
    return window.localStorage.getItem(ENHANCED_TERMINAL_KEY) !== "0";
  } catch {
    return true;
  }
}

export function saveEnhancedTerminal(enabled: boolean): void {
  try {
    window.localStorage.setItem(ENHANCED_TERMINAL_KEY, enabled ? "1" : "0");
  } catch {
    /* 隐私模式等场景下写不进去，忽略即可 */
  }
}
