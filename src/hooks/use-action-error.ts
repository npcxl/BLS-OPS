/**
 * 区块级错误状态 + "重试上一次动作"。
 *
 * # 为什么不直接 `setError(toErrorMessage(cause))`
 *
 * 一行 `toErrorMessage` 把结构化错误（stage / detail / hint）压成字符串：
 * - 界面只剩一句"操作失败"，用户不知道是网络、权限还是参数问题；
 * - 没有重试入口，只能靠开关标签页碰运气；
 * - 多行原文挤在一行里，长错误直接溢出面板。
 *
 * 这里保存**原始异常**，交给 `ErrorState` / `pushErrorToast` 按结构化信息渲染，
 * 并且顺手记住"失败的那次动作"，重试按钮真的能重跑一次。
 *
 * ```tsx
 * const { error, fail, clear, retry } = useActionError();
 * try { await load(); clear(); } catch (cause) { fail(cause, load); }
 *
 * {error ? <ErrorState error={error} compact onRetry={retry} /> : null}
 * ```
 */
import { useCallback, useRef, useState } from "react";

export interface ActionErrorState {
  /** 上一次失败的原始异常；没有则为 null。 */
  error: unknown | null;
  /** 失败的这段操作叫什么（"加载服务列表"），显示在 `ErrorState` 标题上。 */
  title?: string;
  /** 记录一次失败；`retry` 是"再来一次"要重跑的动作。 */
  fail: (cause: unknown, retry?: () => void, title?: string) => void;
  /** 动作成功时清掉错误。 */
  clear: () => void;
  /** 重试回调：**没有记录动作时返回 undefined**，`ErrorState` 就不会画重试按钮。 */
  retry?: () => void;
}

export function useActionError(): ActionErrorState {
  const [error, setError] = useState<unknown | null>(null);
  const [title, setTitle] = useState<string | undefined>(undefined);
  const retryRef = useRef<(() => void) | null>(null);

  const fail = useCallback((cause: unknown, retry?: () => void, nextTitle?: string) => {
    retryRef.current = retry ?? null;
    setTitle(nextTitle);
    setError(cause);
  }, []);

  const clear = useCallback(() => {
    retryRef.current = null;
    setTitle(undefined);
    setError(null);
  }, []);

  const retry = retryRef.current
    ? () => {
        const run = retryRef.current;
        retryRef.current = null;
        setError(null);
        run?.();
      }
    : undefined;

  return { error, title, fail, clear, retry };
}
