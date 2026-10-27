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
import { CheckCircle2, FolderOpen, Loader2, ShieldCheck, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ErrorText, Field, Modal, fieldClass } from "@/components/ui/modal";
import { Select } from "@/components/ui/select";
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
}: {
  open: boolean;
  profile: DatabaseProfile | null;
  onClose: () => void;
  onSaved: (profile: DatabaseProfile) => void;
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

  const save = async () => {
    setError(null);
    if (!draft.name.trim()) {
      setError(t("连接名称不能为空"));
      return;
    }
    if (!draft.host.trim() || !draft.username.trim()) {
      setError(t("主机和用户名不能为空"));
      return;
    }
    if (draft.port < 1 || draft.port > 65535) {
      setError(t("端口必须在 1 到 65535 之间"));
      return;
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
      setError(toDbError(failure).message);
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

  return (
    <Modal
      open={open}
      title={profile ? t("编辑数据库连接") : t("新建数据库连接")}
      description={t(
        "密码保存在系统钥匙串，不会写入本地数据库，也不会回传到界面。",
      )}
      width={560}
      onClose={busy ? undefined : onClose}
      footer={
        <>
          <Button variant="ghost" size="sm" disabled={busy} onClick={onClose}>
            {t("取消")}
          </Button>
          <Button variant="secondary" size="sm" disabled={busy || testing} onClick={() => void runTest()}>
            {testing ? <Loader2 size={12} className="animate-spin" /> : <ShieldCheck size={12} />}
            {t("测试连接")}
          </Button>
          <Button variant="primary" size="sm" disabled={busy} onClick={() => void save()}>
            {busy ? t("保存中…") : t("保存")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-[150px_1fr] items-end gap-2 rounded-[8px] border border-line bg-surface-2/60 p-2">
          <Field label={t("数据库类型")}>
            <Select
              value={draft.engine}
              ariaLabel={t("数据库类型")}
              onChange={(value) =>
                patch({ engine: value as DatabaseProfile["engine"] })
              }
              options={[
                { value: "mysql", label: t("MySQL（不区分版本）"), hint: "MySQL 8.x" },
                {
                  value: "mariadb",
                  label: t("MariaDB（尚未实现）"),
                  disabled: true,
                },
                {
                  value: "postgres",
                  label: t("PostgreSQL（尚未实现）"),
                  disabled: true,
                },
                { value: "sqlite", label: t("SQLite（尚未实现）"), disabled: true },
                {
                  value: "sqlserver",
                  label: t("SQL Server（尚未实现）"),
                  disabled: true,
                },
                { value: "oracle", label: t("Oracle（尚未实现）"), disabled: true },
              ]}
            />
          </Field>
          <p className="pb-0.5 text-[10px] leading-relaxed text-fg-subtle">
            {t(
              "MySQL 使用原生协议驱动，不区分 8.0/8.4 小版本。其它引擎只保留适配器边界，当前版本不可选。",
            )}
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
          <Field label={t("用户名")}>
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

        <Field label={t("默认数据库（可选）")}>
          <input
            className={fieldClass}
            value={draft.default_database ?? ""}
            onChange={(event) =>
              patch({ default_database: event.target.value.trim() || null })
            }
            placeholder={t("留空则连接后手动选择")}
          />
        </Field>

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
            {t(
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
    </Modal>
  );
}
