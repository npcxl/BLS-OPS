import { useState } from "react";

/**
 * Guards a form submit: tracks pending state (so the button can be disabled and
 * double clicks ignored) and surfaces errors.
 *
 * `error` 存**原始异常**，交给 `<ErrorState>` 渲染：阶段、恢复建议、详情与
 * 复制都在那里统一处理。不要再把它当字符串拼进 JSX。
 */
export function useSubmit() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown | null>(null);

  const run = async (action: () => Promise<unknown>) => {
    if (pending) return false;
    setPending(true);
    setError(null);
    try {
      await action();
      return true;
    } catch (cause) {
      setError(cause);
      return false;
    } finally {
      setPending(false);
    }
  };

  return { pending, error, setError, run };
}
