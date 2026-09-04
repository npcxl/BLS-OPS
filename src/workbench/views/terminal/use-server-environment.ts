import { useCallback, useEffect, useRef, useState } from "react";

import { opsApi, toErrorMessage, type NginxEnvironment } from "@/api/ops-api";
import { clearNginxSelections } from "./completion/providers/environment";

/**
 * 服务器运行环境探测的缓存与调度。
 *
 * 三条性能纪律（对应"不要把终端敲字变成 docker ps 风暴"）：
 * - 连接成功后**异步探测一次**；
 * - 结果短时间缓存（默认 60s），切 Tab 回来直接用缓存；
 * - 打开建议时先用缓存、**后台刷新**；失败只记录原因，绝不无限重试。
 */

const CACHE_TTL_MS = 60_000;

interface Cached {
  at: number;
  env: NginxEnvironment;
}

const cache = new Map<string, Cached>();
const inFlight = new Map<string, Promise<NginxEnvironment>>();
/** 探测失败的会话：记住原因，等下次显式刷新（不自动重试）。 */
const failures = new Map<string, string>();

/** 让缓存失效（切换服务器 / 断开连接时调用）。 */
export function invalidateEnvironmentCache(sessionId?: string): void {
  if (sessionId === undefined) {
    cache.clear();
    failures.clear();
    clearNginxSelections();
    return;
  }
  cache.delete(sessionId);
  failures.delete(sessionId);
  clearNginxSelections();
}

export type EnvironmentProber = (sessionId: string) => Promise<NginxEnvironment>;

let prober: EnvironmentProber = (sessionId) => opsApi.probeNginxEnvironment(sessionId);

/** 替换探测实现（测试用）。 */
export function setEnvironmentProber(next: EnvironmentProber | null): void {
  prober = next ?? ((sessionId: string) => opsApi.probeNginxEnvironment(sessionId));
}

function probe(sessionId: string): Promise<NginxEnvironment> {
  const pending = inFlight.get(sessionId);
  if (pending) return pending;
  const task = prober(sessionId)
    .then((env) => {
      cache.set(sessionId, { at: Date.now(), env });
      failures.delete(sessionId);
      return env;
    })
    .catch((cause) => {
      failures.set(sessionId, toErrorMessage(cause));
      throw cause;
    })
    .finally(() => inFlight.delete(sessionId));
  inFlight.set(sessionId, task);
  return task;
}

export interface ServerEnvironmentState {
  environment: NginxEnvironment | null;
  loading: boolean;
  /** 探测失败的原因（Docker 无权限之类也要说清楚）。 */
  error: string | null;
  /** 手动刷新（会强制重新探测）。 */
  refresh: () => void;
}

/**
 * 取当前会话的运行环境。
 *
 * `enabled` 为 false 时不探测（未连接 / 在 vim 里）。`sessionId` 变化时整份
 * 状态重来 —— 不同 SSH 会话的环境互不共享。
 */
export function useServerEnvironment(
  sessionId: string,
  enabled: boolean,
): ServerEnvironmentState {
  const [nonce, setNonce] = useState(0);
  const [environment, setEnvironment] = useState<NginxEnvironment | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sessionRef = useRef(sessionId);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    // 换会话：清掉上一份结果（绝不把 A 机器的环境显示在 B 机器上）。
    if (sessionRef.current !== sessionId) {
      sessionRef.current = sessionId;
      setEnvironment(null);
      setError(null);
    }

    const cached = cache.get(sessionId);
    if (cached) {
      setEnvironment(cached.env);
      setError(null);
      const stale = Date.now() - cached.at > CACHE_TTL_MS;
      if (!stale) {
        setLoading(false);
        return;
      }
      // 过期：先用缓存顶着，后台刷新（用户不用等）。
    } else {
      const failed = failures.get(sessionId);
      if (failed) {
        setError(failed);
        setLoading(false);
        return;
      }
    }

    let alive = true;
    setLoading(true);
    probe(sessionId)
      .then((env) => {
        if (!alive) return;
        setEnvironment(env);
        setError(null);
      })
      .catch((cause) => {
        if (!alive) return;
        setError(toErrorMessage(cause));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [sessionId, enabled, nonce]);

  const refresh = useCallback(() => {
    cache.delete(sessionId);
    failures.delete(sessionId);
    setError(null);
    setNonce((value) => value + 1);
  }, [sessionId]);

  return { environment, loading, error, refresh };
}
