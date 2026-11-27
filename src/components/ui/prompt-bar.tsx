/*
 * 官方 React Bits Prompt Bar（PromptBar-TS-TW）。
 * https://reactbits.dev/micro/prompt-bar
 *
 * MIT + Commons Clause License Condition v1.0
 *
 * Copyright (c) 2026 David Haz
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software **as part of an application, website, or product**, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * ## Commons Clause Restriction
 *
 * You may use this Software, including for any commercial purpose, **so long as you do not sell, sublicense, or redistribute the components themselves-whether alone, in a bundle, or as a ported version.**
 *
 * The same restriction covers the React Bits tools (Background Studio, Texture Lab, Shape Magic, Center Stage, Sound Lab and any tools added later) and the sounds in the sound library. **You may not sell, sublicense, or redistribute the tools or the sounds themselves, or offer the tools or a substantially similar copy of them as a hosted service-whether alone, in a bundle, or as a ported version.**
 *
 * What you make with the tools is yours to use. You can use exported code, images, videos, and audio files in any personal or commercial application, website, or product, including paid ones. **You may not sell or redistribute the exports on their own, either individually or as the product itself, such as a sound, texture, background, or template pack.**
 *
 * ## No Warranty
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 * # 本项目的四处适配（不改结构、不改交互）
 *
 * 1. 去掉 `'use client'`（Vite 不需要）；
 * 2. 内置文案走 i18n（`t(...)`），中文界面不再是英文；
 * 3. 支持受控 `value/onChange`：页面上的「编辑 / 引用」要把文本送回输入框；
 * 4. 支持受控 `attachments/onAttachmentsChange`：附件在右栏勾选，输入区只负责显示与移除；
 * 5. 加 `onModelChange`：换模型时外部要同步「上下文预算 / 该模型记住的强度」；
 * 6. 光子粒子不跟打字联动：原先每敲一下都加速、放大发光，看起来像输入框在抖。
 * 7. 加 `trailing` 插槽：超能模式把顶栏的「终端 / 右栏 / 任务历史」放进输入框内部右下角。
 */

import React, {
  isValidElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode
} from 'react';
import { useTranslation } from 'react-i18next';
import { useReducedMotion } from 'motion/react';
import { Tooltip } from './tooltip';
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import {
  ArrowDown01Icon,
  Attachment01Icon,
  Calendar03Icon,
  Cancel01Icon,
  ChartLineData01Icon,
  File02Icon,
  Globe02Icon,
  HelpCircleIcon,
  Mail01Icon,
  Mic01Icon,
  PlusSignIcon,
  SparklesIcon,
  Tick02Icon
} from '@hugeicons/core-free-icons';
export interface PromptBarSource {
  key: string;
  name: string;
  description?: string;
  icon?: ReactNode | IconSvgElement;
  attach?: boolean;
}

export interface PromptBarCommand {
  key: string;
  name: string;
  description?: string;
  /** 直接执行的快捷指令（如 /diff、/clear）；不传时按文本模板插入输入框。 */
  action?: () => void;
}

export interface PromptBarModel {
  key: string;
  name: string;
  tag?: string;
}

export interface PromptBarSendDetail {
  attachments: string[];
  model?: PromptBarModel;
  effort?: string;
}

export interface PromptBarProps {
  /** 受控正文；不传时组件自己管草稿。 */
  value?: string;
  onChange?: (text: string) => void;
  /** 受控附件名（右栏勾选的结果）；不传时由 `onAttach` 往内部列表里加。 */
  attachments?: string[];
  onAttachmentsChange?: (files: string[]) => void;
  placeholder?: string;
  sources?: PromptBarSource[];
  commands?: PromptBarCommand[];
  models?: PromptBarModel[];
  defaultModel?: string;
  /** 受控模型 key；不传时用 `defaultModel` 初始化组件内部状态。 */
  modelValue?: string;
  /** 组件里换了模型（用于同步外部的模型设置 / 上下文预算）。 */
  onModelChange?: (model: PromptBarModel) => void;
  efforts?: string[];
  defaultEffort?: string;
  /** 受控思考强度标签；不传时组件内部维护。 */
  effortValue?: string;
  onEffortChange?: (effort: string) => void;
  busy?: boolean;
  /** 外部原因禁止发送（如服务器未连接）：按钮禁用并给出原因，草稿仍可编辑。 */
  sendDisabled?: boolean;
  sendDisabledReason?: string;
  /** 运行中输入正文时，发送键的语义提示（如「加入队列」/「补充给当前任务」）。 */
  busySendLabel?: string;
  onSend?: (text: string, detail: PromptBarSendDetail) => void;
  /** 运行中按 Alt/Ctrl/Cmd+Enter 触发另一模式（排队 ↔ 补充）。 */
  onAltSend?: (text: string, detail: PromptBarSendDetail) => void;
  onStop?: () => void;
  onAttach?: () => string | string[] | void | Promise<string | string[] | void>;
  onDictate?: () => string | void | Promise<string | void>;
  background?: string;
  color?: string;
  menuBackground?: string;
  sparkColor?: string;
  sparkBoost?: number;
  width?: number;
  radius?: number;
  maxRows?: number;
  pressScale?: number;
  className?: string;
  /**
   * 底行右侧、发送键左边的插槽（本项目的适配点，官方没有）。
   *
   * 超能模式把顶栏的「终端 / 右栏 / 任务历史」放进输入框内部右下角，
   * 由这里渲染，保住发送键永远在最后一个。
   */
  trailing?: ReactNode;
  /**
   * 附件胶囊左侧的图标（本项目的适配点，官方写死一个通用文件图标）。
   *
   * 超能模式按扩展名给 vscode-icons（.conf / .log / Dockerfile / 图片…），
   * 组件本身不依赖任何图标集，由调用方决定。
   */
  renderAttachmentIcon?: (file: string) => ReactNode;
}

type Row = {
  key: string;
  name: string;
  description?: string;
  tag?: string;
  icon?: ReactNode | IconSvgElement;
  attach?: boolean;
  action?: () => void;
};
type Token = { kind: 'at' | 'slash'; query: string; start: number };
type Latest = Pick<
  PromptBarProps,
  'onSend' | 'onAltSend' | 'onStop' | 'onAttach' | 'onDictate' | 'onEffortChange' | 'onModelChange'
>;
type Spark = {
  x: number;
  y: number;
  r: number;
  vy: number;
  sway: number;
  phase: number;
  life: number;
  span: number;
};

const LINE = 22;
const EDGE = 11;

const DEFAULT_SOURCES: PromptBarSource[] = [
  {
    key: 'files',
    name: 'Photos & files',
    description: 'Upload from this device',
    icon: Attachment01Icon,
    attach: true
  },
  { key: 'web', name: 'Web search', description: 'Live results', icon: Globe02Icon },
  { key: 'sales', name: 'Sales data', description: 'Revenue and churn', icon: ChartLineData01Icon },
  { key: 'docs', name: 'Documents', description: 'Specs, notes, briefs', icon: File02Icon },
  { key: 'mail', name: 'Mail', description: 'Read and draft mail', icon: Mail01Icon },
  { key: 'calendar', name: 'Calendar', description: 'Events and availability', icon: Calendar03Icon }
];
const DEFAULT_COMMANDS: PromptBarCommand[] = [
  { key: 'summarize', name: '/summarize', description: 'Digest the thread so far' },
  { key: 'compare', name: '/compare', description: 'Two options side by side' },
  { key: 'draft', name: '/draft', description: 'Write a first version' },
  { key: 'explain', name: '/explain', description: 'A plain-language walkthrough' },
  { key: 'tasks', name: '/tasks', description: 'Turn this into a to-do list' }
];
const DEFAULT_MODELS: PromptBarModel[] = [
  { key: 'nova-3', name: 'Nova 3', tag: 'Flagship' },
  { key: 'nova-mini', name: 'Nova Mini', tag: 'Fast' },
  { key: 'nova-2', name: 'Nova 2', tag: 'Legacy' }
];
const DEFAULT_EFFORTS = ['Low', 'Medium', 'High', 'Extra', 'Max'];

const parseToken = (draft: string): Token | null => {
  const m = /(^|\s)([@/])([\w-]*)$/.exec(draft);
  if (!m) return null;
  return { kind: m[2] === '@' ? 'at' : 'slash', query: m[3].toLowerCase(), start: m.index + m[1].length };
};

const renderIcon = (icon: ReactNode | IconSvgElement, size: number) =>
  isValidElement(icon) ? icon : <HugeiconsIcon icon={icon as IconSvgElement} size={size} strokeWidth={1.8} />;

const STYLE = `
@keyframes prompt-bar-pop { from { opacity: 0; transform: translateY(4px) scale(0.98); } }
@keyframes prompt-bar-eq { 0%, 100% { transform: scaleY(0.35); } 50% { transform: scaleY(1); } }
@keyframes prompt-effort-flow { from { transform: translateX(-45%); } to { transform: translateX(45%); } }
@keyframes prompt-effort-pulse { 0%, 100% { opacity: .35; transform: scale(.9); } 50% { opacity: .85; transform: scale(1.12); } }
.prompt-effort-flow { animation: prompt-effort-flow var(--effort-speed, 4s) ease-in-out infinite alternate; }
.prompt-effort-pulse { animation: prompt-effort-pulse var(--effort-speed, 4s) ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) { .prompt-effort-flow, .prompt-effort-pulse { animation: none; } }
[data-motion="reduced"] .prompt-effort-flow, [data-motion="reduced"] .prompt-effort-pulse { animation: none; }
`;

const PromptBar: React.FC<PromptBarProps> = ({
  placeholder = 'Ask anything',
  sources = DEFAULT_SOURCES,
  commands = DEFAULT_COMMANDS,
  models = DEFAULT_MODELS,
  defaultModel = '',
  modelValue,
  onModelChange,
  efforts = DEFAULT_EFFORTS,
  defaultEffort = '',
  effortValue,
  onEffortChange,
  busy = false,
  sendDisabled = false,
  sendDisabledReason,
  busySendLabel,
  onSend,
  onAltSend,
  onStop,
  onAttach,
  onDictate,
  value,
  onChange,
  attachments: controlledAttachments,
  onAttachmentsChange,
  background = '#27272a',
  color = '#f5f5f5',
  menuBackground = '#323236',
  sparkColor = '#b39dff',
  sparkBoost = 1,
  width = 400,
  radius = 16,
  maxRows = 5,
  pressScale = 0.96,
  className = '',
  trailing,
  renderAttachmentIcon
}) => {
  const { t } = useTranslation();
  const reduce = useReducedMotion();
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const glowRef = useRef<HTMLSpanElement>(null);
  const sparkRef = useRef<HTMLCanvasElement>(null);
  const boost = useRef(sparkBoost);
  boost.current = sparkBoost;
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const lastOpen = useRef<string | null>(null);
  const dictation = useRef(0);
  const latest = useRef<Latest>({});
  latest.current = { onSend, onAltSend, onStop, onAttach, onDictate, onEffortChange, onModelChange };

  const [draftState, setDraftState] = useState('');
  const [attachmentState, setAttachmentState] = useState<string[]>([]);
  const draft = value !== undefined ? value : draftState;
  const attachments = controlledAttachments ?? attachmentState;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const setDraft = (next: string | ((prev: string) => string)) => {
    const resolved = typeof next === 'function' ? next(draftRef.current) : next;
    if (value === undefined) setDraftState(resolved);
    onChange?.(resolved);
  };
  const setAttachments = (next: string[] | ((files: string[]) => string[])) => {
    const resolved = typeof next === 'function' ? next(attachments) : next;
    if (controlledAttachments === undefined) setAttachmentState(resolved);
    onAttachmentsChange?.(resolved);
  };
  const [modelKey, setModelKey] = useState(defaultModel);
  const [plusOpen, setPlusOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [effortOpen, setEffortOpen] = useState(false);
  const [effortIndex, setEffortIndex] = useState(() => {
    const i = efforts.indexOf(defaultEffort);
    return i >= 0 ? i : Math.max(0, Math.floor((efforts.length - 1) / 2));
  });
  const [dismissed, setDismissed] = useState(false);
  const [active, setActive] = useState(0);
  const [listening, setListening] = useState(false);

  const resolvedModelKey = modelValue ?? modelKey;
  const model = models.find(m => m.key === resolvedModelKey) ?? models[0];
  const token = dismissed ? null : parseToken(draft);
  const open = plusOpen ? 'at' : (token?.kind ?? (modelOpen ? 'model' : effortOpen ? 'effort' : null));
  const query = plusOpen ? '' : (token?.query ?? '');
  const list = useMemo<Row[]>(() => {
    if (open === 'at') return sources.filter(s => s.name.toLowerCase().includes(query) || s.key.toLowerCase().includes(query));
    if (open === 'slash') {
      if (!query) return commands;
      const scored = commands
        .map(c => {
          const key = c.key.toLowerCase();
          const name = c.name.replace(/^\//, '').toLowerCase();
          const desc = (c.description ?? '').toLowerCase();
          const rank =
            key.startsWith(query) || name.startsWith(query)
              ? 0
              : key.includes(query) || name.includes(query)
                ? 1
                : desc.includes(query)
                  ? 2
                  : -1;
          return { c, rank };
        })
        .filter(item => item.rank >= 0)
        .sort((a, b) => a.rank - b.rank);
      return scored.map(item => item.c);
    }
    if (open === 'model') return models;
    return [];
  }, [open, query, sources, commands, models]);
  const cursor = Math.min(active, Math.max(0, list.length - 1));
  // 本项目只发正文：附件是右栏勾选的上下文，不能单独发空消息。
  // sendDisabled 只拦发送，不拦 busy 时的「停止」—— 断连了也要能停。
  const canSend = draft.trim().length > 0 && !sendDisabled;
  const armed = busy || canSend;
  const controlledEffortIndex = effortValue !== undefined ? efforts.indexOf(effortValue) : -1;
  const activeEffortIndex = controlledEffortIndex >= 0 ? controlledEffortIndex : effortIndex;
  const level = efforts[activeEffortIndex] ?? '';
  const maxed = efforts.length > 1 && activeEffortIndex === efforts.length - 1;

  /*
   * 外部换模型时档位列表会变短：把游标夹回可用范围，并跟上该模型记住的档位。
   * 不这么做的话，切到不支持思考强度的模型会显示空标签。
   */
  useEffect(() => {
    setEffortIndex(index => Math.min(index, Math.max(0, efforts.length - 1)));
  }, [efforts.length]);
  useEffect(() => {
    const index = efforts.indexOf(defaultEffort);
    if (index >= 0) setEffortIndex(index);
  }, [defaultEffort, efforts]);

  const focusInput = () => inputRef.current?.focus({ preventScroll: true });
  const closeMenus = useCallback(() => {
    setPlusOpen(false);
    setModelOpen(false);
    setEffortOpen(false);
  }, []);

  useLayoutEffect(() => {
    const glow = glowRef.current;
    if (!glow || !open) return;
    const row = rowRefs.current[cursor];
    if (!row) {
      glow.style.opacity = '0';
      return;
    }
    const fresh = lastOpen.current !== open;
    lastOpen.current = open;
    if (fresh) glow.style.transition = 'none';
    glow.style.top = `${row.offsetTop}px`;
    glow.style.height = `${row.offsetHeight}px`;
    glow.style.opacity = '1';
    if (fresh) {
      void glow.offsetHeight;
      glow.style.transition = '';
    }
  }, [open, cursor, list]);
  useEffect(() => {
    if (!open) lastOpen.current = null;
  }, [open]);

  useEffect(() => {
    if (!plusOpen && !modelOpen && !effortOpen) return undefined;
    const onDown = (e: globalThis.PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) closeMenus();
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [plusOpen, modelOpen, effortOpen, closeMenus]);

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = '0px';
    const max = LINE * maxRows;
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden';
  }, [draft, maxRows]);

  useEffect(
    () => () => {
      dictation.current += 1;
    },
    []
  );

  useEffect(() => {
    const canvas = sparkRef.current;
    if (!maxed || reduce || !canvas) return undefined;
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;
    let raf = 0;
    let last = performance.now();
    let w = 0;
    let h = 0;
    let due = 0;
    const parts: Spark[] = [];
    let resizePending = false;
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      w = rect.width;
      h = rect.height;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    const spawn = (burst: boolean) => {
      parts.push({
        x: Math.random() * w,
        y: burst ? h * (0.2 + Math.random() * 0.8) : h + 3,
        r: 0.9 + Math.random() * 1.1,
        vy: -(7 + Math.random() * 9),
        sway: (Math.random() - 0.5) * 10,
        phase: Math.random() * Math.PI * 2,
        life: burst ? Math.random() * 1.2 : 0,
        span: 2.4 + Math.random() * 2.4
      });
    };
    const tick = (now: number) => {
      if (resizePending) {
        resizePending = false;
        resize();
      }
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      /*
       * 粒子只做**匀速漂浮 + 很慢的呼吸**：以前打字会给能量、每敲一下加速并放大
       * 发光，看起来就是"一输入就抖"。现在输入完全不参与动画。
       */
      const speed = Math.max(0.2, boost.current || 1);
      due += dt;
      while (due > 0.14) {
        due -= 0.14;
        if (parts.length < 30) spawn(false);
      }
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = sparkColor;
      ctx.shadowColor = sparkColor;
      ctx.shadowBlur = 6 + 2 * speed;
      for (let i = parts.length - 1; i >= 0; i -= 1) {
        const p = parts[i];
        p.life += dt;
        if (p.life > p.span) {
          parts.splice(i, 1);
          continue;
        }
        const k = p.life / p.span;
        const twinkle = 0.85 + 0.15 * Math.sin(now / 320 + p.phase);
        p.y += p.vy * dt * speed;
        if (p.y < -4) {
          p.y = h + 3;
          p.x = Math.random() * w;
        }
        const edge = Math.min(1, Math.max(0, p.y / 14), Math.max(0, (h - p.y) / 14));
        ctx.globalAlpha = Math.min(1, Math.sin(k * Math.PI) * 0.9 * twinkle) * edge;
        ctx.beginPath();
        ctx.arc(
          p.x + Math.sin(now / 900 + p.phase) * p.sway,
          p.y,
          p.r * twinkle,
          0,
          Math.PI * 2
        );
        ctx.fill();
      }
      raf = requestAnimationFrame(tick);
    };
    resize();
    for (let i = 0; i < 26; i += 1) spawn(true);
    const ro = new ResizeObserver(() => {
      resizePending = true;
    });
    ro.observe(canvas);
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      ctx.clearRect(0, 0, w, h);
    };
  }, [maxed, reduce, sparkColor]);

  const setEffort = (i: number) => {
    const next = Math.max(0, Math.min(efforts.length - 1, i));
    if (next === activeEffortIndex) return;
    if (effortValue === undefined) setEffortIndex(next);
    latest.current.onEffortChange?.(efforts[next]);
  };
  const effortFromPointer = (e: PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const k = (e.clientX - rect.left - EDGE) / Math.max(1, rect.width - 2 * EDGE);
    setEffort(Math.round(k * (efforts.length - 1)));
  };
  const onEffortKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step =
      e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0;
    if (step) {
      e.preventDefault();
      setEffort(activeEffortIndex + step);
    } else if (e.key === 'Home') {
      e.preventDefault();
      setEffort(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setEffort(efforts.length - 1);
    } else if (e.key === 'Escape') {
      setEffortOpen(false);
      focusInput();
    }
  };
  const stepAt = (i: number) => `calc(${EDGE}px + (100% - ${EDGE * 2}px) * ${i / Math.max(1, efforts.length - 1)})`;
  const fillAt = (i: number) => (i === efforts.length - 1 ? '100%' : `calc(${stepAt(i)} + 7px)`);

  const pick = (row: Row) => {
    if (open === 'model') {
      if (modelValue === undefined) setModelKey(row.key);
      latest.current.onModelChange?.(
        models.find(item => item.key === row.key) ?? { key: row.key, name: row.name, tag: row.tag }
      );
      setModelOpen(false);
      focusInput();
      return;
    }
    const head = token ? draft.slice(0, token.start) : draft;
    if (row.action) {
      setDraft(head);
      row.action();
    } else if (row.attach) {
      setDraft(head);
      Promise.resolve(latest.current.onAttach?.()).then(files => {
        if (!files) return;
        setAttachments(a => [...a, ...(Array.isArray(files) ? files : [files])]);
      });
    } else if (open === 'at') {
      setDraft(`${head}@${row.name} `);
    } else {
      setDraft(`${head}${row.name} `);
    }
    setPlusOpen(false);
    setDismissed(false);
    focusInput();
  };

  const send = (alternate = false) => {
    /*
     * 本项目允许「执行中来消息」：确认条没处理完时用户可以直接补一句，
     * 由页面判断是补充条件还是被挡下（并给出说明）。所以这里不拦 busy。
     */
    if (!canSend) return;
    const handler = alternate && latest.current.onAltSend ? latest.current.onAltSend : latest.current.onSend;
    handler?.(draft.trim(), { attachments, model, effort: level });
    /*
     * 受控时由页面决定是否清空：执行中/停止中的消息会被页面挡下并保留草稿，
     * 组件自己清空会让用户"打了一半的话"凭空消失。
     */
    if (value === undefined) setDraft('');
    if (controlledAttachments === undefined) setAttachmentState([]);
    setDismissed(false);
    closeMenus();
    focusInput();
  };

  const toggleListen = () => {
    if (listening) {
      dictation.current += 1;
      setListening(false);
      return;
    }
    const seq = ++dictation.current;
    setListening(true);
    Promise.resolve(latest.current.onDictate?.()).then(
      text => {
        if (seq !== dictation.current) return;
        setListening(false);
        if (text) setDraft(d => (d.trim() ? `${d.trimEnd()} ${text}` : text));
        focusInput();
      },
      () => {
        if (seq === dictation.current) setListening(false);
      }
    );
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    /*
     * 输入法组合期间（中文选词）回车 / 方向键属于输入法，**先放行**。
     *
     * 以前只在最后"发送"那一支判 `isComposing`：建议菜单开着时，选词用的
     * 回车会先被 `pick()` 吃掉（菜单选中一条），句子发不出去。WebView2 上
     * 提交选词的那次 keydown 有时不带 `isComposing`，再用 keyCode 229 兜底。
     */
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (open && list.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((cursor + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length);
        return;
      }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        e.preventDefault();
        pick(list[cursor]);
        return;
      }
    }
    if (e.key === 'Escape') {
      if (open) {
        e.preventDefault();
        setDismissed(true);
        closeMenus();
      } else if (busy && draft.trim().length === 0) {
        // Codex 交互：输入为空、无弹层时按 Esc 停止当前运行。
        e.preventDefault();
        latest.current.onStop?.();
      }
      return;
    }
    // 组合态已经在函数开头统一放行了，这里只剩"真的按了回车"。
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send(busy && (e.altKey || e.ctrlKey || e.metaKey));
    }
  };

  return (
    <div
      ref={rootRef}
      className={`group relative text-[14px] leading-[22px] [width:min(var(--pb-w),100%)] [color:var(--pb-ink)]${className ? ` ${className}` : ''}`}
      data-busy={busy ? '' : undefined}
      data-max={maxed ? '' : undefined}
      style={
        {
          '--pb-bg': background,
          '--pb-ink': color,
          '--pb-menu': menuBackground,
          '--pb-w': `${width}px`,
          '--pb-radius': `${radius}px`,
          '--pb-spark': sparkColor,
          '--pb-press': pressScale
        } as CSSProperties
      }
    >
      <style>{STYLE}</style>
      {open ? (
        <div
          className="absolute inset-x-0 bottom-[calc(100%+8px)] z-[2] origin-bottom rounded-xl p-1 shadow-[0_10px_30px_-10px_rgba(0,0,0,0.35),0_1px_2px_rgba(0,0,0,0.08)] [animation:prompt-bar-pop_180ms_cubic-bezier(0.23,1,0.32,1)_both] [background:var(--pb-menu)] data-[kind=model]:right-auto data-[kind=model]:w-[200px] data-[kind=model]:origin-bottom-left data-[kind=effort]:right-auto data-[kind=effort]:w-[248px] data-[kind=effort]:origin-bottom-left data-[kind=effort]:px-3.5 data-[kind=effort]:pt-3 data-[kind=effort]:pb-3.5 motion-reduce:[animation:none]"
          role={open === 'effort' ? 'dialog' : 'listbox'}
          aria-label={
            open === 'at'
              ? t('Sources')
              : open === 'slash'
                ? t('Commands')
                : open === 'model'
                  ? t('Models')
                  : t('Effort')
          }
          data-kind={open}
        >
          {open === 'effort' ? (
            <>
              <div className="flex items-center gap-2 text-[13px] leading-[18px]">
                <span className="[color:color-mix(in_srgb,var(--pb-ink)_55%,transparent)]">{t('Effort')}</span>
                <span className="rounded-md px-1.5 py-0.5 font-semibold [color:var(--pb-spark)] [background:color-mix(in_srgb,var(--pb-spark)_10%,transparent)]">{level}</span>
                <span
                  className="ml-auto inline-flex [color:color-mix(in_srgb,var(--pb-ink)_55%,transparent)]"
                  title={t('Higher effort thinks longer before answering')}
                >
                  <HugeiconsIcon icon={HelpCircleIcon} size={14} strokeWidth={1.8} />
                </span>
              </div>
              {efforts.length > 1 ? (
                <>
                  <div className="mt-3 flex justify-between text-[12px] leading-4 [color:color-mix(in_srgb,var(--pb-ink)_60%,transparent)]">
                    <span>{t('Faster')}</span>
                    <span>{t('Smarter')}</span>
                  </div>
                  <div
                    className="relative mt-2 h-[22px] cursor-pointer touch-none rounded-full outline-none select-none [background:color-mix(in_srgb,var(--pb-ink)_8%,transparent)] focus-visible:ring-2 focus-visible:ring-[var(--pb-spark)] focus-visible:ring-offset-2"
                    role="slider"
                    tabIndex={0}
                    aria-label={t('Effort')}
                    aria-valuemin={0}
                    aria-valuemax={efforts.length - 1}
                    aria-valuenow={activeEffortIndex}
                    aria-valuetext={level}
                    style={
                      { '--pb-effort-x': stepAt(activeEffortIndex), '--pb-effort-fill': fillAt(activeEffortIndex), '--effort-speed': `${5 - 2 * (activeEffortIndex / (efforts.length - 1))}s`, '--effort-opacity': 0.15 + 0.35 * (activeEffortIndex / (efforts.length - 1)) } as CSSProperties
                    }
                    onPointerDown={e => {
                      if (e.button !== 0) return;
                      try {
                        e.currentTarget.setPointerCapture(e.pointerId);
                      } catch {}
                      e.currentTarget.focus({ preventScroll: true });
                      effortFromPointer(e);
                    }}
                    onPointerMove={e => {
                      if (e.buttons & 1) effortFromPointer(e);
                    }}
                    onKeyDown={onEffortKey}
                  >
                    <span className="pointer-events-none absolute inset-y-0 left-0 overflow-hidden rounded-full [width:var(--pb-effort-fill)] [background:color-mix(in_srgb,var(--pb-spark)_18%,transparent)] [transition:width_220ms_cubic-bezier(0.23,1,0.32,1)] motion-reduce:[transition:none]">
                      <span className="prompt-effort-flow absolute inset-y-0 -left-1/2 w-full [opacity:var(--effort-opacity)] [background:linear-gradient(90deg,transparent,var(--pb-spark),transparent)]" />
                    </span>
                    {efforts.map((label, i) => (
                      <i
                        key={label}
                        className="absolute top-1/2 -mt-0.5 -ml-0.5 h-1 w-1 rounded-full [background:color-mix(in_srgb,var(--pb-ink)_40%,transparent)]"
                        style={{ left: stepAt(i) }}
                      />
                    ))}
                    <span className="absolute -top-[3px] -ml-[7px] h-7 w-3.5 rounded-[7px] shadow-[0_2px_6px_rgba(0,0,0,0.25)] [left:var(--pb-effort-x)] [background:var(--pb-ink)] [transition:left_220ms_cubic-bezier(0.23,1,0.32,1)] motion-reduce:[transition:none]">
                      <span className="prompt-effort-pulse absolute inset-0 rounded-[7px] [background:var(--pb-spark)] [opacity:var(--effort-opacity)]" />
                    </span>
                  </div>
                </>
              ) : (
                /*
                 * 能力表里没有这个模型：只有「默认」一档。渲染一根动不了的滑杆
                 * 会让人以为坏了，这里直接说明原因（请求按供应商默认值执行）。
                 */
                <p className="mt-3 text-[12px] leading-[18px] [color:color-mix(in_srgb,var(--pb-ink)_55%,transparent)]">
                  {t('This model has no adjustable reasoning effort; requests use the provider default.')}
                </p>
              )}
            </>
          ) : (
            <>
              <span
                ref={glowRef}
                className="pointer-events-none absolute inset-x-1 rounded-lg opacity-0 [background:color-mix(in_srgb,var(--pb-ink)_8%,transparent)] [transition:top_220ms_cubic-bezier(0.23,1,0.32,1),height_220ms_cubic-bezier(0.23,1,0.32,1),opacity_150ms_ease] motion-reduce:[transition:opacity_150ms_ease]"
                aria-hidden="true"
              />
              {list.map((row, i) => (
                <button
                  key={row.key}
                  ref={el => {
                    rowRefs.current[i] = el;
                  }}
                  type="button"
                  role="option"
                  aria-selected={i === cursor}
                  className="relative z-[1] flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-lg border-0 bg-transparent px-2 text-left text-inherit outline-none [font:inherit] [-webkit-tap-highlight-color:transparent]"
                  onMouseDown={e => e.preventDefault()}
                  onPointerEnter={() => setActive(i)}
                  onClick={() => pick(row)}
                >
                  {open === 'at' ? (
                    <span className="inline-flex w-5 flex-none justify-center [color:color-mix(in_srgb,var(--pb-ink)_70%,transparent)]">
                      {renderIcon(row.icon, 15)}
                    </span>
                  ) : null}
                  <span className="flex-none text-[13px] font-medium">{row.name}</span>
                  {row.description ? (
                    <span className="min-w-0 flex-auto truncate text-[12px] [color:color-mix(in_srgb,var(--pb-ink)_55%,transparent)]">
                      {row.description}
                    </span>
                  ) : null}
                  {open === 'slash' ? (
                    <span className="ml-auto flex-none rounded px-1.5 py-0.5 font-mono text-[11px] [background:color-mix(in_srgb,var(--pb-ink)_6%,transparent)] [color:color-mix(in_srgb,var(--pb-ink)_55%,transparent)]">
                      /{row.key}
                    </span>
                  ) : null}
                  {open === 'model' ? (
                    <>
                      <span className="ml-auto flex-none text-[11px] [color:color-mix(in_srgb,var(--pb-ink)_55%,transparent)]">
                        {row.tag}
                      </span>
                      <span
                        className="inline-flex w-4 flex-none justify-center opacity-0 data-[on]:opacity-100"
                        data-on={row.key === model?.key ? '' : undefined}
                      >
                        <HugeiconsIcon icon={Tick02Icon} size={13} strokeWidth={2.5} />
                      </span>
                    </>
                  ) : null}
                </button>
              ))}
              {list.length === 0 ? (
                <div className="flex h-9 items-center px-2 text-[12px] [color:color-mix(in_srgb,var(--pb-ink)_55%,transparent)]">
                  {t('No matches for “{{query}}”', { query })}
                </div>
              ) : null}
            </>
          )}
        </div>
      ) : null}

      <div
        className="relative isolate flex cursor-text flex-col gap-2 p-3 [background:var(--pb-bg)] [border-radius:var(--pb-radius)]"
        role="presentation"
        data-max={maxed ? '' : undefined}
        onPointerDown={e => {
          if (e.target === e.currentTarget || e.target === inputRef.current) closeMenus();
        }}
        onClick={focusInput}
      >
        {attachments.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {attachments.map((file, i) => (
              <span
                key={`${file}-${i}`}
                className="inline-flex h-[26px] items-center gap-1.5 rounded-lg pr-1 pl-2 text-[12px] [animation:prompt-bar-pop_200ms_cubic-bezier(0.23,1,0.32,1)_both] [background:color-mix(in_srgb,var(--pb-ink)_8%,transparent)] motion-reduce:[animation:none]"
              >
                {renderAttachmentIcon ? (
                  renderAttachmentIcon(file)
                ) : (
                  <HugeiconsIcon icon={File02Icon} size={12} strokeWidth={2} />
                )}
                <span className="max-w-[144px] truncate">{file}</span>
                <button
                  type="button"
                  className="inline-grid h-[18px] w-[18px] cursor-pointer place-items-center rounded-[5px] border-0 bg-transparent p-0 text-inherit opacity-60 outline-none [transition:opacity_120ms_ease,background-color_120ms_ease] hover:opacity-100 hover:[background:color-mix(in_srgb,var(--pb-ink)_10%,transparent)]"
                  aria-label={t('Remove {{file}}', { file })}
                  onClick={() => setAttachments(a => a.filter((_, j) => j !== i))}
                >
                  <HugeiconsIcon icon={Cancel01Icon} size={10} strokeWidth={2.5} />
                </button>
              </span>
            ))}
          </div>
        ) : null}

        <textarea
          ref={inputRef}
          className="block w-full resize-none border-0 bg-transparent p-0 text-[14px] leading-[22px] text-inherit outline-none [font:inherit] [overflow-wrap:anywhere] placeholder:[color:color-mix(in_srgb,var(--pb-ink)_45%,transparent)] [@media(pointer:coarse)]:text-[16px]"
          rows={1}
          value={draft}
          placeholder={listening ? t('Listening…') : placeholder}
          aria-label={t('Prompt')}
          onChange={e => {
            setDraft(e.target.value);
            setDismissed(false);
            closeMenus();
            setActive(0);
          }}
          onKeyDown={onKeyDown}
        />

        <div className="flex items-center gap-1">
          <Tooltip label={t('Add files and sources')}>
            <button
              type="button"
              className="inline-grid h-7 w-7 flex-none cursor-pointer touch-manipulation place-items-center rounded-lg border-0 bg-transparent p-0 outline-none select-none [color:color-mix(in_srgb,var(--pb-ink)_60%,transparent)] [font:inherit] [-webkit-tap-highlight-color:transparent] [transition:background-color_150ms_ease,color_150ms_ease,transform_160ms_cubic-bezier(0.23,1,0.32,1)] active:[transform:scale(0.94)] data-[on]:[background:color-mix(in_srgb,var(--pb-ink)_8%,transparent)] data-[on]:[color:var(--pb-ink)] motion-reduce:active:[transform:none] [@media(hover:hover)_and_(pointer:fine)]:hover:[background:color-mix(in_srgb,var(--pb-ink)_8%,transparent)] [@media(hover:hover)_and_(pointer:fine)]:hover:[color:var(--pb-ink)]"
              aria-label={t('Add files and sources')}
              aria-expanded={plusOpen}
              data-on={plusOpen ? '' : undefined}
              onMouseDown={e => e.preventDefault()}
              onClick={() => {
                setModelOpen(false);
                setEffortOpen(false);
                setActive(0);
                setPlusOpen(v => !v);
                focusInput();
              }}
            >
              <HugeiconsIcon icon={PlusSignIcon} size={16} strokeWidth={2} />
            </button>
          </Tooltip>
          {models.length > 0 ? (
            <button
              type="button"
              className="inline-flex h-7 flex-none cursor-pointer touch-manipulation items-center gap-1 rounded-lg border-0 bg-transparent px-2 text-[12px] font-medium outline-none select-none [color:color-mix(in_srgb,var(--pb-ink)_70%,transparent)] [font:inherit] [-webkit-tap-highlight-color:transparent] [transition:background-color_150ms_ease,color_150ms_ease] data-[on]:[background:color-mix(in_srgb,var(--pb-ink)_8%,transparent)] data-[on]:[color:var(--pb-ink)] [@media(hover:hover)_and_(pointer:fine)]:hover:[background:color-mix(in_srgb,var(--pb-ink)_8%,transparent)] [@media(hover:hover)_and_(pointer:fine)]:hover:[color:var(--pb-ink)] data-[max]:[color:var(--pb-spark)]! "
              aria-label={t('Choose model')}
              aria-expanded={modelOpen}
              data-on={modelOpen ? '' : undefined}
              onMouseDown={e => e.preventDefault()}
              onClick={() => {
                setPlusOpen(false);
                setEffortOpen(false);
                setActive(Math.max(0, models.indexOf(model)));
                setModelOpen(v => !v);
                focusInput();
              }}
            >
              <span>{model.name}</span>
              <HugeiconsIcon icon={ArrowDown01Icon} size={12} strokeWidth={2.4} />
            </button>
          ) : null}
          {efforts.length > 0 ? (
            <button
              type="button"
              className="inline-flex h-7 flex-none cursor-pointer touch-manipulation items-center gap-1 rounded-lg border-0 bg-transparent px-2 text-[12px] font-medium outline-none select-none [color:color-mix(in_srgb,var(--pb-ink)_70%,transparent)] [font:inherit] [-webkit-tap-highlight-color:transparent] [transition:background-color_150ms_ease,color_150ms_ease] data-[on]:[background:color-mix(in_srgb,var(--pb-ink)_8%,transparent)] data-[on]:[color:var(--pb-ink)] [@media(hover:hover)_and_(pointer:fine)]:hover:[background:color-mix(in_srgb,var(--pb-ink)_8%,transparent)] [@media(hover:hover)_and_(pointer:fine)]:hover:[color:var(--pb-ink)] data-[max]:[color:var(--pb-spark)]! "
              aria-label={t('Choose effort')}
              aria-expanded={effortOpen}
              data-on={effortOpen ? '' : undefined}
              data-max={maxed ? '' : undefined}
              onMouseDown={e => e.preventDefault()}
              onClick={() => {
                setPlusOpen(false);
                setModelOpen(false);
                setEffortOpen(v => !v);
                focusInput();
              }}
            >
              <HugeiconsIcon icon={SparklesIcon} size={13} strokeWidth={2} />
              <span>{level}</span>
            </button>
          ) : null}
          <span className="flex-auto" />
          {trailing}
          {onDictate ? (
            <Tooltip label={listening ? t('Stop dictation') : t('Dictate')}>
              <button
                type="button"
                className="inline-grid h-7 w-7 flex-none cursor-pointer touch-manipulation place-items-center rounded-lg border-0 bg-transparent p-0 outline-none select-none [color:color-mix(in_srgb,var(--pb-ink)_60%,transparent)] [font:inherit] [-webkit-tap-highlight-color:transparent] [transition:background-color_150ms_ease,color_150ms_ease,transform_160ms_cubic-bezier(0.23,1,0.32,1)] active:[transform:scale(0.94)] data-[on]:[background:color-mix(in_srgb,var(--pb-ink)_8%,transparent)] data-[on]:[color:var(--pb-ink)] motion-reduce:active:[transform:none] [@media(hover:hover)_and_(pointer:fine)]:hover:[background:color-mix(in_srgb,var(--pb-ink)_8%,transparent)] [@media(hover:hover)_and_(pointer:fine)]:hover:[color:var(--pb-ink)]"
                aria-label={listening ? t('Stop dictation') : t('Dictate')}
                aria-pressed={listening}
                data-on={listening ? '' : undefined}
                onMouseDown={e => e.preventDefault()}
                onClick={toggleListen}
              >
                {listening ? (
                  <span
                    className="flex h-3.5 items-center gap-[2.5px] [&>i]:block [&>i]:h-full [&>i]:w-[2.5px] [&>i]:origin-center [&>i]:rounded-full [&>i]:bg-current [&>i]:[animation:prompt-bar-eq_900ms_ease-in-out_infinite] [&>i:nth-child(2)]:[animation-delay:150ms] [&>i:nth-child(3)]:[animation-delay:300ms]"
                    aria-hidden="true"
                  >
                    <i />
                    <i />
                    <i />
                  </span>
                ) : (
                  <HugeiconsIcon icon={Mic01Icon} size={15} strokeWidth={2} />
                )}
              </button>
            </Tooltip>
          ) : null}
          {/*
           * Codex 风格发送/停止区：
           * * 空闲或无正文：单按钮（发送 / 停止）；
           * * 运行中且已输入正文：停止键与发送键并列，点发送不会误停当前任务。
           */}
          {busy && canSend ? (
            <div className="flex flex-none items-center gap-1">
              <Tooltip label={t('Stop')}>
                <button
                  type="button"
                  className={[
                    'relative inline-grid h-6 w-6 flex-none cursor-pointer touch-manipulation place-items-center rounded-full border-0 p-0 outline-none select-none',
                    '[-webkit-tap-highlight-color:transparent]',
                    'transition-[background-color,color,box-shadow,transform] duration-150 ease-out',
                    'bg-fg/12 text-fg hover:bg-danger/15 hover:text-danger',
                    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
                    'active:[transform:scale(var(--pb-press))] motion-reduce:active:[transform:none]',
                  ].join(' ')}
                  aria-label={t('Stop')}
                  onMouseDown={e => e.preventDefault()}
                  onClick={() => latest.current.onStop?.()}
                >
                  <svg
                    className="block h-3 w-3"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                    aria-hidden="true"
                  >
                    <rect x="7" y="7" width="10" height="10" rx="2" />
                  </svg>
                </button>
              </Tooltip>
              <Tooltip label={busySendLabel ?? t('Send')}>
                <button
                  type="button"
                  className={[
                    'relative inline-grid h-6 w-6 flex-none cursor-pointer touch-manipulation place-items-center rounded-full border-0 p-0 outline-none select-none',
                    '[-webkit-tap-highlight-color:transparent]',
                    'transition-[background-color,color,box-shadow,transform] duration-150 ease-out',
                    'bg-accent text-white hover:bg-accent/90',
                    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
                    'active:[transform:scale(var(--pb-press))] motion-reduce:active:[transform:none]',
                  ].join(' ')}
                  aria-label={busySendLabel ?? t('Send')}
                  onMouseDown={e => e.preventDefault()}
                  onClick={() => send(false)}
                >
                  <svg
                    className="block h-3.5 w-3.5"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M12 19V5" />
                    <path d="m6 11 6-6 6 6" />
                  </svg>
                </button>
              </Tooltip>
            </div>
          ) : (
            <Tooltip label={busy ? t('Stop') : sendDisabled ? sendDisabledReason : t('Send')}>
            <button
              type="button"
              className={[
                'relative inline-grid h-6 w-6 flex-none touch-manipulation place-items-center rounded-full border-0 p-0 outline-none select-none',
                '[-webkit-tap-highlight-color:transparent]',
                'transition-[background-color,color,box-shadow,transform] duration-150 ease-out',
                'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
                'active:[transform:scale(var(--pb-press))] motion-reduce:active:[transform:none]',
                armed
                  ? 'cursor-pointer bg-accent text-white hover:bg-accent/90'
                  : 'cursor-not-allowed bg-fg/8 text-fg-subtle',
              ].join(' ')}
              disabled={!armed}
              aria-label={busy ? t('Stop') : t('Send')}
              onMouseDown={e => e.preventDefault()}
              onClick={() => {
                if (busy) latest.current.onStop?.();
                else send(false);
              }}
            >
              {busy ? (
                <svg
                  className="block h-3 w-3"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <rect x="7" y="7" width="10" height="10" rx="2" />
                </svg>
              ) : (
                <svg
                  className="block h-3.5 w-3.5"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M12 19V5" />
                  <path d="m6 11 6-6 6 6" />
                </svg>
              )}
            </button>
            </Tooltip>
          )}
        </div>
      </div>
    </div>
  );
};

export default PromptBar;
