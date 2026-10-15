import { Children, isValidElement, useState, type ReactNode } from "react";
import { ArrowDown, ArrowLeft, ArrowUp, ArrowUpDown, Check, Copy, Download, Expand, Table2 } from "lucide-react";
import { Dialog, DialogPortal, DialogTitle } from "@/components/ui/dialog";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Button } from "@/components/ui/button";
import { useCopy } from "@/components/chat/use-copy";
import { compareTableValues, tableToCsv, type TableSort } from "@/lib/table-export";

type Node = { type: string; value?: string; tagName?: string; children?: Node[] };
const BR = /<br\s*\/?>/gi;
function plainText(node: Node): string {
  if (node.type === "text" || node.type === "raw") return (node.value ?? "").replace(BR, "\n").replace(/<\/?[a-z][^>]*>/gi, "");
  if (node.tagName === "br") return "\n";
  return (node.children ?? []).map(plainText).join("");
}
function elementChildren(value: ReactNode) {
  return Children.toArray(value).filter(isValidElement<{ children?: ReactNode; style?: { textAlign?: "left" | "right" | "center" } }>);
}

/** Turns literal <br> tags left in cell text into real line breaks and drops other stray tags. */
function cleanCell(value: ReactNode): ReactNode {
  return Children.map(value, (child) => {
    if (typeof child !== "string") return child;
    const parts = child.replace(/<\/?(?!br\b)[a-z][^>]*>/gi, "").split(BR);
    return parts.flatMap((part, i) => (i ? [<br key={i} />, part] : [part]));
  });
}

type TableData = {
  headers: ReturnType<typeof elementChildren>;
  rows: ReturnType<typeof elementChildren>;
  labels: string[];
  values: string[][];
};

function TableGrid({ data, sort, onSort, full }: { data: TableData; sort: TableSort; onSort: (column: number) => void; full?: boolean }) {
  const order = data.rows.map((_, index) => index);
  if (sort) order.sort((a, b) => (sort.direction === "ascending" ? 1 : -1) * compareTableValues(data.values[a]?.[sort.column] ?? "", data.values[b]?.[sort.column] ?? "") || a - b);
  return (
    <table className={`m-0 border-collapse text-sm leading-relaxed w-max min-w-full`}>
      <thead className="sticky top-0 z-10 bg-muted">
        <tr>{data.headers.map((cell, index) => {
          const active = sort?.column === index;
          const Icon = active ? sort.direction === "ascending" ? ArrowUp : ArrowDown : ArrowUpDown;
          const label = data.labels[index] || `Column ${index + 1}`;
          return <th key={index} scope="col" aria-sort={active ? sort.direction : "none"} className="min-w-28 max-w-80 border-b border-border p-0 text-left font-semibold">
            <Button variant="ghost" className="h-auto min-h-10 w-full justify-between whitespace-normal rounded-none px-3 py-2 text-left" aria-label={`Sort by ${label}`} title={`Sort by ${label}`} onClick={() => onSort(index)}>
              <span className="min-w-0 break-words">{cleanCell(cell.props.children)}</span><Icon className="shrink-0 text-muted-foreground" aria-hidden="true" />
            </Button>
          </th>;
        })}</tr>
      </thead>
      <tbody>{order.map((rowIndex) => <tr key={rowIndex} className="border-b border-border last:border-0 even:bg-muted/20 hover:bg-accent/40 focus-within:bg-accent/40">{elementChildren(data.rows[rowIndex]?.props.children).map((cell, column) => <td key={column} className={`min-w-28 max-w-80 break-words px-3 py-2.5 align-top [overflow-wrap:anywhere] ${cell.props.style?.textAlign === "right" ? "text-right tabular-nums" : cell.props.style?.textAlign === "center" ? "text-center" : "text-left"}`}>{cleanCell(cell.props.children)}</td>)}</tr>)}</tbody>
    </table>
  );
}

export default function TableReply({ children, node, markdown }: { children: ReactNode; node?: Node; markdown: string }) {
  const [sort, setSort] = useState<TableSort>(null);
  const [open, setOpen] = useState(false);
  const { copied, copy } = useCopy();
  const sections = elementChildren(children);
  const header = sections.find((section) => section.type === "thead");
  const body = sections.find((section) => section.type === "tbody");
  const headerRow = header ? elementChildren(header.props.children)[0] : undefined;
  const headers = headerRow ? elementChildren(headerRow.props.children) : [];
  const rows = body ? elementChildren(body.props.children) : [];
  const astHeader = node?.children?.find((child) => child.tagName === "thead")?.children?.find((child) => child.tagName === "tr");
  const labels = (astHeader?.children ?? []).filter((child) => child.tagName === "th").map(plainText);
  const astRows = node?.children?.find((child) => child.tagName === "tbody")?.children?.filter((child) => child.tagName === "tr") ?? [];
  const values = astRows.map((row) => (row.children ?? []).filter((child) => child.tagName === "td").map(plainText));
  const data: TableData = { headers, rows, labels, values };
  const order = rows.map((_, index) => index);
  if (sort) order.sort((a, b) => (sort.direction === "ascending" ? 1 : -1) * compareTableValues(values[a]?.[sort.column] ?? "", values[b]?.[sort.column] ?? "") || a - b);
  function toggleSort(column: number) {
    setSort((current) => current?.column === column ? current.direction === "ascending" ? { column, direction: "descending" } : null : { column, direction: "ascending" });
  }
  function download() {
    const url = URL.createObjectURL(new Blob(["\uFEFF", tableToCsv([labels, ...order.map((index) => values[index] ?? [])])], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "vision-table.csv";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <section aria-label="Table output" className="content-block not-prose my-3 w-full min-w-0 max-w-full">
      <div className="content-block-frame relative flex max-h-[100cqw] flex-col overflow-hidden rounded-lg border border-border bg-background text-foreground">
        <header className="content-block-header relative z-10 flex h-11 shrink-0 items-center gap-1 border-b border-border px-2">
          <span className="flex min-w-0 flex-1 items-center gap-2 truncate px-2 font-mono text-xs font-medium" title={`Table · ${rows.length} rows · ${headers.length} columns`}><Table2 className="size-4 shrink-0" aria-hidden="true" />Table</span>
          <Button variant="ghost" size="icon" className="size-9 shrink-0 rounded-full md:size-8 md:rounded-md" aria-label={copied ? "Table copied" : "Copy table Markdown"} title={copied ? "Copied" : "Copy table Markdown"} onClick={() => copy(markdown)}>{copied ? <Check /> : <Copy />}</Button>
          <Button variant="ghost" size="icon" className="size-9 shrink-0 rounded-full md:size-8 md:rounded-md" aria-label="Download table CSV" title="Download table CSV" onClick={download}><Download /></Button>
          <Button variant="ghost" size="icon" className="size-9 shrink-0 rounded-full md:size-8 md:rounded-md" aria-label="Open table full screen" title="Open full screen" onClick={() => setOpen(true)}><Expand /></Button>
        </header>
        <div role="region" aria-label="Scrollable table" tabIndex={0} className="min-h-0 min-w-0 flex-1 overflow-auto overscroll-contain focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset">
          <TableGrid data={data} sort={sort} onSort={toggleSort} />
        </div>
      </div>
      {open && <Dialog open onOpenChange={(value) => { if (!value) setOpen(false); }}><DialogPortal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[9999] bg-background" />
        <DialogPrimitive.Content aria-describedby={undefined} className="fixed inset-0 z-[10000] flex h-dvh min-w-0 flex-col bg-background text-foreground outline-none pb-[env(safe-area-inset-bottom)]">
          <header className="flex min-h-14 shrink-0 items-center gap-1 border-b border-border px-2 pt-[env(safe-area-inset-top)]">
            <Button variant="ghost" size="icon" className="shrink-0 rounded-full md:rounded-md" onClick={() => setOpen(false)} aria-label="Back to chat" title="Back to chat"><ArrowLeft /></Button>
            <DialogTitle className="min-w-0 flex-1 truncate px-1 font-mono text-sm font-medium">Table</DialogTitle>
            <div className="flex shrink-0 gap-1">
              <Button variant="ghost" size="icon" className="rounded-full md:rounded-md" onClick={download} aria-label="Download table CSV" title="Download table CSV"><Download /></Button>
              <Button variant="ghost" size="icon" className="rounded-full md:rounded-md" onClick={() => copy(markdown)} aria-label={copied ? "Copied" : "Copy table Markdown"} title={copied ? "Copied" : "Copy table Markdown"}>{copied ? <Check /> : <Copy />}</Button>
            </div>
          </header>
          <div role="region" aria-label="Scrollable table" tabIndex={0} className="min-h-0 min-w-0 flex-1 overflow-auto overscroll-contain focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset">
            <TableGrid data={data} sort={sort} onSort={toggleSort} full />
          </div>
        </DialogPrimitive.Content>
      </DialogPortal></Dialog>}
    </section>
  );
}
