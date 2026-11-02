/**
 * 引擎目录加载：后端注册表是唯一事实来源，这里负责拉一次、全局共享。
 *
 * 失败时**不做静默回落**：连接表单会停在"目录加载失败"，而不是拿一份
 * 猜测的默认端口去连一个用户根本没选的数据库。
 */
import { useCallback, useEffect, useState } from "react";
import { databaseApi } from "@/api/ops-api";
import type { EngineDescriptor } from "@/api/types/database";
import { isCatalogLoaded, setEngineCatalog } from "./db-engines";

let inflight: Promise<EngineDescriptor[]> | null = null;

function loadCatalog(): Promise<EngineDescriptor[]> {
  if (!inflight) {
    inflight = databaseApi
      .enginesCatalog()
      .then((entries) => {
        setEngineCatalog(entries);
        return entries;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return "无法读取引擎目录";
}

export interface EngineCatalogState {
  ready: boolean;
  error: string | null;
  reload: () => void;
}

export function useEngineCatalog(): EngineCatalogState {
  const [ready, setReady] = useState(isCatalogLoaded());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isCatalogLoaded()) {
      setReady(true);
      return;
    }
    let cancelled = false;
    loadCatalog()
      .then(() => {
        if (!cancelled) {
          setReady(true);
          setError(null);
        }
      })
      .catch((failure: unknown) => {
        if (!cancelled) setError(messageOf(failure));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const reload = useCallback(() => {
    setError(null);
    setReady(false);
    loadCatalog()
      .then(() => setReady(true))
      .catch((failure: unknown) => setError(messageOf(failure)));
  }, []);

  return { ready, error, reload };
}
