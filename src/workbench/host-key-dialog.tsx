import { useState } from "react";
import { ShieldAlert, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { useDomainStore } from "@/stores/domain-store";
import { useSessionStore } from "@/stores/session-store";

/**
 * Host key confirmation, wired to `ssh_connect`.
 *
 * The connection is refused until the user accepts the fingerprint, and a
 * changed fingerprint is shown side by side with the previously trusted one.
 */
export function HostKeyDialog() {
  const challenge = useSessionStore((s) => s.challenge);
  const resolve = useSessionStore((s) => s.resolveChallenge);
  const [busy, setBusy] = useState(false);

  if (!challenge) return null;
  const changed = challenge.kind === "changed";

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
      title={changed ? "主机指纹已变化" : "首次连接，请确认主机指纹"}
      description={
        changed
          ? `${challenge.hop} 返回的主机密钥与已保存的不一致。如果这不是你预期中的变更，可能是中间人攻击——请拒绝并向服务器管理员核实。`
          : `${challenge.hop} 的主机密钥尚未被信任。请核对指纹后再继续。`
      }
      footer={
        <>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void decide(false)}>
            拒绝
          </Button>
          <Button variant="primary" size="sm" disabled={busy} onClick={() => void decide(true)}>
            {changed ? "信任新指纹并重连" : "信任并连接"}
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
              {challenge.host}:{challenge.port} · {challenge.fingerprintType}
            </div>
            <code className="mt-1 block break-all font-mono text-12 text-fg">{challenge.fingerprint}</code>
          </div>
        </div>

        {changed && challenge.knownFingerprint && (
          <div className="rounded-[6px] border border-line bg-surface-1 px-3 py-2">
            <div className="text-11 text-fg-subtle">此前已信任的指纹</div>
            <code className="mt-1 block break-all font-mono text-12 text-fg-muted">
              {challenge.knownFingerprint}
            </code>
          </div>
        )}

        <p className="text-11 leading-relaxed text-fg-subtle">
          接受后指纹会写入 Known Hosts，可在“设置 → 已知主机”中查看或删除。
        </p>
      </div>
    </Modal>
  );
}

/** Lists every trusted host key with the option to revoke trust. */
export function KnownHostsPanel() {
  const knownHosts = useDomainStore((s) => s.knownHosts);
  const remove = useDomainStore((s) => s.deleteKnownHost);

  if (knownHosts.length === 0) {
    return <p className="px-2.5 py-2 text-11 text-fg-subtle">还没有信任任何主机密钥，首次连接时会自动询问。</p>;
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
              aria-label={`删除 ${host.host} 的指纹`}
              className="rounded p-1 text-fg-subtle opacity-0 hover:text-danger group-hover:opacity-100"
              onClick={() => void remove(host.id)}
            >
              删除
            </button>
          </div>
          <code className="mt-0.5 block truncate pl-[19px] font-mono text-11 text-fg-subtle">
            {host.fingerprint}
          </code>
        </div>
      ))}
    </div>
  );
}
