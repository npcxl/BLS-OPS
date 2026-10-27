/**
 * 巡检模式（只读）。
 *
 * **它只是防误操作，不是权限控制。** 客户端的开关挡不住 `rm -rf`：自由终端里
 * 用户仍能执行任何命令。真要只读，必须配合服务器上的受限账号。UI 上也必须
 * 这么写，不能让人误以为开了它就安全了。
 *
 * 存 localStorage：跟着人走，不跟着服务器走（同一台机器换个人用不该继承）。
 */
import { useSyncExternalStore } from "react";

const STORAGE_KEY = "blsops.inspection-mode";

const listeners = new Set<() => void>();

function read(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    // 存储不可用时默认关闭：宁可没有保护，也不能让应用看起来"卡住"。
    return false;
  }
}

let inspection = read();

export function isInspectionMode(): boolean {
  return inspection;
}

export function setInspectionMode(enabled: boolean): void {
  inspection = enabled;
  try {
    if (enabled) localStorage.setItem(STORAGE_KEY, "1");
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // 存不进去就只对本次会话生效。
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useInspectionMode(): boolean {
  return useSyncExternalStore(subscribe, isInspectionMode, isInspectionMode);
}
