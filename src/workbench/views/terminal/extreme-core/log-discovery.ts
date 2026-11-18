/**
 * 「实时看看某个服务的日志」——**在服务器上找真实来源**。
 *
 * 模型不一定会给出 `[[panel:…]]`（也可能给错：这台机的 nginx 在 Docker 里，
 * 它却说 `journal:nginx`）。所以这里做一次只读扫描，把这台机器上真实存在的
 * 候选列出来，再按用户这句话里的线索打分：
 *
 * * 只有一个高分候选 → 直接打开；
 * * 多个 → **只问一句**，把候选名字给用户；
 * * 一个都没有 → 直说没找到，不打开空面板。
 */
import type { LogSource } from "@/api/types/panel";

/** 一句话是不是"要看日志"。 */
export function isLogIntent(text: string): boolean {
  const value = text.trim();
  if (!value || value.length > 80) return false;
  return /(日志|log|tail|跟踪|实时看(看)?|实时监控)/i.test(value);
}

/**
 * 一条只读扫描命令，输出三段带标记的候选：
 * Docker 容器 / 运行中的 systemd 服务 / 常见日志文件。
 */
export function discoveryCommand(): string {
  return [
    "echo '##docker'",
    "command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' 2>/dev/null | head -30",
    "echo '##units'",
    "systemctl list-units --type=service --state=running --no-legend 2>/dev/null | awk '{print $1}' | head -40",
    "echo '##files'",
    "ls -1 /var/log/nginx/*.log /var/log/apache2/*.log /var/log/httpd/*.log /var/log/*.log 2>/dev/null | head -40",
    "echo '##k8s'",
    "command -v kubectl >/dev/null 2>&1 && kubectl get pods --no-headers 2>/dev/null | awk '{print $1}' | head -30",
  ].join("; ");
}

/** 解析扫描结果 → 候选来源（顺序：Docker → systemd → 文件 → K8s）。 */
export function parseCandidates(stdout: string): LogSource[] {
  const out: LogSource[] = [];
  let section = "";
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("##")) {
      section = line.slice(2).trim();
      continue;
    }
    if (section === "docker") out.push({ kind: "docker", container: line, label: line });
    else if (section === "units") {
      const unit = line.replace(/\.service$/, "");
      out.push({ kind: "journal", unit, label: unit });
    } else if (section === "files") out.push({ kind: "file", path: line, label: line });
    else if (section === "k8s") out.push({ kind: "k8s", pod: line, label: line });
  }
  // 同名去重（Docker 与 systemd 都叫 nginx 时保留两个：它们确实是两个来源）。
  const seen = new Set<string>();
  return out.filter((source) => {
    const key = `${source.kind}:${source.kind === "file" ? source.path : source.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** 用户这句话里出现的关键词（去噪后用于打分）。 */
export function intentTokens(text: string): string[] {
  const value = text.toLowerCase();
  const tokens = new Set<string>();
  for (const word of value.split(/[^a-z0-9\u4e00-\u9fa5_.-]+/)) {
    const token = word.trim();
    if (token.length >= 2 && !STOP.has(token)) tokens.add(token);
  }
  // 中文常见说法 → 归一化线索。
  if (/(访问|access)/.test(value)) tokens.add("access");
  if (/(错误|error|err)/.test(value)) tokens.add("error");
  if (/(nginx|反向代理)/.test(value)) tokens.add("nginx");
  if (/(mysql|数据库)/.test(value)) tokens.add("mysql");
  if (/(redis|缓存)/.test(value)) tokens.add("redis");
  if (/(容器|docker)/.test(value)) tokens.add("docker");
  if (/(k8s|kubernetes|pod)/.test(value)) tokens.add("k8s");
  return [...tokens];
}

const STOP = new Set([
  "日志", "看看", "实时", "跟踪", "一下", "这个", "那个", "服务", "的", "了", "和", "与",
  "the", "and", "log", "logs", "tail", "show", "watch", "please",
]);

export interface SourcePick {
  /** 唯一匹配。 */
  pick?: LogSource;
  /** 有歧义：这些候选需要用户选一个。 */
  choices: LogSource[];
}

/**
 * 按关键词给候选打分。
 *
 * 命中同一个词越具体分越高；同分且来自不同来源 → 算歧义（比如 Docker 里的
 * nginx 与 systemd 的 nginx 同时存在，猜错就打开了一个空的日志面板）。
 */
export function pickLogSource(candidates: LogSource[], text: string): SourcePick {
  const tokens = intentTokens(text);
  if (candidates.length === 0) return { choices: [] };
  if (tokens.length === 0) {
    // 没有任何线索：只有一个候选时才敢直接开。
    return candidates.length === 1 ? { pick: candidates[0], choices: [] } : { choices: candidates };
  }

  const scored = candidates.map((source) => {
    const haystack = sourceHaystack(source).toLowerCase();
    let score = 0;
    for (const token of tokens) {
      if (haystack.includes(token)) score += token.length >= 3 ? 2 : 1;
    }
    // 文件日志里 `nginx` 权重更高：直接写在文件里的服务通常就是用户要的。
    if (source.kind === "file" && /(access|error)/.test(haystack)) score += 1;
    return { source, score };
  });
  const best = Math.max(...scored.map((item) => item.score));
  if (best <= 0) {
    // 这句话没有提供任何线索：只有一个候选时才敢直接开。
    return candidates.length === 1 ? { pick: candidates[0], choices: [] } : { choices: candidates };
  }
  const top = scored.filter((item) => item.score === best).map((item) => item.source);
  if (top.length === 1) return { pick: top[0], choices: [] };
  // 同一来源类型的多个候选（多个 nginx 日志文件）：也给用户选。
  return { choices: top };
}

function sourceHaystack(source: LogSource): string {
  switch (source.kind) {
    case "file":
      return `${source.path} ${source.label}`;
    case "journal":
      return `${source.unit} ${source.label}`;
    case "docker":
      return `${source.container} ${source.label}`;
    case "k8s":
      return `${source.pod} ${source.namespace ?? ""} ${source.label}`;
  }
}

/** 歧义时给用户看的一句话（只问这一句，不展开教程）。 */
export function ambiguityQuestion(choices: LogSource[]): string {
  const names = choices.slice(0, 4).map((source) => describeSource(source));
  return `有多个来源：${names.join("、")}。要看哪一个？`;
}

/** 描述一个来源（候选列表与聊天提示共用）。 */
export function describeSource(source: LogSource): string {
  switch (source.kind) {
    case "file":
      return source.path;
    case "journal":
      return `systemd:${source.unit}`;
    case "docker":
      return `docker:${source.container}`;
    case "k8s":
      return `k8s:${source.namespace ? `${source.namespace}/` : ""}${source.pod}`;
  }
}

/** 用户回复里是否点了某个候选（"看 bls-nginx 的日志"）。 */
export function matchChoice(text: string, choices: LogSource[]): LogSource | null {
  const value = text.trim().toLowerCase();
  if (!value) return null;
  /*
   * 按"命中的最长片段"打分，而不是"有没有命中"。
   *
   * `看 bls-nginx 的日志` 同时包含 `bls-nginx` 与 `nginx`：前者更具体，
   * 应该选 Docker 的那个，而不是把 systemd 的 nginx 也算成候选。
   */
  const scored = choices.map((source) => {
    const parts = sourceHaystack(source)
      .toLowerCase()
      .split(/\s+/)
      .filter((part) => part.length >= 3 && value.includes(part));
    const longest = parts.reduce((max, part) => Math.max(max, part.length), 0);
    return { source, longest };
  });
  const best = Math.max(...scored.map((item) => item.longest));
  if (best <= 0) return null;
  const top = scored.filter((item) => item.longest === best);
  return top.length === 1 ? top[0].source : null;
}
