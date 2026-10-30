/**
 * 键网格的多选状态（单击 / Ctrl 点选 / Shift 连选 / 全选）。
 *
 * 只存 key 字符串集合 + 锚点下标；列表本身由 useRedisKeyScan 提供，
 * 选择动作需要调用方把当前列表传进来（Shift 连选要按下标取范围）。
 */
import { useCallback, useRef, useState } from "react";
import type { RedisKeyBrief } from "@/api/types/database";

export interface KeyClickModifiers {
  ctrl: boolean;
  shift: boolean;
}

export interface RedisKeySelection {
  selected: Set<string>;
  /** 最后一次单击的键（详情面板 / F2 编辑的目标）。 */
  activeKey: string | null;
  click: (
    key: string,
    index: number,
    mods: KeyClickModifiers,
    keys: RedisKeyBrief[],
  ) => void;
  selectAll: (keys: RedisKeyBrief[]) => void;
  clear: () => void;
  remove: (keys: string[]) => void;
  setActive: (key: string | null) => void;
}

export function useRedisKeySelection(): RedisKeySelection {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const anchorRef = useRef<number | null>(null);

  const click = useCallback(
    (key: string, index: number, mods: KeyClickModifiers, keys: RedisKeyBrief[]) => {
      setActiveKey(key);
      if (mods.shift && anchorRef.current !== null) {
        const from = Math.min(anchorRef.current, index);
        const to = Math.max(anchorRef.current, index);
        const range = keys.slice(from, to + 1).map((entry) => entry.key);
        setSelected(new Set(mods.ctrl ? [...selectedRef.current, ...range] : range));
        return;
      }
      anchorRef.current = index;
      if (mods.ctrl) {
        setSelected((current) => {
          const next = new Set(current);
          if (next.has(key)) next.delete(key);
          else next.add(key);
          return next;
        });
        return;
      }
      setSelected(new Set([key]));
    },
    [],
  );

  // Shift 连选时"已有选择"要取最新值，不能闭包捕获渲染时的快照。
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  const selectAll = useCallback((keys: RedisKeyBrief[]) => {
    setSelected(new Set(keys.map((entry) => entry.key)));
  }, []);

  const clear = useCallback(() => {
    setSelected(new Set());
    setActiveKey(null);
    anchorRef.current = null;
  }, []);

  const remove = useCallback((keys: string[]) => {
    setSelected((current) => {
      const next = new Set(current);
      for (const key of keys) next.delete(key);
      return next;
    });
  }, []);

  return {
    selected,
    activeKey,
    click,
    selectAll,
    clear,
    remove,
    setActive: setActiveKey,
  };
}
