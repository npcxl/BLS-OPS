/**
 * ServiceProvider —— systemd 服务单元参数补全。
 *
 * 覆盖 `systemctl <verb> <unit>`（`status`/`start`/`restart`/…）与
 * `journalctl -u <unit>`。单元名来自服务器上的 `systemctl list-units`，
 * 并按光标所在的参数位判断，而不是整行结尾。
 */

import { opsApi, type ServiceUnit } from "@/api/ops-api";
import { i18n } from "@/i18n";
import { quotePathSegment } from "../path-input";
import type {
  CompletionContext,
  CompletionItem,
  CompletionProvider,
  CompletionResult,
  ParsedLine,
} from "../types";

/** systemctl 的动词 → 单元名跟在第几个 token（1 = 紧跟动词）。 */
const SYSTEMCTL_VERBS = new Set([
  "status",
  "start",
  "stop",
  "restart",
  "reload",
  "enable",
  "disable",
  "is-active",
  "is-enabled",
  "is-failed",
  "show",
  "mask",
  "unmask",
  "reset-failed",
]);

const CACHE_TTL_MS = 20_000;
let cache: { sessionId: string; at: number; units: string[] } | null = null;

/** 切换服务器 / 手动刷新后调用。 */
export function invalidateServiceCache(): void {
  cache = null;
}

export type UnitLister = (sessionId: string) => Promise<ServiceUnit[]>;

let lister: UnitLister = (sessionId) => opsApi.serviceList(sessionId);
export function setServiceLister(next: UnitLister | null): void {
  lister = next ?? ((sessionId: string) => opsApi.serviceList(sessionId));
}

/** 当前光标是否处在"单元名"参数位。 */
export function isUnitPosition(parsed: ParsedLine): boolean {
  if (parsed.command === "systemctl") {
    // 跳过 `-u`-类选项与 `--no-pager` 之类的开关，动词后第一个非选项 token 是单元。
    const verb = parsed.tokens[1]?.value ?? "";
    if (!SYSTEMCTL_VERBS.has(verb)) return false;
    return parsed.index >= 2 && !parsed.prefix.startsWith("-");
  }
  if (parsed.command === "journalctl") {
    // `journalctl -u <cursor>`：只有紧跟着 `-u` 的那个 token 才是单元名。
    const previous = parsed.tokens[parsed.index - 1]?.value;
    return previous === "-u" || previous === "--unit";
  }
  return false;
}

async function listUnits(sessionId: string): Promise<string[]> {
  if (cache && cache.sessionId === sessionId && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.units;
  }
  const units = await lister(sessionId);
  const names = units.map((unit) => unit.unit).filter(Boolean).sort((a, b) => a.localeCompare(b));
  cache = { sessionId, at: Date.now(), units: names };
  return names;
}

export function createServiceProvider(): CompletionProvider {
  return {
    id: "service",
    matches: isUnitPosition,
    async complete(ctx: CompletionContext, parsed: ParsedLine): Promise<CompletionResult> {
      const partial = parsed.prefix;
      const requestKey = `service:${ctx.sessionId}:${partial}`;
      let units: string[];
      try {
        units = await listUnits(ctx.sessionId);
      } catch (cause) {
        return {
          items: [],
          notice: i18n.t("Failed to read service unit list: {{message}}", {
            message: cause instanceof Error ? cause.message : String(cause),
          }),
          requestKey,
        };
      }
      const matched = units.filter((unit) => unit.startsWith(partial));
      if (matched.length === 0) return { items: [], notice: "No matching service units", requestKey };

      const start = ctx.cursor - partial.length;
      const items: CompletionItem[] = matched.map((unit, index) => ({
        label: unit,
        insertText: quotePathSegment(unit, null, false),
        detail: "systemd service unit",
        icon: "service",
        type: "service",
        replaceRange: { start, end: ctx.cursor },
        priority: 100 - index,
        source: "service",
        highlight: partial ? { start: 0, length: partial.length } : undefined,
      }));
      return { items, requestKey };
    },
  };
}
