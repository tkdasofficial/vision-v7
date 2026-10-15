import { useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import CodeBlock from "@/components/chat/code-block";
import { markdownToPlainText } from "@/lib/markdown-plain";

/** A copy-ready deliverable: rendered Markdown (no raw markers) with one Copy for the whole content. */
export default function CopyReadyBox({ markdown, label = "Markdown", renderCode }: { markdown: string; label?: string; renderCode?: (code: string, language: string) => React.ReactNode }) {
  const body = useRef<HTMLDivElement>(null);
  const plain = markdownToPlainText(markdown);
  return (
    <CodeBlock code={markdown} language="markdown" label={label} regionLabel={`${label} copy box`} copyText={plain} copyHtml={() => body.current?.innerHTML}>
      <div ref={body} className="max-w-none break-words p-4 text-sm leading-relaxed text-foreground [overflow-wrap:anywhere]">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={renderCode ? { pre: ({ children }) => { const c: any = Array.isArray(children) ? children[0] : children; const lang = String(c?.props?.className ?? "").replace(/^language-/, ""); return <>{renderCode(String(c?.props?.children ?? "").replace(/\n$/, ""), lang)}</>; } } : undefined}>{markdown}</ReactMarkdown>
      </div>
    </CodeBlock>
  );
}
