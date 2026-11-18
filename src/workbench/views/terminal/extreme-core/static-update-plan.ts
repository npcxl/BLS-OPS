/**
 * **静态站点更新计划**（dist.zip 已在服务器上）。
 *
 * 这是"已定位到现有 Nginx 静态站点、ZIP 已上传"时的唯一正确计划：
 * 只做备份 → 解压 → 校验 → 原子替换 → 验证，**不重启共享 Nginx**
 * （配置没变，重启会顺带影响同机的其它站点），也不再要求 Compose。
 *
 * 纯函数：输入已核实的目标与事实，输出 `DeployStep[]`，便于单测。
 */
import type { DeployStep } from "./deploy-plan";

export interface StaticUpdateInput {
  /** 站点根目录（服务器绝对路径）。 */
  root: string;
  /** 服务器上的 dist.zip 绝对路径。 */
  zipPath: string;
  /** 用来验证的地址；默认本机 127.0.0.1。 */
  healthUrl?: string;
}

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * 验证步骤的输出是 **HTTP 状态码**（`curl -w '%{http_code}'`），不是容器状态。
 *
 * 2xx / 3xx 算通过；拿不到三位数就按失败处理，并把原始输出带回去 —— 别让一次
 * 成功的替换因为"读不懂输出"显示成未通过。
 */
export function verifyHttpStatus(output: string): { ok: boolean; reason: string } {
  const code = output.trim().split(/\s+/).pop() ?? "";
  if (!/^\d{3}$/.test(code)) {
    return { ok: false, reason: output.trim() || "没有读到 HTTP 状态码" };
  }
  const value = Number(code);
  return value >= 200 && value < 400
    ? { ok: true, reason: `HTTP ${code}` }
    : { ok: false, reason: `HTTP ${code}` };
}

export function buildStaticUpdatePlan({
  root,
  zipPath,
  healthUrl = "http://127.0.0.1/",
}: StaticUpdateInput): DeployStep[] {
  const staging = `/tmp/bls-site-$$`;
  const backup = `${root}.bak.$(date +%Y%m%d%H%M%S)`;

  return [
    {
      id: "static-inspect",
      kind: "verify",
      title: "检查 ZIP 布局与站点目录",
      detail: `${zipPath} → ${root}（只读：确认压缩包内是站点根，且目标目录可写）`,
      command: `unzip -l ${quote(zipPath)} | head -20; test -d ${quote(root)} && test -w ${quote(root)} && echo ok`,
      state: "pending",
    },
    {
      id: "static-backup",
      kind: "upload",
      title: "备份当前站点",
      detail: `整目录快照到 ${backup}，失败可直接回滚`,
      command: `cp -a ${quote(root)} ${backup}`,
      rollback: `rm -rf ${quote(root)} && cp -a ${backup} ${quote(root)}`,
      state: "pending",
    },
    {
      id: "static-replace",
      kind: "upload",
      title: "解压并替换静态文件",
      detail: `先在 ${staging} 展开并校验 index.html，再以 --delete 同步到 ${root}`,
      command: `rm -rf ${staging} && mkdir -p ${staging} && unzip -q ${quote(zipPath)} -d ${staging} && test -f ${staging}/index.html && rsync -a --delete ${staging}/ ${quote(root)}/ && rm -rf ${staging}`,
      state: "pending",
    },
    {
      id: "static-verify",
      kind: "verify",
      title: "验证站点响应",
      detail: `${healthUrl} 返回 2xx/3xx；失败保留备份，不自动回滚`,
      command: `curl -fsS -o /dev/null -w '%{http_code}' ${quote(healthUrl)}`,
      state: "pending",
    },
  ];
}
