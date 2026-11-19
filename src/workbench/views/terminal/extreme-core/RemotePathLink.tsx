import { useEffect, useRef, useState, type ReactNode } from "react";
import { opsApi } from "@/api/ops-api";
import type { WorkspaceTarget } from "./RemoteWorkspacePanel";

export type OpenTarget = (target: WorkspaceTarget) => void | Promise<boolean>;

export function RemotePathLink({ path, children, sessionId, serverId, onOpen }: {
  path: string;
  children: ReactNode;
  sessionId: string;
  serverId?: string | null;
  onOpen?: OpenTarget;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [verified, setVerified] = useState<string | null>(null);
  const key = JSON.stringify([sessionId, path]);
  useEffect(() => {
    if (!path || !sessionId || !onOpen || !ref.current) return undefined;
    let cancelled = false;
    const check = () => {
      void opsApi.sftpStat(sessionId, path).then((entry) => {
        if (!cancelled && (entry.kind === "directory" || entry.kind === "file")) setVerified(key);
      }).catch(() => undefined);
    };
    if (typeof IntersectionObserver === "undefined") {
      check();
      return () => { cancelled = true; };
    }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      check();
    }, { rootMargin: "160px 0px" });
    observer.observe(ref.current);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [key, onOpen, path, sessionId]);

  return (
    <span ref={ref}>
      {path && sessionId && onOpen && verified === key ? (
        <a href={path} onClick={(event) => {
          event.preventDefault();
          void Promise.resolve(onOpen({ kind: "directory", path, sessionId, ...(serverId ? { serverId } : {}) })).then((opened) => {
            if (opened === false) setVerified((value) => value === key ? null : value);
          });
        }}>{children}</a>
      ) : children}
    </span>
  );
}
