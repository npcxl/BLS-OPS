/**
 * 工作区标签关闭时的资源清理判断。
 *
 * 工作区 tab id（uuid）和数据库工作项 id（query:... / table:...）不是同一套
 * 命名空间，不能直接比较。只按工作项所属连接是否仍存在数据库标签来判断。
 */

export interface CleanupWorkItem {
  id: string;
  profileId: string;
}

export function staleWorkbenchTabIds(
  tabIds: string[],
  items: CleanupWorkItem[],
  activeProfiles: Set<string>,
): string[] {
  const itemById = new Map(items.map((item) => [item.id, item]));
  return tabIds.filter((tabId) => {
    const item = itemById.get(tabId);
    // 工作项已不存在，或所属连接已没有任何工作区标签 → 释放运行时资源。
    return !item || !activeProfiles.has(item.profileId);
  });
}
