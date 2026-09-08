import { Icon, type IconifyIcon } from "@iconify/react";

/**
 * VSCode brand logo, inlined from the locally installed
 * @iconify-json/vscode-icons package (`file-type-vscode`) — the same
 * offline-rendering policy as `src/lib/icons/vscode-file-icons.ts`:
 * @iconify/react renders this object directly and never calls the Iconify
 * API. Multi-colour by design: the fills are the brand blues, so text
 * colour classes (accent/danger) have no effect on it.
 */
const VSCODE_LOGO: IconifyIcon = {
  body: '<path fill="#0065a9" d="m29.01 5.03l-5.766-2.776a1.74 1.74 0 0 0-1.989.338L2.38 19.8a1.166 1.166 0 0 0-.08 1.647q.037.04.077.077l1.541 1.4a1.165 1.165 0 0 0 1.489.066L28.142 5.75A1.158 1.158 0 0 1 30 6.672v-.067a1.75 1.75 0 0 0-.99-1.575"/><path fill="#007acc" d="m29.01 26.97l-5.766 2.777a1.745 1.745 0 0 1-1.989-.338L2.38 12.2a1.166 1.166 0 0 1-.08-1.647q.037-.04.077-.077l1.541-1.4A1.165 1.165 0 0 1 5.41 9.01l22.732 17.24A1.158 1.158 0 0 0 30 25.328v.072a1.75 1.75 0 0 1-.99 1.57"/><path fill="#1f9cf0" d="M23.244 29.747a1.745 1.745 0 0 1-1.989-.338A1.025 1.025 0 0 0 23 28.684V3.316a1.024 1.024 0 0 0-1.749-.724a1.74 1.74 0 0 1 1.989-.339l5.765 2.772A1.75 1.75 0 0 1 30 6.6v18.8a1.75 1.75 0 0 1-.991 1.576Z"/>',
  width: 32,
  height: 32,
};

/** Brand icon rendered at menu/list sizes; `strokeWidth` is accepted and ignored. */
export function VscodeLogoIcon({
  size = 14,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return <Icon icon={VSCODE_LOGO} width={size} height={size} className={className} />;
}
