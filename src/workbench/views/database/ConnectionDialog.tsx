/**
 * 新建 / 编辑数据库连接，并可以**在保存前**先测一次。
 *
 * 测试连接不落库：`db_test_connection` 接收整份表单（包括临时密码），
 * 用它建立一条真实连接后立即断开，返回阶段、耗时、服务器版本与 TLS 状态。
 * 失败时把 `stage`（ssh_tunnel / tcp / tls / auth / database）原样展示，
 * 而不是一句"连接失败"。
 */
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { CheckCircle2, FolderOpen, Loader2, ShieldCheck, TriangleAlert } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { ErrorText, Field, Modal, fieldClass } from "@/components/ui/modal";
import { Select } from "@/components/ui/select";
import { pushToast } from "@/components/ui/toast";
import { DbEngineIcon } from "./DbEngineIcon";
import {
  DB_ENGINES,
  engineMeta,
  isDefaultPort,
  isEngineSupported,
  isFileEngine,
  usernameForEngine,
} from "./db-engines";
import type {
  ConnectionTestResult,
  DatabaseProfile,
  TlsMode,
} from "@/api/types/database";
import { useDomainStore } from "@/stores/domain-store";
import { toDbError, useDatabaseStore } from "@/stores/database-store";

const STAGE_LABEL: Record<string, string> = {
  config: "配置",
  ssh_tunnel: "SSH 隧道",
  tcp: "网络连接",
  tls: "TLS 证书",
  auth: "身份认证",
  database: "数据库选择",
  query: "查询",
  permission: "权限",
  cancelled: "已取消",
  timeout: "超时",
  outcome_unknown: "结果未知",
  unsupported: "不支持",
  budget: "预算限制",
};

function newProfile(): DatabaseProfile {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    name: "",
    engine: "mysql",
    host: "127.0.0.1",
    port: 3306,
    username: "root",
    default_database: null,
    has_password: false,
    ssh_server_id: null,
    tls_mode: "disabled",
    tls_ca_path: null,
    tls_server_name: null,
    read_only: true,
    redis_mode: null,
    sentinel_master: null,
    nodes_json: null,
    connect_timeout_ms: 10_000,
    query_timeout_ms: 60_000,
    created_at: now,
    updated_at: now,
  };
}

export function ConnectionDialog({
  open,
  profile,
  onClose,
  onSaved,
  variant = "modal",
}: {
  open: boolean;
  profile: DatabaseProfile | null;
  onClose: () => void;
  onSaved: (profile: DatabaseProfile) => void;
  /**
   * `inline`：作为标签页内容渲染（新建连接走这条路径），不再套一层弹窗。
   * 表单本身完全复用 —— 两种形态下校验、测试连接、保存逻辑都不该有两份。
   */
  variant?: "modal" | "inline";
}) {
  const { t } = useTranslation();
  const servers = useDomainStore((state) => state.servers);
  const saveProfile = useDatabaseStore((state) => state.saveProfile);
  const testConnection = useDatabaseStore((state) => state.testConnection);

  const [draft, setDraft] = useState<DatabaseProfile>(newProfile);
  const [password, setPassword] = useState("");
  const [clearPassword, setClearPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<ConnectionTestResult | null>(null);

  useEffect(() => {
    if (!open) return;
    setDraft(profile ? { ...profile } : newProfile());
    setPassword("");
    setClearPassword(false);
    setError(null);
    setTest(null);
  }, [open, profile]);

  const sshServers = useMemo(
    () => servers.filter((server) => server.status !== "disabled"),
    [servers],
  );

  const patch = (value: Partial<DatabaseProfile>) =>
    setDraft((current) => ({ ...current, ...value }));

  /** 有真实驱动的引擎才给"测试连接"；其余允许先存配置。 */
  const engineSupported = isEngineSupported(draft.engine);
  const fileEngine = isFileEngine(draft.engine);
  const meta = engineMeta(draft.engine);

  /**
   * 切引擎时联动默认值：
   * - 端口只在"当前值还是某个默认端口"时才跟着换，不覆盖用户手填的端口；
   * - 文件型（SQLite）没有主机/端口/用户名，清掉以免留下误导性配置。
   */
  const changeEngine = (engine: DatabaseProfile["engine"]) => {
    const next = engineMeta(engine);
    if (next.transport === "file") {
      patch({
        engine,
        host: "",
        port: 0,
        username: "",
        ssh_server_id: null,
        tls_mode: "disabled",
        tls_ca_path: null,
        tls_server_name: null,
        redis_mode: null,
      });
      return;
    }
    patch({
      engine,
      port: isDefaultPort(draft.port) ? next.defaultPort : draft.port,
      // 用户名只有 MySQL/MariaDB 有默认值：切到 Redis 时清掉自动填的 root，
      // 否则会拿 root 去 AUTH 一个空密码，默认配置永远连不上。
      username: usernameForEngine(next.id, draft.username),
      redis_mode: next.id === "redis" ? (draft.redis_mode ?? "standalone") : null,
    });
  };

  const save = async () => {
    setError(null);
    if (!draft.name.trim()) {
      setError(t("连接名称不能为空"));
      return;
    }
    if (fileEngine) {
      // 文件型数据库：库就是文件路径，没有主机/端口/用户名。
      if (!(draft.default_database ?? "").trim()) {
        setError(t("请填写数据库文件路径"));
        return;
      }
    } else {
      // Redis 6+ 的 ACL 才有用户名：Redis 不强制用户名。
      const usernameRequired = draft.engine !== "redis";
      if (!draft.host.trim() || (usernameRequired && !draft.username.trim())) {
        setError(t("主机和用户名不能为空"));
        return;
      }
      if (draft.port < 1 || draft.port > 65535) {
        setError(t("端口必须在 1 到 65535 之间"));
        return;
      }
    }
    setBusy(true);
    try {
      const passwordValue = clearPassword ? "" : password ? password : null;
      const saved = await saveProfile(
        { ...draft, updated_at: Date.now() },
        passwordValue,
      );
      onSaved(saved);
      onClose();
    } catch (failure) {
      const info = toDbError(failure);
      setError(info.message);
      pushToast(info.message, "error", {
        title: t("保存连接失败"),
        label: info.stage,
        detail: info.detail ?? undefined,
        persist: true,
      });
    } finally {
      setBusy(false);
    }
  };

  const runTest = async () => {
    setError(null);
    setTest(null);
    setTesting(true);
    try {
      const passwordValue = clearPassword ? "" : password ? password : profile ? null : "";
      const result = await testConnection(draft, passwordValue);
      setTest(result);
    } catch (failure) {
      const info = toDbError(failure);
      setTest({
        ok: false,
        stage: info.stage,
        error: info,
        latency_ms: 0,
        server_version: null,
        connection_id: null,
        tls: null,
        tunnel_local_port: null,
        read_only: draft.read_only,
      });
      // 结果面板在表单下方，屏幕小的时候看不见 —— 同样弹到顶部。
      pushToast(info.message, "error", {
        title: t("测试连接失败"),
        label: info.stage,
        detail: info.detail ?? undefined,
        persist: false,
      });
    } finally {
      setTesting(false);
    }
  };

  const browseCa = async () => {
    try {
      const { open: openFileDialog } = await import("@tauri-apps/plugin-dialog");
      const path = await openFileDialog({
        multiple: false,
        filters: [
          { name: "CA certificate", extensions: ["pem", "crt", "cer", "der"] },
        ],
      });
      if (typeof path === "string") patch({ tls_ca_path: path });
    } catch {
      // 用户取消或对话框不可用：保留手填路径。
    }
  };

  const title = profile ? t("编辑数据库连接") : t("新建数据库连接");
  const description = t(
    "密码保存在系统钥匙串，不会写入本地数据库，也不会回传到界面。",
  );

  const footer = (
    <>
      <Button variant="ghost" size="sm" disabled={busy} onClick={onClose}>
        {t("取消")}
      </Button>
      <Button
        variant="secondary"
        size="sm"
        disabled={busy || testing || !engineSupported}
        title={engineSupported ? undefined : t("该类型尚未适配，暂不能测试连接")}
        onClick={() => void runTest()}
      >
        {testing ? <Loader2 size={12} className="animate-spin" /> : <ShieldCheck size={12} />}
        {t("测试连接")}
      </Button>
      <Button variant="primary" size="sm" disabled={busy} onClick={() => void save()}>
        {busy ? t("保存中…") : t("保存")}
      </Button>
    </>
  );

  const body = (
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-[220px_1fr] items-end gap-2 rounded-[8px] border border-line bg-surface-2/60 p-2">
          <Field label={t("数据库类型")}>
            <Select
              value={draft.engine}
              ariaLabel={t("数据库类型")}
              onChange={(value) => changeEngine(value as DatabaseProfile["engine"])}
              options={DB_ENGINES.map((engine) => ({
                // 未适配的引擎也可以选：先把连接配置存下来，等适配完直接能用。
                value: engine.id,
                label: engine.supported
                  ? engine.label
                  : `${engine.label}（${t("尚未适配")}）`,
                icon: <DbEngineIcon engine={engine.id} connected size={13} />,
                hint:
                  engine.id === "mysql"
                    ? "MySQL 8.x"
                    : engine.id === "redis"
                      ? "Redis 6+"
                      : engine.id === "mariadb"
                        ? t("按 MySQL 协议")
                        : engine.transport === "file"
                          ? t("文件型")
                          : undefined,
              }))}
            />
          </Field>
          <p className="pb-0.5 text-11 leading-relaxed text-fg-subtle">
            {draft.engine === "redis"
              ? t(
                  "Redis 走独立的键浏览器（SCAN / 类型化读写 / TTL / 发布订阅），不提供 SQL 工作台。",
                )
              : draft.engine === "mariadb"
                ? t("MariaDB 与 MySQL 同协议，直接按 MySQL 连接；个别认证插件可能需在服务端调整。")
                : engineSupported
                  ? t("连接使用原生协议驱动，不区分小版本。")
                  : t("该类型尚未适配：可以先保存连接配置，连接时会明确提示暂不支持。")}
          </p>
        </div>

        <Field label={t("连接名称")}>
          <input
            className={fieldClass}
            value={draft.name}
            onChange={(event) => patch({ name: event.target.value })}
            placeholder={t("例如：生产订单库")}
          />
        </Field>

        {/* 文件型数据库没有主机/端口/账号：显示这些字段只会让人以为要填。 */}
        {!fileEngine && (
          <>
            <div className="grid grid-cols-[1fr_100px] gap-2">
              <Field label={t("主机")}>
                <input
                  className={fieldClass}
                  value={draft.host}
                  onChange={(event) => patch({ host: event.target.value })}
                  placeholder="db.internal"
                />
              </Field>
              <Field label={t("端口")}>
                <input
                  className={fieldClass}
                  type="number"
                  min={1}
                  max={65535}
                  value={draft.port}
                  onChange={(event) => patch({ port: Number(event.target.value) || 0 })}
                />
              </Field>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <Field
                label={draft.engine === "redis" ? t("用户名（ACL，可选）") : t("用户名")}
                hint={
                  draft.engine === "redis"
                    ? t("Redis 6+ ACL 才有用户名；留空 = 只用密码")
                    : undefined
                }
              >
                <input
                  className={fieldClass}
                  value={draft.username}
                  onChange={(event) => patch({ username: event.target.value })}
                />
              </Field>
              <Field
                label={t("密码")}
                hint={
                  profile?.has_password && !clearPassword
                    ? t("留空 = 保留系统钥匙串里的密码")
                    : draft.engine === "redis"
                      ? t("Redis 默认没有密码；只有开了 requirepass / ACL 才需要填")
                      : undefined
                }
              >
                <input
                  className={fieldClass}
                  type="password"
                  value={password}
                  disabled={clearPassword}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder={profile?.has_password ? "••••••••" : ""}
                />
              </Field>
            </div>

            {profile?.has_password && (
              <label className="flex items-center gap-1.5 text-11 text-fg-muted">
                <input
                  type="checkbox"
                  checked={clearPassword}
                  onChange={(event) => {
                    setClearPassword(event.target.checked);
                    if (event.target.checked) setPassword("");
                  }}
                />
                {t("清除已保存的密码（连接将使用空密码）")}
              </label>
            )}
          </>
        )}

        <Field label={t(meta.databaseLabel)}>
          <input
            className={fieldClass}
            value={draft.default_database ?? ""}
            onChange={(event) =>
              patch({ default_database: event.target.value.trim() || null })
            }
            placeholder={t(meta.databasePlaceholder)}
          />
        </Field>

        {draft.engine === "redis" && (
          <div className="rounded-[8px] border border-line bg-surface-2/60 p-2">
            <div className="mb-1.5 text-11 font-medium text-fg-muted">{t("Redis 连接模式")}</div>
            <div className="grid grid-cols-2 gap-2">
              <Field label={t("模式")}>
                <Select
                  value={draft.redis_mode ?? "standalone"}
                  ariaLabel={t("Redis 连接模式")}
                  onChange={(value) =>
                    patch({ redis_mode: value as DatabaseProfile["redis_mode"] })
                  }
                  options={[
                    { value: "standalone", label: t("单机（Standalone）"), hint: t("支持 SSH 隧道") },
                    { value: "sentinel", label: t("哨兵（Sentinel）"), hint: t("直连，不走隧道") },
                    { value: "cluster", label: t("集群（Cluster）"), hint: t("直连，仅 db 0") },
                  ]}
                />
              </Field>
              {(draft.redis_mode ?? "standalone") === "sentinel" && (
                <Field label={t("Master 名称")} hint={t("sentinel.conf 里的 mymaster 之类的名字")}>
                  <input
                    className={fieldClass}
                    value={draft.sentinel_master ?? ""}
                    onChange={(event) =>
                      patch({ sentinel_master: event.target.value.trim() || null })
                    }
                    placeholder="mymaster"
                  />
                </Field>
              )}
            </div>
            {draft.redis_mode === "sentinel" && (
              <div className="mt-2">
                <Field
                  label={t("其余哨兵节点（可选，JSON 数组）")}
                  hint={t("例如 [\"10.0.0.2:26379\",\"10.0.0.3:26379\"]；主机:端口已包含首个哨兵")}
                >
                  <input
                    className={fieldClass}
                    value={draft.nodes_json ?? ""}
                    onChange={(event) =>
                      patch({ nodes_json: event.target.value.trim() || null })
                    }
                  />
                </Field>
              </div>
            )}
            {draft.redis_mode === "cluster" && (
              <div className="mt-2">
                <Field
                  label={t("其余集群节点（可选，JSON 数组）")}
                  hint={t("至少给出一个可达节点即可，客户端会自动发现其余分片")}
                >
                  <input
                    className={fieldClass}
                    value={draft.nodes_json ?? ""}
                    onChange={(event) =>
                      patch({ nodes_json: event.target.value.trim() || null })
                    }
                  />
                </Field>
              </div>
            )}
            {(draft.redis_mode ?? "standalone") !== "standalone" && (
              <p className="mt-2 text-11 leading-relaxed text-fg-subtle">
                {t(
                  "哨兵/集群模式下所有节点必须能从本机直连（不支持经 SSH 隧道），且当前版本不支持订阅（pub/sub）。",
                )}
              </p>
            )}
          </div>
        )}

        <div className="rounded-[8px] border border-line p-2">
          <div className="mb-1.5 text-11 font-medium text-fg-muted">{t("SSH 隧道")}</div>
          <div className="grid grid-cols-2 gap-2">
            <Field label={t("SSH 服务器")} hint={t("复用已保存的 SSH 凭据与主机指纹") }>
              <Select
                value={draft.ssh_server_id ?? ""}
                ariaLabel={t("SSH 服务器")}
                onChange={(value) => patch({ ssh_server_id: value || null })}
                options={[
                  { value: "", label: t("直连（不使用隧道）") },
                  ...sshServers.map((server) => ({
                    value: server.id,
                    label: server.name,
                    hint: `${server.username}@${server.host}:${server.port}`,
                  })),
                ]}
              />
            </Field>
            <Field label={t("TLS 模式")} hint={t("选择 required 后绝不自动降级为明文") }>
              <Select
                value={draft.tls_mode}
                ariaLabel={t("TLS 模式")}
                onChange={(value) => patch({ tls_mode: value as TlsMode })}
                options={[
                  { value: "disabled", label: t("不加密（明文）") },
                  {
                    value: "verify_ca",
                    label: t("验证证书链（名称按下方验证名称）"),
                  },
                  { value: "verify_identity", label: t("验证证书链 + 主机名") },
                ]}
              />
            </Field>
          </div>

          {draft.tls_mode !== "disabled" && (
            <>
              <div className="mt-2 grid grid-cols-[1fr_auto] gap-2">
                <Field label={t("CA 证书路径（可选）")}>
                  <input
                    className={fieldClass}
                    value={draft.tls_ca_path ?? ""}
                    onChange={(event) => patch({ tls_ca_path: event.target.value || null })}
                    placeholder={t("留空使用内置公共根证书")}
                  />
                </Field>
                <div className="flex items-end">
                  <Button variant="ghost" size="sm" onClick={() => void browseCa()}>
                    <FolderOpen size={12} />
                    {t("浏览…")}
                  </Button>
                </div>
              </div>
              <div className="mt-2">
                <Field
                  label={t("TLS 验证名称（可选）")}
                  hint={t("SSH 隧道时用于校验证书的主机名；留空使用数据库主机名")}
                >
                  <input
                    className={fieldClass}
                    value={draft.tls_server_name ?? ""}
                    onChange={(event) =>
                      patch({ tls_server_name: event.target.value || null })
                    }
                  />
                </Field>
              </div>
            </>
          )}
        </div>

        <div className="grid grid-cols-2 gap-2">
          <Field label={t("连接超时（毫秒）")}>
            <input
              className={fieldClass}
              type="number"
              min={1000}
              max={60000}
              step={1000}
              value={draft.connect_timeout_ms}
              onChange={(event) =>
                patch({ connect_timeout_ms: Number(event.target.value) || 10_000 })
              }
            />
          </Field>
          <Field label={t("查询超时（毫秒）")}>
            <input
              className={fieldClass}
              type="number"
              min={1000}
              max={600000}
              step={1000}
              value={draft.query_timeout_ms}
              onChange={(event) =>
                patch({ query_timeout_ms: Number(event.target.value) || 60_000 })
              }
            />
          </Field>
        </div>

        <label className="flex items-start gap-2 rounded-[8px] border border-line bg-surface-2/40 px-2 py-1.5">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={draft.read_only}
            onChange={(event) => patch({ read_only: event.target.checked })}
          />
          <span className="text-11 leading-relaxed text-fg-muted">
            {draft.engine === "redis"
              ? t(
                  "只读连接：键的写入、删除、TTL 修改与 PUBLISH 都会被拒绝，只能浏览。要修改数据请显式关闭。",
                )
              : t(
                  "只读连接：连接后执行 SET SESSION TRANSACTION READ ONLY，写语句会被服务器拒绝。要修改数据请显式关闭。",
                )}
          </span>
        </label>

        {error && <ErrorText>{error}</ErrorText>}

        {test && (
          <div
            className={
              test.ok
                ? "rounded-[8px] border border-success/30 bg-success/10 px-2 py-1.5 text-11 text-success"
                : "rounded-[8px] border border-danger/30 bg-danger/10 px-2 py-1.5 text-11 text-danger"
            }
          >
            <div className="flex items-center gap-1.5 font-medium">
              {test.ok ? <CheckCircle2 size={12} /> : <TriangleAlert size={12} />}
              {test.ok
                ? t("连接成功 · {{ms}} ms", { ms: test.latency_ms })
                : t("{{stage}} 阶段失败", {
                    stage: STAGE_LABEL[test.stage] ?? test.stage,
                  })}
            </div>
            {test.ok && (
              <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-10 opacity-90">
                {test.server_version && <span>MySQL {test.server_version}</span>}
                {test.connection_id !== null && <span>#{test.connection_id}</span>}
                <span>
                  {t("TLS")}: {test.tls?.active ? `${test.tls.cipher ?? ""} ${test.tls.version ?? ""}` : t("未加密")}
                </span>
                {test.tunnel_local_port !== null && (
                  <span>
                    {t("隧道")}: 127.0.0.1:{test.tunnel_local_port}
                  </span>
                )}
                {test.read_only && <span>{t("只读")}</span>}
              </div>
            )}
            {!test.ok && test.error && (
              <div className="mt-0.5 text-10 leading-relaxed opacity-90">
                {test.error.code !== null && (
                  <span className="mr-1">
                    [{test.error.code}
                    {test.error.sql_state ? ` ${test.error.sql_state}` : ""}]
                  </span>
                )}
                {test.error.message}
                {test.error.detail && (
                  <div className="mt-0.5 opacity-80">{test.error.detail}</div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
  );

  // 新建连接：作为标签页内容渲染，不再套弹窗。
  if (variant === "inline") {
    return (
      <div className="flex h-full min-h-0 flex-col bg-surface-1">
        <div className="flex shrink-0 flex-col gap-0.5 border-b border-line px-4 py-2.5">
          <span className="text-13 font-medium text-fg">{title}</span>
          <span className="text-11 text-fg-subtle">{description}</span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">{body}</div>
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-line px-4 py-2">
          {footer}
        </div>
      </div>
    );
  }

  return (
    <Modal
      open={open}
      title={title}
      description={description}
      width={680}
      onClose={busy ? undefined : onClose}
      footer={footer}
    >
      {body}
    </Modal>
  );
}
