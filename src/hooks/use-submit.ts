import { useState } from "react";
import { toErrorMessage } from "@/api/ops-api";

/**
 * Guards a form submit: tracks pending state (so the button can be disabled and
 * double clicks ignored) and surfaces errors.
 */
export function useSubmit() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: () => Promise<unknown>) => {
    if (pending) return false;
    setPending(true);
    setError(null);
    try {
      await action();
      return true;
    } catch (cause) {
      setError(toErrorMessage(cause));
      return false;
    } finally {
      setPending(false);
    }
  };

  return { pending, error, setError, run };
}
