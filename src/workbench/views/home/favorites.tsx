/**
 * 收藏：仓库里只有服务器有 `favorite` 字段（数据库连接与项目都没有），
 * 所以这里只列服务器收藏；没有收藏时给出在哪收藏的提示，不虚构其它类型。
 */
import { useTranslation } from "react-i18next";
import { Star } from "@/components/icons";
import type { ServerRecord } from "@/api/ops-api";
import { SectionHeading, SectionLink } from "./section";

export function FavoritesSection({
  favorites,
  onOpen,
  onManage,
}: {
  favorites: ServerRecord[];
  onOpen: (server: ServerRecord) => void;
  onManage: () => void;
}) {
  const { t } = useTranslation();

  return (
    <section className="flex flex-col gap-2.5">
      <SectionHeading
        title={t("Favorites")}
        count={favorites.length}
        actions={<SectionLink label={t("Manage →")} onClick={onManage} />}
      />
      {favorites.length === 0 ? (
        <p className="text-12 text-fg-subtle">{t("Click the star in the server list to favorite a server.")}</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {favorites.map((server) => (
            <button
              key={server.id}
              type="button"
              className="flex h-[32px] items-center gap-1.5 rounded-[9px] border border-line bg-surface-1/70 px-3 text-12 text-fg shadow-[0_1px_2px_rgb(15_23_42/0.05)] transition-colors hover:border-line-strong hover:bg-surface-hover hover:shadow-[0_2px_6px_rgb(15_23_42/0.08)]"
              onClick={() => onOpen(server)}
            >
              <Star size={12} className="fill-current text-accent" />
              {server.name}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
