/**
 * 新建 string 键的表单（SET NX，绝不覆盖已有键）。
 */
/**
 * Redis 键浏览器 —— 引擎为 redis 的连接标签的完整工作区。
 *
 * 与 SQL 工作台的关系：完全平行。这里不用 WorkItem/查询任务体系，
 * 操作都是短命令（SCAN/GET/SET/DEL/…），状态保留在组件内。
 *
 * 布局：
 * - 顶部：连接状态 + db index 切换 + SCAN 模式搜索 + dbsize；
 * - 左：键列表（类型徽标 + TTL）；
 * - 右：键详情（元信息 + 按类型渲染的值 + 编辑入口）+ 发布订阅面板。
 * 只读连接（profile.read_only）隐藏一切写入口。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Loader2,
  Pencil,
  PlugZap,
  Plus,
  RefreshCw,
  Trash2,
  TriangleAlert,
  X,
} from "@/components/icons";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { FormDialog } from "@/components/ui/form-dialog";
import { Field, fieldClass } from "@/components/ui/modal";
import { Select } from "@/components/ui/select";
import { pushErrorToast } from "@/components/ui/toast";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { databaseApi } from "@/api/ops-api";
import type {
  DatabaseProfile,
  RedisFieldEntry,
  RedisKeyBrief,
  RedisKeyInfo,
  RedisPubSubEvent,
  RedisValuePayload,
  RedisZEntry,
} from "@/api/types/database";
import { toDbError, useDatabaseStore } from "@/stores/database-store";

/** 前端累计键数上限：持续翻页不设限会一直涨内存（10 万行 ≈ 30 MB）。 */
import { alertRedisFailure } from "./redis-shared";

export function NewKeyDialog({
  open,
  profileId,
  dbIndex,
  onClose,
  onCreated,
}: {
  open: boolean;
  profileId: string;
  dbIndex: number;
  onClose: () => void;
  onCreated: (key: string) => void;
}) {
  const { t } = useTranslation();
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [keyError, setKeyError] = useState<string | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);

  // 每次重新打开都是干净的表单：上一轮的键名/报错不该跟着进来。
  useEffect(() => {
    if (!open) return;
    setKey("");
    setValue("");
    setKeyError(null);
    setFailure(null);
    setSaving(false);
  }, [open]);

  const submit = async () => {
    const trimmed = key.trim();
    if (!trimmed) {
      setKeyError(t("键名不能为空"));
      return;
    }
    // Redis 键允许空格，但前后空白几乎总是误粘贴 —— 明确提示，不静默裁剪。
    if (trimmed !== key) {
      setKeyError(t("键名首尾不能有空白字符"));
      return;
    }
    setKeyError(null);
    setFailure(null);
    setSaving(true);
    try {
      await databaseApi.redisCreateString(profileId, dbIndex, trimmed, value);
      onCreated(trimmed);
    } catch (cause) {
      setFailure(cause);
    } finally {
      setSaving(false);
    }
  };

  const errorInfo = failure ? toDbError(failure) : null;

  return (
    <FormDialog
      open={open}
      title={t("新建 string 键")}
      description={t("键不存在时才会创建（SET NX），不会覆盖已有键。")}
      size="md"
      submitLabel={t("创建")}
      submitting={saving}
      error={errorInfo ?? undefined}
      onSubmit={() => void submit()}
      onCancel={onClose}
      dirty={key.length > 0 || value.length > 0}
      footerExtra={`db ${dbIndex}`}
    >
      <Field label={t("键名")} required error={keyError}>
        <input
          className={fieldClass}
          value={key}
          spellCheck={false}
          autoComplete="off"
          data-autofocus
          onChange={(event) => setKey(event.target.value)}
          placeholder="user:1001"
        />
      </Field>
      <Field label={t("初始值")} hint={t("可留空：先建一个空字符串键。")}>
        <textarea
          className={cn(fieldClass, "h-24 resize-y py-1.5 font-mono")}
          value={value}
          spellCheck={false}
          onChange={(event) => setValue(event.target.value)}
        />
      </Field>
    </FormDialog>
  );
}

// ---------------------------------------------------------------------------
// 值面板
// ---------------------------------------------------------------------------

