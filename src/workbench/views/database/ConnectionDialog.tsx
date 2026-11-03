/**
 * 新建 / 编辑数据库连接，并可以**在保存前**先测一次。
 *
 * 测试连接不落库：`db_test_connection` 接收整份表单（包括临时密码），
 * 用它建立一条真实连接后立即断开，返回阶段、耗时、服务器版本与 TLS 状态。
 * 失败时把 `stage`（ssh_tunnel / tcp / tls / auth / database）原样展示，
 * 而不是一句"连接失败"。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  CheckCircle2,
  ChevronRight,
  Eye,
  EyeOff,
  FolderOpen,
  Loader2,
  Lock,
  Plug,
  TriangleAlert,
} from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ErrorText, Field, Modal } from "@/components/ui/modal";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/cn";
import { stageLabel, toAppError } from "@/lib/app-error";
import { EngineSelect } from "./EngineSelect";
import { SegmentedControl } from "@/workbench/page-layout";
import "./connection-form.css";
import {
  capabilityReason,
  engineMeta,
  engineOptionsFor,
  isDefaultPort,
  isEngineSupported,
  usernameForEngine,
} from "./db-engines";
import { useEngineCatalog } from "./useEngineCatalog";
import type {
  ConnectionTestResult,
  DatabaseProfile,
  DbErrorInfo,
  EngineOptions,
  OptionField,
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

/** 连接表单里的鉴权分区；只切界面，不改变已填内容。 */
type AuthTab = "credentials" | "tls";

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
    // 默认**可写**：只读是显式的安全开关，不该是每个新连接的默认状态，
    // 否则用户建完连接发现"应用"永远是灰的，还找不到原因。
    read_only: false,
    redis_mode: null,
    sentinel_master: null,
    nodes_json: null,
    engine_options: {},
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
  /** 保存失败的结构化错误：只在这里显示一次，不再另弹全局提示。 */
  const [saveFailure, setSaveFailure] = useState<DbErrorInfo | null>(null);
  const [test, setTest] = useState<ConnectionTestResult | null>(null);
  const testResultRef = useRef<HTMLDivElement>(null);
  /** 引擎清单展开、鉴权分区、高级选项与密码明文：纯界面状态，不落配置。 */
  const [engineOpen, setEngineOpen] = useState(false);
  const [authTab, setAuthTab] = useState<AuthTab>("credentials");
  const [advanced, setAdvanced] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  useEffect(() => {
    if (!open) return;
    setDraft(profile ? { ...profile } : newProfile());
    setPassword("");
    setClearPassword(false);
    setError(null);
    setTest(null);
    setEngineOpen(false);
    setAuthTab("credentials");
    setAdvanced(false);
    setShowPassword(false);
  }, [open, profile]);

  /**
   * 可用的 SSH 服务器：禁用的一律不列，但**当前已选的那个例外** —— 否则
   * 编辑一条指向"已禁用服务器"的旧连接时，选择框会空着，用户以为配置丢了。
   */
  const sshServers = useMemo(() => {
    const active = servers.filter((server) => server.status !== "disabled");
    const current = servers.find((server) => server.id === draft.ssh_server_id);
    return current && !active.includes(current) ? [current, ...active] : active;
  }, [servers, draft.ssh_server_id]);

  const patch = (value: Partial<DatabaseProfile>) =>
    setDraft((current) => ({ ...current, ...value }));

  const catalog = useEngineCatalog();
  /** 有真实驱动的引擎才给"测试连接"；其余允许先存配置。 */
  const engineSupported = isEngineSupported(draft.engine);
  const meta = engineMeta(draft.engine);
  const descriptor = meta.descriptor;
  const fields = descriptor?.fields;

  /** 隧道是否启用**只**由 `ssh_server_id` 决定，界面不另存一份模式状态。 */
  const tunnelOn = Boolean(draft.ssh_server_id);
  const requiredOptions = descriptor?.options.filter((field) => field.required) ?? [];
  const optionalOptions = descriptor?.options.filter((field) => !field.required) ?? [];
  /** 只给这个引擎真有的分区：SQLite 没有账号与 TLS，就不显示空分区。 */
  const authTabs: AuthTab[] = [];
  if (fields?.username || fields?.password) authTabs.push("credentials");
  if (fields?.tls) authTabs.push("tls");
  const activeAuthTab: AuthTab = authTabs.includes(authTab)
    ? authTab
    : (authTabs[0] ?? "credentials");

  /**
   * 切引擎时联动默认值，全部由注册表声明驱动：
   * - 端口只在"当前值还是某个默认端口"时才跟着换，不覆盖用户手填的端口；
   * - 目标引擎没有的字段一律清空（host/username/TLS/SSH），不留误导性配置；
   * - `engine_options` 只保留目标引擎声明过的键。
   */
  const changeEngine = (engine: DatabaseProfile["engine"]) => {
    const next = engineMeta(engine);
    const nextFields = next.descriptor?.fields;
    patch({
      engine,
      host: nextFields?.host ? draft.host || "127.0.0.1" : "",
      port: nextFields?.port
        ? isDefaultPort(draft.port)
          ? next.defaultPort
          : draft.port
        : 0,
      username: nextFields?.username ? usernameForEngine(engine, draft.username) : "",
      engine_options: engineOptionsFor(engine, draft.engine_options),
      ssh_server_id: nextFields?.ssh_tunnel ? draft.ssh_server_id : null,
      tls_mode: nextFields?.tls ? draft.tls_mode : "disabled",
      tls_ca_path: nextFields?.tls ? draft.tls_ca_path : null,
      tls_server_name: nextFields?.tls ? draft.tls_server_name : null,
      redis_mode: engine === "redis" ? (draft.redis_mode ?? "standalone") : null,
    });
  };

  /**
   * 直连 / SSH 隧道的切换：只改 `ssh_server_id`，不保留第二份"模式"状态。
   * 打开隧道时若还没选服务器，自动带上第一个可用项 —— 否则表单会停在一个
   * "说走隧道却没有目标"的中间状态。
   */
  const setTunnel = (on: boolean) => {
    if (!on) {
      patch({ ssh_server_id: null });
      return;
    }
    patch({ ssh_server_id: draft.ssh_server_id ?? sshServers[0]?.id ?? null });
  };

  /** `engine_options` 的单字段读写；未知键不会在这里产生。 */
  const optionValue = (field: OptionField): string | boolean | undefined => {
    const options = draft.engine_options as Record<string, unknown>;
    const value = options[field.key];
    return typeof value === "string" || typeof value === "boolean" ? value : undefined;
  };

  const setOption = (field: OptionField, value: string | boolean | undefined) => {
    const next: EngineOptions = { ...draft.engine_options };
    const target = next as Record<string, unknown>;
    if (value === undefined || value === "") delete target[field.key];
    else target[field.key] = value;
    patch({ engine_options: next });
  };

  const browseSqlitePath = async (field: OptionField) => {
    try {
      const { open: openFileDialog } = await import("@tauri-apps/plugin-dialog");
      const selected = await openFileDialog({
        multiple: false,
        filters: [{ name: "SQLite", extensions: ["db", "sqlite", "sqlite3"] }],
      });
      if (typeof selected === "string") setOption(field, selected);
    } catch {
      // 用户取消或对话框不可用：保留手填路径。
    }
  };

  /** 引擎专属字段的统一渲染：必填的进连接区，可选的收进高级选项。 */
  const renderOption = (field: OptionField) => {
    const label = t(field.label);
    const value = optionValue(field);
    if (field.kind.kind === "bool") {
      return (
        <label key={field.key} className="flex items-center gap-1.5 text-11 text-fg-muted">
          <input
            type="checkbox"
            className="accent-accent"
            checked={value === true}
            onChange={(event) => setOption(field, event.target.checked)}
          />
          {label}
        </label>
      );
    }
    if (field.kind.kind === "enum") {
      return (
        <Field key={field.key} label={label} required={field.required}>
          <Select
            value={typeof value === "string" ? value : field.kind.values[0]}
            ariaLabel={label}
            onChange={(next) => setOption(field, next)}
            options={field.kind.values.map((option) => ({ value: option, label: option }))}
          />
        </Field>
      );
    }
    return (
      <Field key={field.key} label={label} required={field.required}>
        <div className="flex items-center gap-2">
          <Input
            value={typeof value === "string" ? value : ""}
            onChange={(event) => setOption(field, event.target.value)}
            placeholder={field.placeholder}
          />
          {field.kind.kind === "path" && (
            <Button variant="ghost" size="sm" onClick={() => void browseSqlitePath(field)}>
              <FolderOpen size={12} />
              {t("浏览…")}
            </Button>
          )}
        </div>
      </Field>
    );
  };

  /** 高级选项折叠时的摘要：全是当前真实值，不写死。 */
  const advancedSummary = [
    `${Math.round(draft.connect_timeout_ms / 1_000)}s / ${Math.round(draft.query_timeout_ms / 1_000)}s`,
    ...optionalOptions
      .map((field) => {
        const value = optionValue(field);
        return value === undefined || value === "" ? null : `${field.key}: ${String(value)}`;
      })
      .filter((part): part is string => part !== null),
  ].join(" · ");

  const save = async () => {
    setError(null);
    setSaveFailure(null);
    if (!draft.name.trim()) {
      setError(t("连接名称不能为空"));
      return;
    }
    // 必填项由注册表声明：文件型要路径，MongoDB 允许 URI 替代主机，
    // Oracle 要服务名，Redis 不强制用户名。
    const required = descriptor?.requirements;
    if (required?.endpoint === "file_path") {
      if (!(draft.engine_options.path ?? "").trim()) {
        setError(t("请填写数据库文件路径"));
        return;
      }
    } else if (required?.endpoint === "uri_or_host") {
      const hasUri = Boolean((draft.engine_options.uri ?? "").trim());
      if (!hasUri && !draft.host.trim()) {
        setError(t("请填写主机，或提供连接 URI"));
        return;
      }
      if (!hasUri && (draft.port < 1 || draft.port > 65535)) {
        setError(t("端口必须在 1 到 65535 之间"));
        return;
      }
    } else {
      if (!draft.host.trim()) {
        setError(t("数据库主机不能为空"));
        return;
      }
      if (draft.port < 1 || draft.port > 65535) {
        setError(t("端口必须在 1 到 65535 之间"));
        return;
      }
    }
    if (required?.username && !draft.username.trim()) {
      setError(t("用户名不能为空"));
      return;
    }
    if (required?.database && !(draft.default_database ?? "").trim()) {
      setError(t(draft.engine === "oracle" ? "请填写服务名 / SID" : "请填写数据库名"));
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
      // 表单里就地显示（含阶段与恢复建议）。**不再**同时推一条全局提示：
      // 同一个错误说两遍，用户会以为是两次失败，也会挡住表单。
      setSaveFailure(toDbError(failure));
    } finally {
      setBusy(false);
    }
  };

  const runTest = async () => {
    setError(null);
    setSaveFailure(null);
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
        connection: null,
        tls: null,
        tunnel_local_port: null,
        read_only: draft.read_only,
      });
    } finally {
      setTesting(false);
    }
  };

  /**
   * 测试结果在表单末尾，屏幕小时看不见 —— 出结果后滚过去，而不是再弹一条
   * 重复的错误通知。用户看到的永远是**一处**结果。
   */
  useEffect(() => {
    if (!test) return;
    const frame = window.requestAnimationFrame(() =>
      testResultRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }),
    );
    return () => window.cancelAnimationFrame(frame);
  }, [test]);

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

  /**
   * 测试连接放最左：它只影响信心、不提交任何东西，和右侧的"取消 / 保存"
   * 是两类动作。`mr-auto` 在两种外壳（弹窗 / 标签页）里都把它推到另一端。
   */
  const footer = (
    <>
      <Button
        variant="outline"
        size="sm"
        className="mr-auto"
        disabled={busy || testing || !engineSupported}
        title={engineSupported ? undefined : t("该类型尚未适配，暂不能测试连接")}
        onClick={() => void runTest()}
      >
        {testing ? <Loader2 size={12} className="animate-spin" /> : <Plug size={12} />}
        {t("测试连接")}
      </Button>
      <Button variant="ghost" size="sm" disabled={busy} onClick={onClose}>
        {t("取消")}
      </Button>
      <Button variant="primary" size="sm" disabled={busy} onClick={() => void save()}>
        {busy ? t("保存中…") : profile ? t("保存") : t("保存并连接")}
      </Button>
    </>
  );

  const body = !catalog.ready ? (
    <div className="rounded-[8px] border border-line bg-surface-2/50 p-3 text-11 leading-relaxed text-fg-muted">
      {catalog.error ? (
        <div className="flex flex-col items-start gap-2">
          <span className="text-danger">
            {t("无法读取数据库引擎目录")}：{catalog.error}
          </span>
          <Button variant="secondary" size="sm" onClick={catalog.reload}>
            {t("重试")}
          </Button>
        </div>
      ) : (
        <span className="flex items-center gap-1.5">
          <Loader2 size={12} className="animate-spin" />
          {t("正在读取数据库引擎目录…")}
        </span>
      )}
    </div>
  ) : (
      <div className="db-connection-form flex flex-col">
        <EngineSelect
          engine={draft.engine}
          originalEngine={profile?.engine ?? null}
          open={engineOpen}
          onToggle={() => setEngineOpen((open) => !open)}
          onSelect={(engine) => {
            changeEngine(engine);
            setEngineOpen(false);
          }}
        />

        {/* 旧配置兼容：引擎被移出一级入口后，编辑这条连接时要说明"为什么
            类型列表里找不到它了"，而不是让用户以为产品被删了或认错了类型。 */}
        {meta.hiddenReason && (
          <p className="rounded-[6px] border border-line bg-surface-2/50 px-2 py-1 text-11 leading-relaxed text-fg-subtle">
            {t("该类型已移出新建连接列表：{{reason}}", { reason: t(meta.hiddenReason) })}
          </p>
        )}

        <Field label={t("连接名称")} required>
          <Input
            value={draft.name}
            onChange={(event) => patch({ name: event.target.value })}
            placeholder={t("例如：生产订单库")}
          />
        </Field>

        {/* 必填的引擎专属字段（SQLite 的库文件路径）就是连接地址，不进高级选项。 */}
        {requiredOptions.map(renderOption)}

        {/* 字段可见性由注册表声明：文件型没有主机/端口/账号，MongoDB 允许 URI。 */}
        {fields?.host && (
          <>
            {fields.ssh_tunnel && (
              <div className="db-connection-section-heading page-form-heading">
                <span>{t("连接方式")}</span>
                <div title={sshServers.length === 0 ? t("还没有可用的 SSH 服务器") : undefined}>
                  <SegmentedControl value={tunnelOn ? "ssh" : "direct"}
                    onChange={value => setTunnel(value === "ssh")} label={t("连接方式")}
                    items={[{ id: "direct", label: t("直连") },
                      { id: "ssh", label: t("SSH 隧道"), disabled: sshServers.length === 0 }]} />
                </div>
              </div>
            )}
            <div className="db-connection-endpoint grid items-end gap-3">
              <Field label={t("主机")} required={descriptor?.requirements.endpoint === "host_port"}>
                <Input aria-label={t("主机")} value={draft.host}
                  onChange={event => patch({ host: event.target.value })} placeholder="db.internal" />
              </Field>
              <Field label={t("端口")} required>
                <div className="relative flex items-center">
                  <Input
                    type="number"
                    min={1}
                    max={65535}
                    className={test?.ok ? "pr-14" : undefined}
                    value={draft.port}
                    onChange={(event) => patch({ port: Number(event.target.value) || 0 })}
                  />
                  {/* 端口旁边直接显示上次实测往返：选端口时最想知道的就是"这个通不通"。 */}
                  {test?.ok && test.latency_ms > 0 && (
                    <span
                      className="pointer-events-none absolute right-1.5 rounded-[4px] bg-success/12 px-1 text-10 leading-4 text-success"
                      title={t("最近一次测试连接耗时")}
                    >
                      {test.latency_ms} ms
                    </span>
                  )}
                </div>
              </Field>
            </div>

            {fields.ssh_tunnel && tunnelOn && (
              <Field
                label={t("SSH 服务器")}
                hint={
                  sshServers.length === 0
                    ? t("还没有可用的 SSH 服务器：请先在「服务器」里添加，或切回直连")
                    : t("复用已保存的 SSH 凭据与主机指纹")
                }
              >
                <Select
                  value={draft.ssh_server_id ?? ""}
                  ariaLabel={t("SSH 服务器")}
                  disabled={sshServers.length === 0}
                  placeholder={t("选择 SSH 服务器")}
                  onChange={(value) => patch({ ssh_server_id: value || null })}
                  options={sshServers.map((server) => ({
                    value: server.id,
                    label: server.name,
                    hint: `${server.username}@${server.host}:${server.port}`,
                  }))}
                />
              </Field>
            )}
          </>
        )}

        {/* 鉴权分区：只切界面，不清空另一分区的内容（用户可能两边都要填）。 */}
        {authTabs.length > 0 && (
          <div className="db-connection-auth">
            <div className="db-connection-section-heading page-form-heading">
              <span>{t("身份认证")}</span>
              {authTabs.length > 1 && <SegmentedControl value={activeAuthTab} onChange={setAuthTab}
                label={t("身份认证")}
                items={authTabs.map(id => ({id, label: id === "credentials" ? t("用户名与密码") : t("SSL / CA 凭证")}))} />}
            </div>

            {activeAuthTab === "credentials" && (
              <div className="flex flex-col gap-3 py-2">
                <div className="db-connection-columns grid grid-cols-2 gap-3">
                  <Field
                    label={draft.engine === "redis" ? t("用户名（ACL，可选）") : t("用户名")}
                    required={Boolean(descriptor?.requirements.username)}
                    hint={
                      draft.engine === "redis"
                        ? t("Redis 6+ ACL 才有用户名；留空 = 只用密码")
                        : undefined
                    }
                  >
                    <Input
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
                    <div className="relative flex items-center">
                      <Input
                        type={showPassword ? "text" : "password"}
                        className="pr-8"
                        value={password}
                        disabled={clearPassword}
                        onChange={(event) => setPassword(event.target.value)}
                        placeholder={profile?.has_password ? "••••••••" : ""}
                      />
                      <button
                        type="button"
                        aria-label={showPassword ? t("隐藏密码") : t("显示密码")}
                        aria-pressed={showPassword}
                        className="absolute right-0.5 rounded-[5px] p-1 text-fg-subtle hover:bg-surface-hover hover:text-fg"
                        onClick={() => setShowPassword((shown) => !shown)}
                      >
                        {showPassword ? <EyeOff size={12} /> : <Eye size={12} />}
                      </button>
                    </div>
                  </Field>
                </div>

                {profile?.has_password && !clearPassword && (
                  <p className="flex items-center gap-1 text-10 leading-relaxed text-fg-subtle">
                    <Lock size={10} />
                    {t("密码存在系统钥匙串里，不会回传到界面；留空即继续使用它")}
                  </p>
                )}

                {profile?.has_password && (
                  <label className="flex items-center gap-1.5 text-11 text-fg-muted">
                    <input
                      type="checkbox"
                      className="accent-accent"
                      checked={clearPassword}
                      onChange={(event) => {
                        setClearPassword(event.target.checked);
                        if (event.target.checked) setPassword("");
                      }}
                    />
                    {t("清除已保存的密码（连接将使用空密码）")}
                  </label>
                )}
              </div>
            )}

            {activeAuthTab === "tls" && (
              <div className="flex flex-col gap-3 py-2">
                <div className="db-connection-columns grid grid-cols-2 gap-3">
                  <Field label={t("TLS 模式")} hint={t("选择 required 后绝不自动降级为明文")}>
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
                  <Field
                    label={t("TLS 验证名称（可选）")}
                    hint={t("SSH 隧道时用于校验证书的主机名；留空使用数据库主机名")}
                  >
                    <Input
                      value={draft.tls_server_name ?? ""}
                      onChange={(event) =>
                        patch({ tls_server_name: event.target.value || null })
                      }
                    />
                  </Field>
                </div>
                <Field label={t("CA 证书路径（可选）")} hint={t("留空使用内置公共根证书")}>
                  <div className="flex items-center gap-2">
                    <Input
                      value={draft.tls_ca_path ?? ""}
                      onChange={(event) => patch({ tls_ca_path: event.target.value || null })}
                    />
                    <Button variant="ghost" size="sm" onClick={() => void browseCa()}>
                      <FolderOpen size={12} />
                      {t("浏览…")}
                    </Button>
                  </div>
                </Field>
                {draft.tls_mode === "disabled" && (
                  <p className="text-10 leading-relaxed text-fg-subtle">
                    {t("当前为明文连接：证书路径与验证名称只在启用 TLS 后生效。")}
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {fields?.database && (
          <Field
            label={t(meta.databaseLabel)}
            required={descriptor?.requirements.database}
          >
            <Input
              value={draft.default_database ?? ""}
              onChange={(event) =>
                patch({ default_database: event.target.value.trim() || null })
              }
              placeholder={t(meta.databasePlaceholder)}
            />
          </Field>
        )}

        {draft.engine === "redis" && (
          <div className="rounded-[8px] border border-line bg-surface-2/60 p-2">
            <div className="mb-1.5 text-11 font-medium text-fg-muted">{t("Redis 连接模式")}</div>
            <div className="db-connection-columns grid grid-cols-2 gap-3">
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
                  <Input
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
                  <Input
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
                  <Input
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

        {/* 高级选项：默认收起，摘要直接显示当前值，不用展开也知道配了什么。 */}
        <div className="db-connection-advanced">
          <button
            type="button"
            aria-expanded={advanced}
            onClick={() => setAdvanced((value) => !value)}
            className="page-form-heading w-full py-2 text-left"
          >
            <ChevronRight
              size={11}
              className={cn(
                "shrink-0 text-fg-subtle transition-transform",
                advanced && "rotate-90",
              )}
            />
            <span className="shrink-0 text-11 font-medium text-fg-muted">
              {t("高级选项")}
            </span>

            <span className="ml-auto shrink-0 text-10 tabular-nums text-fg-subtle">
              {advancedSummary}
            </span>
          </button>

          {advanced && (
            <div className="flex flex-col gap-3 pb-2 pt-3">
              <div className="db-connection-columns grid grid-cols-2 gap-3">
                <Field label={t("连接超时（毫秒）")}>
                  <Input
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
                  <Input
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
              {optionalOptions.map(renderOption)}
            </div>
          )}
        </div>

        <label className="flex items-start gap-2 rounded-[10px] border border-line bg-surface-2/40 px-2.5 py-2">
          <input
            type="checkbox"
            className="mt-0.5 accent-accent"
            checked={draft.read_only}
            onChange={(event) => patch({ read_only: event.target.checked })}
          />
          <span className="text-11 leading-relaxed text-fg-muted">
            {descriptor?.family === "redis"
              ? t(
                  "只读连接：键的写入、删除、TTL 修改与 PUBLISH 都会被拒绝，只能浏览。要修改数据请显式关闭。",
                )
              : (capabilityReason(descriptor, "read_only_enforcement") ??
                t(
                  "只读连接：连接后执行 SET SESSION TRANSACTION READ ONLY，写语句会被服务器拒绝。要修改数据请显式关闭。",
                ))}
          </span>
        </label>

        {error && <ErrorText>{error}</ErrorText>}

        {saveFailure &&
          (() => {
            const info = toAppError(saveFailure);
            return (
              <ErrorText detail={info.detail ?? info.hint ?? undefined}>
                {info.stage && (
                  <span className="mr-1 font-medium">{stageLabel(info.stage)}</span>
                )}
                {info.message}
              </ErrorText>
            );
          })()}

        {test && (
          <div
            ref={testResultRef}
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
                {test.server_version && (
                  <span>
                    {meta.label} {test.server_version}
                  </span>
                )}
                {test.connection && <span>{test.connection.label}</span>}
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
      <div className="db-connection-page flex h-full min-h-0 flex-col bg-surface-1">
        <div className="flex shrink-0 flex-col gap-0.5 border-b border-line px-4 py-2.5">
          <span className="text-13 font-medium text-fg">{title}</span>
        </div>
        <div className="db-connection-scroll ops-scroll min-h-0 flex-1 overflow-y-auto p-4">
          {/* 标签页可能很宽：表单保持可读宽度，不把两列拉到 1400px。 */}
          <div className="mx-auto w-full max-w-[720px]">{body}</div>
        </div>
        <div className="db-connection-footer flex shrink-0 items-center justify-end gap-2 border-t border-line px-4 py-3">
          {footer}
        </div>
      </div>
    );
  }

  return (
    <Modal
      open={open}
      title={title}
      width={720}
      className="db-connection-modal"
      closeOnBackdrop={false}
      onClose={busy ? undefined : onClose}
      footer={footer}
    >
      {body}
    </Modal>
  );
}
