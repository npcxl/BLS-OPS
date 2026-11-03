import { copyText } from "@/lib/clipboard";
import { pushToast } from "@/components/ui/toast";
import { i18n } from "@/i18n";

/** Menu actions have no local copy indicator: report the actual write result. */
export async function copyTextWithFeedback(text: string): Promise<boolean> {
  const ok = await copyText(text);
  pushToast(i18n.t(ok ? "Copied" : "Copy failed. Please check clipboard permission"),
    ok ? "success" : "error", { variant: ok ? "copy" : undefined, persist: false });
  return ok;
}
