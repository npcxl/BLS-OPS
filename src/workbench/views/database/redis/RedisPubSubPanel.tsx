/**
 * 发布 / 订阅面板：订阅一条频道，消息按到达顺序追加。
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


