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
import { animate, useMotionValue, useMotionValueEvent, useReducedMotion } from 'motion/react';
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
  /** 组件里换了模型（用于同步外部的模型设置 / 上下文预算）。 */
  onModelChange?: (model: PromptBarModel) => void;
  efforts?: string[];
  defaultEffort?: string;
  onEffortChange?: (effort: string) => void;
  busy?: boolean;
  /** 外部原因禁止发送（如服务器未连接）：按钮禁用并给出原因，草稿仍可编辑。 */
  sendDisabled?: boolean;
  sendDisabledReason?: string;
  onSend?: (text: string, detail: PromptBarSendDetail) => void;
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
  morphDuration?: number;
  squash?: number;
  tilt?: number;
  pressScale?: number;
  className?: string;
  /**
   * 底行右侧、发送键左边的插槽（本项目的适配点，官方没有）。
   *
   * 超能模式把顶栏的「终端 / 右栏 / 任务历史」放进输入框内部右下角，
   * 由这里渲染，保住发送键永远在最后一个。
   */
  trailing?: ReactNode;
}

type Row = {
  key: string;
  name: string;
  description?: string;
  tag?: string;
  icon?: ReactNode | IconSvgElement;
  attach?: boolean;
};
type Token = { kind: 'at' | 'slash'; query: string; start: number };
type Latest = Pick<
  PromptBarProps,
  'onSend' | 'onStop' | 'onAttach' | 'onDictate' | 'onEffortChange' | 'onModelChange'
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

interface SendGlyphProps {
  busy: boolean;
  morphDuration: number;
  squash: number;
  tilt: number;
}

const ARROW_UP = [12, 4.5, 18.5, 11, 14.25, 11, 14.25, 19.5, 9.75, 19.5, 9.75, 11, 5.5, 11];
const SQUARE = [12, 6, 18, 6, 18, 12, 18, 18, 6, 18, 6, 12, 6, 6];
const EASE_IN_OUT: [number, number, number, number] = [0.77, 0, 0.175, 1];
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

const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const pathAt = (a: number[], b: number[], t: number) => {
  let d = '';
  for (let i = 0; i < a.length; i += 2) {
    d += `${i ? 'L' : 'M'}${mix(a[i], b[i], t).toFixed(2)} ${mix(a[i + 1], b[i + 1], t).toFixed(2)}`;
  }
  return `${d}Z`;
};

const parseToken = (draft: string): Token | null => {
  const m = /(^|\s)([@/])([\w-]*)$/.exec(draft);
  if (!m) return null;
  return { kind: m[2] === '@' ? 'at' : 'slash', query: m[3].toLowerCase(), start: m.index + m[1].length };
};

const renderIcon = (icon: ReactNode | IconSvgElement, size: number) =>
  isValidElement(icon) ? icon : <HugeiconsIcon icon={icon as IconSvgElement} size={size} strokeWidth={1.8} />;

function SendGlyph({ busy, morphDuration, squash, tilt }: SendGlyphProps) {
  const reduce = useReducedMotion();
  const svgRef = useRef<SVGSVGElement>(null);
  const pathRef = useRef<SVGPathElement>(null);
  const dir = useRef(busy ? 1 : -1);
  const t = useMotionValue(busy ? 1 : 0);

  useEffect(() => {
    const target = busy ? 1 : 0;
    dir.current = busy ? 1 : -1;
    if (t.get() === target) return undefined;
    const controls = animate(
      t,
      target,
      reduce ? { duration: 0 } : { duration: morphDuration / 1000, ease: EASE_IN_OUT }
    );
    return () => controls.stop();
  }, [busy, morphDuration, reduce, t]);

  useMotionValueEvent(t, 'change', v => {
    pathRef.current?.setAttribute('d', pathAt(ARROW_UP, SQUARE, v));
    const goo = reduce ? 0 : Math.sin(v * Math.PI);
    const sx = 1 - squash * goo;
    if (svgRef.current) {
      svgRef.current.style.transform = goo ? `rotate(${dir.current * tilt * goo}deg) scale(${sx}, ${1 / sx})` : '';
    }
  });

  return (
    <svg
      ref={svgRef}
      className="block h-4 w-4 origin-center"
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="currentColor"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinejoin="round"
    >
      <path ref={pathRef} d={pathAt(ARROW_UP, SQUARE, t.get())} />
    </svg>
  );
}

const STYLE = `
@keyframes prompt-bar-pop { from { opacity: 0; transform: translateY(4px) scale(0.98); } }
@keyframes prompt-bar-eq { 0%, 100% { transform: scaleY(0.35); } 50% { transform: scaleY(1); } }
`;

const PromptBar: React.FC<PromptBarProps> = ({
  placeholder = 'Ask anything',
  sources = DEFAULT_SOURCES,
  commands = DEFAULT_COMMANDS,
  models = DEFAULT_MODELS,
  defaultModel = '',
  onModelChange,
  efforts = DEFAULT_EFFORTS,
  defaultEffort = '',
  onEffortChange,
  busy = false,
  sendDisabled = false,
  sendDisabledReason,
  onSend,
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
  morphDuration = 240,
  squash = 0.12,
  tilt = 8,
  pressScale = 0.96,
  className = '',
  trailing
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
  latest.current = { onSend, onStop, onAttach, onDictate, onEffortChange, onModelChange };

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

  const model = models.find(m => m.key === modelKey) ?? models[0];
  const token = dismissed ? null : parseToken(draft);
  const open = plusOpen ? 'at' : (token?.kind ?? (modelOpen ? 'model' : effortOpen ? 'effort' : null));
  const query = plusOpen ? '' : (token?.query ?? '');
  const list = useMemo<Row[]>(() => {
    if (open === 'at') return sources.filter(s => s.name.toLowerCase().includes(query));
    if (open === 'slash') return commands.filter(c => c.name.replace(/^\//, '').toLowerCase().startsWith(query));
    if (open === 'model') return models;
    return [];
  }, [open, query, sources, commands, models]);
  const cursor = Math.min(active, Math.max(0, list.length - 1));
  // 本项目只发正文：附件是右栏勾选的上下文，不能单独发空消息。
  // sendDisabled 只拦发送，不拦 busy 时的「停止」—— 断连了也要能停。
  const canSend = draft.trim().length > 0 && !sendDisabled;
  const armed = busy || canSend;
  const level = efforts[effortIndex] ?? '';
  const maxed = efforts.length > 1 && effortIndex === efforts.length - 1;

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
    if (next === effortIndex) return;
    setEffortIndex(next);
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
      setEffort(effortIndex + step);
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
      setModelKey(row.key);
      latest.current.onModelChange?.(
        models.find(item => item.key === row.key) ?? { key: row.key, name: row.name, tag: row.tag }
      );
      setModelOpen(false);
      focusInput();
      return;
    }
    const head = token ? draft.slice(0, token.start) : draft;
    if (row.attach) {
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

  const send = () => {
    /*
     * 本项目允许「执行中来消息」：确认条没处理完时用户可以直接补一句，
     * 由页面判断是补充条件还是被挡下（并给出说明）。所以这里不拦 busy，
     * 只有发送键在 busy 时切成了「停止」，不会一键两用。
     */
    if (!canSend) return;
    latest.current.onSend?.(draft.trim(), { attachments, model, effort: level });
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
      }
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
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
                <span className="font-medium">{level}</span>
                <span
                  className="ml-auto inline-flex [color:color-mix(in_srgb,var(--pb-ink)_55%,transparent)]"
                  title={t('Higher effort thinks longer before answering')}
                >
                  <HugeiconsIcon icon={HelpCircleIcon} size={14} strokeWidth={1.8} />
                </span>
              </div>
              {efforts.length > 1 ? (
                <>
                  <div className="mt-3 flex justify-between text-[12px] leading-4 [color:color-mix(in_srgb,var(--pb-ink)_55%,transparent)]">
                    <span>{t('Faster')}</span>
                    <span>{t('Smarter')}</span>
                  </div>
                  <div
                    className="relative mt-2 h-[22px] cursor-pointer touch-none rounded-[11px] outline-none select-none [background:color-mix(in_srgb,var(--pb-ink)_8%,transparent)]"
                    role="slider"
                    tabIndex={0}
                    aria-label={t('Effort')}
                    aria-valuemin={0}
                    aria-valuemax={efforts.length - 1}
                    aria-valuenow={effortIndex}
                    aria-valuetext={level}
                    style={
                      { '--pb-effort-x': stepAt(effortIndex), '--pb-effort-fill': fillAt(effortIndex) } as CSSProperties
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
                    <span className="absolute inset-y-0 left-0 rounded-[11px] [width:var(--pb-effort-fill)] [background:color-mix(in_srgb,var(--pb-ink)_18%,transparent)] [transition:width_220ms_cubic-bezier(0.23,1,0.32,1),background-color_300ms_ease] group-data-[max]:[background:color-mix(in_srgb,var(--pb-spark)_35%,transparent)] motion-reduce:[transition:background-color_300ms_ease]" />
                    {efforts.map((label, i) => (
                      <i
                        key={label}
                        className="absolute top-1/2 -mt-0.5 -ml-0.5 h-1 w-1 rounded-full [background:color-mix(in_srgb,var(--pb-ink)_30%,transparent)]"
                        style={{ left: stepAt(i) }}
                      />
                    ))}
                    <span className="absolute -top-[3px] -ml-[7px] h-7 w-3.5 rounded-[7px] shadow-[0_2px_6px_rgba(0,0,0,0.25)] [left:var(--pb-effort-x)] [background:var(--pb-ink)] [transition:left_220ms_cubic-bezier(0.23,1,0.32,1),background-color_300ms_ease] group-data-[max]:[background:var(--pb-spark)] motion-reduce:[transition:background-color_300ms_ease]" />
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
        className="relative isolate flex cursor-text flex-col gap-2 p-3 [background:var(--pb-bg)] [border-radius:var(--pb-radius)] before:pointer-events-none before:absolute before:inset-0 before:-z-10 before:rounded-[inherit] before:opacity-0 before:content-[''] before:[background:radial-gradient(140%_120%_at_0%_100%,color-mix(in_srgb,var(--pb-spark)_26%,transparent),transparent_62%)] before:[transition:opacity_500ms_ease] data-[max]:before:opacity-100"
        role="presentation"
        data-max={maxed ? '' : undefined}
        onPointerDown={e => {
          if (e.target === e.currentTarget || e.target === inputRef.current) closeMenus();
        }}
        onClick={focusInput}
      >
        <canvas
          ref={sparkRef}
          className="pointer-events-none absolute inset-0 -z-10 h-full w-full rounded-[inherit]"
          aria-hidden="true"
        />
        {attachments.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {attachments.map((file, i) => (
              <span
                key={`${file}-${i}`}
                className="inline-flex h-[26px] items-center gap-1.5 rounded-lg pr-1 pl-2 text-[12px] [animation:prompt-bar-pop_200ms_cubic-bezier(0.23,1,0.32,1)_both] [background:color-mix(in_srgb,var(--pb-ink)_8%,transparent)] motion-reduce:[animation:none]"
              >
                <HugeiconsIcon icon={File02Icon} size={12} strokeWidth={2} />
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
          ) : null}
          {          /*
           * 发送键换成项目自己的主按钮皮肤：`--accent` 实心 + 白图标 + 8px 圆角，
           * 和 `Button variant="primary"` 同一套质感（内高光 + 轻投影）；不再用
           * 官方那套深色皮肤（浅色主题下会变成一块黑色方块）。
           *
           * 空草稿 = 中性淡底、禁用；执行中 = 中性底 + 方块（停止）。
           */}
          <button
            type="button"
            className={[
              'relative inline-grid h-7 w-7 flex-none touch-manipulation place-items-center rounded-[8px] border-0 p-0 outline-none select-none',
              '[-webkit-tap-highlight-color:transparent]',
              'transition-[background-color,color,box-shadow,transform] duration-150 ease-out',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
              'active:[transform:scale(var(--pb-press))] motion-reduce:active:[transform:none]',
              busy
                ? 'cursor-pointer bg-fg/10 text-fg hover:bg-fg/15'
                : armed
                  ? 'cursor-pointer bg-accent text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.35),0_1px_2px_rgb(15_23_42/0.12)] hover:bg-accent/92 active:bg-accent/84'
                  : 'cursor-default bg-fg/8 text-fg-subtle',
            ].join(' ')}
            disabled={!armed}
            aria-label={busy ? t('Stop') : t('Send')}
            title={sendDisabled ? sendDisabledReason : undefined}
            onMouseDown={e => e.preventDefault()}
            onClick={() => {
              if (busy) latest.current.onStop?.();
              else send();
            }}
          >
            <SendGlyph busy={busy} morphDuration={morphDuration} squash={squash} tilt={tilt} />
          </button>
        </div>
      </div>
    </div>
  );
};

export default PromptBar;
