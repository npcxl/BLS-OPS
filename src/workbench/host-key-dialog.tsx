import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ShieldAlert, ShieldCheck } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Modal } from "@/components/ui/modal";
import { useDomainStore } from "@/stores/domain-store";
import { useSessionStore } from "@/stores/session-store";

/**
 * Host key confirmation, wired to `ssh_connect`.
 *
 * The connection is refused until the user accepts the fingerprint, and a
 * changed fingerprint is shown side by side with the previously trusted one.
 *
 * With ProxyJump the key usually belongs to a jump host, not to the server in
 * the tab — that is called out explicitly so the user knows what they trust.
 */
export function HostKeyDialog() {
  const challenge = useSessionStore((s) => s.challenge);
  const resolve = useSessionStore((s) => s.resolveChallenge);
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);

  if (!challenge) return null;
  const changed = challenge.kind === "changed";
  const endpoint = `${challenge.challengeHost}:${challenge.challengePort}`;

  const decide = async (trust: boolean) => {
    setBusy(true);
    try {
      await resolve(trust);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      width={520}
      title={changed ? t("Host key has changed") : t("First connection — confirm the host key")}
      description={
        changed
          ? t(
              "{{host}} returned a host key that does not match the saved one. If you did not expect this change, it could be a man-in-the-middle attack — refuse and verify with the server administrator.",
              { host: endpoint },
            )
          : t("The host key of {{host}} is not trusted yet. Verify the fingerprint before continuing.", {
              host: endpoint,
            })
      }
      footer={
        <>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void decide(false)}>
            {t("Refuse")}
          </Button>
          <Button variant="primary" size="sm" disabled={busy} onClick={() => void decide(true)}>
            {changed ? t("Trust new key and reconnect") : t("Trust and connect")}
          </Button>
        </>
      }
      onClose={() => void decide(false)}
    >
      <div className="flex flex-col gap-3">
        <div className="flex items-start gap-2 rounded-[6px] border border-line bg-surface-1 px-3 py-2">
          {changed ? (
            <ShieldAlert size={16} className="mt-0.5 shrink-0 text-danger" />
          ) : (
            <ShieldCheck size={16} className="mt-0.5 shrink-0 text-warning" />
          )}
          <div className="min-w-0 flex-1">
            <div className="text-11 text-fg-subtle">
              {endpoint} · {challenge.fingerprintType}
            </div>
            <code className="mt-1 block break-all font-mono text-12 text-fg">{challenge.fingerprint}</code>
          </div>
        </div>

        {challenge.isJumpHop && (
          <div className="rounded-[6px] border border-line bg-surface-1 px-3 py-2">
            <p className="text-11 leading-relaxed text-fg-muted">
              {t(
                "This is the fingerprint of the jump host, not of the target server {{host}}. The jump host is recorded first; the target server's fingerprint is asked next.",
                { host: `${challenge.targetHost}:${challenge.targetPort}` },
              )}
            </p>
          </div>
        )}

        {changed && challenge.knownFingerprint && (
          <div className="rounded-[6px] border border-line bg-surface-1 px-3 py-2">
            <div className="text-11 text-fg-subtle">{t("Previously trusted fingerprint")}</div>
            <code className="mt-1 block break-all font-mono text-12 text-fg-muted">
              {challenge.knownFingerprint}
            </code>
          </div>
        )}

        <p className="text-11 leading-relaxed text-fg-subtle">
          {t(
            "After accepting, the fingerprint is stored in Known Hosts. View or remove it in Settings → Known Hosts.",
          )}
        </p>
      </div>
    </Modal>
  );
}

/** Lists every trusted host key with the option to revoke trust. */
export function KnownHostsPanel() {
  const knownHosts = useDomainStore((s) => s.knownHosts);
  const remove = useDomainStore((s) => s.deleteKnownHost);
  const { t } = useTranslation();
  /**
   * 撤销信任是删除操作：删掉之后下次连接会重新弹指纹确认。
   * 万一原来的指纹变化是有人在中间人，这一下就把"变更警告"抹掉了 ——
   * 所以必须确认，而且要说清楚删完之后会发生什么。
   */
  const [target, setTarget] = useState<{ id: string; host: string; port: number } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<unknown>(null);

  const confirmRemove = async () => {
    if (!target) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await remove(target.id);
      setTarget(null);
    } catch (cause) {
      // 失败留在弹窗里：用户不用猜"到底删没删"。
      setDeleteError(cause);
    } finally {
      setDeleting(false);
    }
  };

  if (knownHosts.length === 0) {
    return (
      <p className="px-2.5 py-2 text-11 text-fg-subtle">
        {t("No trusted host keys yet. You will be asked on first connection.")}
      </p>
    );
  }

  return (
    <div className="flex flex-col">
      {knownHosts.map((host) => (
        <div key={host.id} className="group px-2.5 py-1.5 hover:bg-surface-hover">
          <div className="flex items-center gap-1.5">
            <ShieldCheck size={12} className="shrink-0 text-success" />
            <span className="min-w-0 flex-1 truncate text-12 text-fg">
              {host.host}:{host.port}
            </span>
            <button
              type="button"
              aria-label={t("Delete fingerprint for {{name}}", { name: host.host })}
              className="rounded p-1 text-fg-subtle opacity-0 hover:text-danger group-hover:opacity-100"
              onClick={() => {
                setDeleteError(null);
                setTarget({ id: host.id, host: host.host, port: host.port });
              }}
            >
              {t("Delete")}
            </button>
          </div>
          <code className="mt-0.5 block truncate pl-[19px] font-mono text-11 text-fg-subtle">
            {host.fingerprint}
          </code>
        </div>
      ))}

      <ConfirmDialog
        open={target !== null}
        risk="danger"
        title={t("Forget this host key?")}
        description={t(
          "{{host}}:{{port}} will be asked to prove its identity again on the next connection.",
          { host: target?.host ?? "", port: target?.port ?? 0 },
        )}
        consequences={[
          t("The fingerprint is removed from this machine only; the server is not changed."),
          t("You will have to accept the fingerprint again before connecting."),
        ]}
        confirmLabel={t("Delete")}
        pending={deleting}
        error={deleteError}
        onConfirm={() => void confirmRemove()}
        onCancel={() => setTarget(null)}
      />
    </div>
  );
}
