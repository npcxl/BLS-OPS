/**
 * 站点定位：从 Nginx 配置里找出「某个域名由谁托管、文件在哪」。
 *
 * 只做**解析**，不执行命令 —— 采集部分在组件里用 `ssh_exec` 完成。
 *
 * 为什么用 `nginx -T` 而不是逐个读文件：`-T` 会把主配置与所有 `include`
 * **展开后整份打印**，并带上 `# configuration file <path>:` 分隔行。这样不必
 * 自己解析 `include` 指令、也不必猜 `sites-enabled` 里哪些是软链。
 */

/** 一个 `location` 块。 */
export interface NginxLocation {
  /** location 的参数：`/`、`/api`、`~ \.php$` 等。 */
  path: string;
  root?: string;
  alias?: string;
  proxyPass?: string;
  index?: string;
  /** `try_files` 原文，用于判断是不是 SPA（`$uri /index.html`）。 */
  tryFiles?: string;
}

/** 一个 `server` 块。 */
export interface NginxServer {
  /** 来源配置文件（`-T` 里的分隔行）。 */
  file?: string;
  listen: string[];
  serverNames: string[];
  root?: string;
  locations: NginxLocation[];
}

/** 站点类型：静态、反代，或两者都有（同一 server 里既托管页面又转发接口）。 */
export type SiteKind = "static" | "proxy" | "mixed" | "unknown";

/** 去掉注释，避免把 `# server_name a;` 当真。 */
function stripComments(text: string): string {
  return text.replace(/#[^\n]*/g, "");
}

/**
 * 找出所有 `<keyword> … { … }` 块，支持嵌套花括号。
 *
 * 手写计数而不是正则匹配到第一个 `}`：`server` / `location` 里都有嵌套块，
 * 非贪婪正则会切在第一个内层 `}` 上。
 */
function findBlocks(text: string, keyword: string): { head: string; body: string }[] {
  const out: { head: string; body: string }[] = [];
  const pattern = new RegExp(`\\b${keyword}\\b[^{;]*\\{`, "g");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    let depth = 1;
    let cursor = pattern.lastIndex;
    const start = cursor;
    while (cursor < text.length && depth > 0) {
      const char = text[cursor];
      if (char === "{") depth += 1;
      else if (char === "}") depth -= 1;
      cursor += 1;
    }
    out.push({
      head: match[0].slice(0, -1).trim(),
      body: text.slice(start, cursor - 1),
    });
    pattern.lastIndex = cursor;
  }
  return out;
}

/** 取一条简单指令的值（`root /var/www;`）。 */
function directive(body: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|[;{}\\s])${name}\\s+([^;]+);`, "m").exec(body);
  return match?.[1]?.trim();
}

/** 解析一个 location 块。 */
function parseLocation(head: string, body: string): NginxLocation {
  return {
    // `location /` → `/`；`location ~ \.php$` → `~ \.php$`
    path: head.replace(/^location\s+/, "").trim(),
    root: directive(body, "root"),
    alias: directive(body, "alias"),
    proxyPass: directive(body, "proxy_pass"),
    index: directive(body, "index"),
    tryFiles: directive(body, "try_files"),
  };
}

/**
 * 解析 `nginx -T` 的完整输出。
 *
 * 输出形如：
 * ```
 * # configuration file /etc/nginx/conf.d/ops.conf:
 * server {
 *     listen 80;
 *     server_name ops.xlcig.cn;
 *     root /var/www/ops;
 * }
 * ```
 */
export function parseNginxConfig(text: string): NginxServer[] {
  const servers: NginxServer[] = [];
  // 按 `# configuration file …:` 切段，才能给每个 server 标上来源文件。
  const sections = text.split(/^#\s*configuration file\s+(.+?):\s*$/m);

  /** 解析一段配置，`file` 是它的来源。 */
  const collect = (body: string, file?: string) => {
    for (const block of findBlocks(stripComments(body), "server")) {
      const listen = directive(block.body, "listen");
      const serverName = directive(block.body, "server_name");
      const locations = findBlocks(block.body, "location").map((entry) =>
        parseLocation(entry.head, entry.body),
      );
      servers.push({
        file,
        listen: listen ? listen.split(/\s+/) : [],
        serverNames: serverName ? serverName.split(/\s+/).filter(Boolean) : [],
        root: directive(block.body, "root"),
        locations,
      });
    }
  };

  // 没有分隔行（直接喂一段配置，常见于单测）时整份当一段。
  if (sections.length === 1) {
    collect(text);
    return servers;
  }
  // split 带捕获组：奇数下标是文件名，紧随其后的偶数下标是内容。
  for (let index = 1; index < sections.length; index += 2) {
    collect(sections[index + 1] ?? "", sections[index]?.trim());
  }
  return servers;
}

/**
 * 按域名匹配 server 块。
 *
 * 支持 `ops.xlcig.cn`、`*.xlcig.cn`、`.xlcig.cn` 三种写法；`_`（默认 server）
 * 不算命中 —— 它意味着"所有未匹配的域名都到这儿"，把它当目标会定位错。
 */
export function matchServers(servers: NginxServer[], domain: string): NginxServer[] {
  const needle = domain.trim().toLowerCase();
  if (!needle) return [];
  return servers.filter((server) =>
    server.serverNames.some((name) => {
      const value = name.toLowerCase();
      if (!value || value === "_") return false;
      if (value === needle) return true;
      if (value.startsWith("*.")) return needle.endsWith(value.slice(1));
      if (value.startsWith(".")) return needle.endsWith(value);
      return false;
    }),
  );
}

/** 判断站点类型。 */
export function classifySite(server: NginxServer): SiteKind {
  const hasProxy = server.locations.some((location) => location.proxyPass);
  const hasStatic = server.locations.some((location) => location.root || location.alias);
  if (hasProxy && hasStatic) return "mixed";
  if (hasProxy) return "proxy";
  // server 级 `root` 也算静态（很多配置把 root 写在 server 里）。
  if (hasStatic || server.root) return "static";
  return "unknown";
}

/**
 * 静态目录，**server 级 root 排最前**。
 *
 * server 级 `root` 是默认值：`location /` 里通常不再写一遍，文件就在它下面。
 * 如果只收集 location 里的 root/alias，会把站点根目录漏掉 —— 后续「更新此
 * 站点」就会替换错目录。`alias` 是额外目录，排在后面。
 */
export function staticDirs(server: NginxServer): string[] {
  const dirs: string[] = [];
  if (server.root) dirs.push(server.root);
  for (const location of server.locations) {
    const dir = location.alias ?? location.root;
    if (dir) dirs.push(dir);
  }
  return [...new Set(dirs)];
}

/** 反代上游：把所有 `proxy_pass` 去重列出来。 */
export function proxyTargets(server: NginxServer): string[] {
  const targets = server.locations
    .map((location) => location.proxyPass)
    .filter((value): value is string => Boolean(value))
    .map((value) => value.replace(/^https?:\/\//, "").replace(/\/.*$/, ""));
  return [...new Set(targets)];
}

/** 入口文件候选：`index` 指令优先，否则 nginx 默认的 index.html。 */
export function entryFiles(server: NginxServer): string[] {
  const fromIndex = server.locations
    .flatMap((location) => (location.index ? location.index.split(/\s+/) : []))
    .filter(Boolean);
  return [...new Set(fromIndex.length > 0 ? fromIndex : ["index.html"])];
}

/**
 * 给结果卡用的一行摘要：`域名 → Nginx 实例 → 类型 → 目录/上游`。
 *
 * 缺什么就写什么（"未找到"），不编造。
 */
export function summarizeSite(input: {
  domain: string;
  instance: string;
  server: NginxServer;
}): { domain: string; instance: string; kind: SiteKind; target: string } {
  const kind = classifySite(input.server);
  const target =
    kind === "proxy"
      ? proxyTargets(input.server).join(", ") || "未找到上游"
      : staticDirs(input.server).join(", ") || "未找到目录";
  return { domain: input.domain, instance: input.instance, kind, target };
}
