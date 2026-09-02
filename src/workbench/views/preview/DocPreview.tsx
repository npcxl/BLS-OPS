import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import type { DocBlock, Slide } from "@/lib/preview/blocks";

/**
 * Renders the shared block list produced by the Word and PowerPoint parsers.
 *
 * Both formats reduce to the same handful of blocks, so one renderer covers
 * both — the alternative (two near-identical components) would drift the
 * moment either format gains a block type.
 */
export function BlockList({ blocks }: { blocks: DocBlock[] }) {
  return (
    <div className="mx-auto flex max-w-[820px] flex-col gap-3 px-6 py-5">
      {blocks.map((block, index) => (
        <Block key={index} block={block} />
      ))}
    </div>
  );
}

function Block({ block }: { block: DocBlock }) {
  switch (block.type) {
    case "heading": {
      const size =
        block.level === 1 ? "text-20" : block.level === 2 ? "text-16" : "text-13";
      return (
        <h3 className={cn("font-semibold text-fg", size)}>{block.text}</h3>
      );
    }
    case "bullet":
      return (
        <p
          className="whitespace-pre-wrap text-12 leading-relaxed text-fg-muted"
          style={{ marginLeft: block.level * 16 }}
        >
          <span className="mr-1.5 text-fg-subtle">•</span>
          {block.text}
        </p>
      );
    case "paragraph":
      return <p className="whitespace-pre-wrap text-12 leading-relaxed text-fg-muted">{block.text}</p>;
    case "image":
      return (
        <img
          src={block.src}
          alt={block.alt}
          className="max-h-[420px] w-auto self-start rounded-[6px] border border-line"
        />
      );
    case "table":
      return (
        <div className="overflow-x-auto rounded-[6px] border border-line">
          <table className="w-full border-collapse text-11">
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex} className={rowIndex === 0 ? "bg-surface-2" : undefined}>
                  {row.map((cell, cellIndex) => (
                    <td
                      key={cellIndex}
                      className="border-b border-r border-line px-2 py-1 align-top text-fg-muted last:border-r-0"
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

/** Word documents: one continuous flow of blocks. */
export function DocxPreview({ blocks }: { blocks: DocBlock[] }) {
  return (
    <div className="h-full min-h-0 overflow-auto bg-surface-1">
      <BlockList blocks={blocks} />
    </div>
  );
}

/**
 * PowerPoint: a slide rail plus the current slide.
 *
 * Slides are shown as blocks rather than rendered pixel-exact — the preview is
 * for reading the content of a deck, not for presenting it.
 */
export function SlidesPreview({ slides }: { slides: Slide[] }) {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    setIndex(0);
  }, [slides]);

  const current = slides[Math.min(index, slides.length - 1)];
  if (!current) return null;

  return (
    <div className="flex h-full min-h-0">
      <div className="w-20 shrink-0 overflow-y-auto border-r border-line bg-surface-2/50 p-1.5">
        {slides.map((slide, slideIndex) => (
          <button
            key={slide.name}
            type="button"
            className={cn(
              "mb-1 flex w-full items-center justify-between rounded-[6px] px-1.5 py-1 text-10",
              slideIndex === index
                ? "bg-accent/15 text-fg"
                : "text-fg-subtle hover:bg-surface-hover hover:text-fg",
            )}
            onClick={() => setIndex(slideIndex)}
          >
            <span>{slideIndex + 1}</span>
            <span className="max-w-[38px] truncate text-fg-subtle">
              {firstLine(slide.blocks) || "—"}
            </span>
          </button>
        ))}
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex h-8 shrink-0 items-center gap-1 border-b border-line px-2">
          <Button
            size="xs"
            variant="ghost"
            disabled={index <= 0}
            onClick={() => setIndex((current) => Math.max(0, current - 1))}
          >
            <ChevronLeft size={12} />
          </Button>
          <span className="text-11 tabular-nums text-fg-muted">
            {index + 1} / {slides.length}
          </span>
          <Button
            size="xs"
            variant="ghost"
            disabled={index >= slides.length - 1}
            onClick={() => setIndex((current) => Math.min(slides.length - 1, current + 1))}
          >
            <ChevronRight size={12} />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="mx-auto my-4 min-h-[300px] w-[min(720px,92%)] rounded-[8px] border border-line bg-surface-1 p-5">
            <BlockList blocks={current.blocks} />
          </div>
        </div>
      </div>
    </div>
  );
}

function firstLine(blocks: DocBlock[]): string {
  const first = blocks.find((block) => block.type !== "image");
  if (!first) return "";
  if (first.type === "table") return "表格";
  return first.text.slice(0, 12);
}
