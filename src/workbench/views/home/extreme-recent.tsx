/**
 * 首页「最近的超能对话」。
 *
 * 数据只来自 `extreme-store` 里的本地对话记录（localStorage），页面挂载时
 * 不额外请求。点一行就由 `enter-extreme` 建连并直接打开那条对话 —— 用户不
 * 需要先进终端、再点顶栏。
 */
import { useTranslation } from "react-i18next";
import { ChevronRight, Clock, Sparkles } from "@/components/icons";
import { relativeTime, timestampTitle } from "./utils";

export interface ExtremeRecentItem {
  id: string;
  title: string;
  server: string;
  /** `账号@地址:端口`：同名服务器靠它区分。 */
  detail: string;
  at: number;
  /** 这台服务器现在是否已经有活着的 SSH 会话。 */
  live: boolean;
}

export function ExtremeRecentSection({
  items,
  onOpen,
}: {
  items: ExtremeRecentItem[];
  onOpen: (item: ExtremeRecentItem) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="home-recents">
      <section className="home-recent-group">
        <div className="home-recent-heading">
          <span className="home-recent-icon">
            <Sparkles size={17} />
          </span>
          <h2>{t("最近的对话")}</h2>
          {items.length > 0 && <span className="home-recent-count">{items.length}</span>}
        </div>
        <div className="home-recent-list">
          {items.length === 0 ? (
            <div className="home-recent-empty">
              <Clock size={23} strokeWidth={1.4} />
              <p>{t("还没有超能对话。进入超能模式问第一个问题，这里会出现记录。")}</p>
            </div>
          ) : (
            items.map((item) => (
              <button
                key={item.id}
                type="button"
                className="home-recent-row"
                onClick={() => onOpen(item)}
                title={`${item.title}\n${item.detail}`}
              >
                <span className="home-recent-row-copy">
                  <span className="home-recent-name">
                    {item.title || t("未命名对话")}
                    {item.live && (
                      <span
                        className="home-recent-connected"
                        role="img"
                        aria-label={t("Connected")}
                        title={t("Connected")}
                      />
                    )}
                  </span>
                  <span className="home-recent-detail">
                    {[item.server, item.detail].filter(Boolean).join(" · ")}
                  </span>
                </span>
                <span className="home-recent-time" title={timestampTitle(item.at)}>
                  {relativeTime(item.at, t)}
                </span>
                <ChevronRight size={13} className="home-recent-chevron" />
              </button>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
