import { Children, isValidElement, useMemo, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import CodeBlock from "@/components/chat/code-block";
import TextCopyBox from "@/components/chat/text-copy-box";
import CopyReadyBox from "@/components/chat/copy-ready-box";
import TableReply from "@/components/chat/table-reply";
import { dedupeDeliverables } from "@/lib/markdown-plain";

// "markdown" fences are copy-ready deliverables (rendered); text/prompt/untagged fences stay literal.
const rawLanguages = new Set(["", "text", "txt", "plain", "plaintext", "prompt"]);
const renderedLanguages = new Set(["markdown", "md"]);

const components: Components = {
  pre: ({ children, node }) => {
    const child = Children.toArray(children).find((item) => isValidElement(item));
    if (!isValidElement<{ children?: ReactNode; className?: string }>(child)) return <pre>{children}</pre>;
    const language = child.props.className?.replace(/^language-/, "").toLowerCase() || "";
    const text = String(child.props.children ?? "").replace(/\n$/, "");
    if (renderedLanguages.has(language)) return <CopyReadyBox markdown={text} renderCode={(code, lang) => rawLanguages.has(lang) ? <TextCopyBox text={code} label="Text" /> : <CodeBlock code={code} language={lang} />} />;
    if (rawLanguages.has(language)) return <TextCopyBox text={text} label={language === "prompt" ? "Prompt" : "Text"} />;
    const codeNode = node?.children.find((item) => item.type === "element" && item.tagName === "code");
    const data = codeNode?.data;
    const meta = data && "meta" in data ? String(data.meta ?? "") : "";
    return <CodeBlock code={text} language={language} filename={meta.match(/title="([^"]+)"/)?.[1]} />;
  },
  code: ({ children, className }) => <code className={className}>{children}</code>,
};

export default function MarkdownReply({ children }: { children: string }) {
  const source = useMemo(() => dedupeDeliverables(children), [children]);
  return <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ ...components, table: ({ children: tableChildren, node }) => <TableReply node={node} markdown={source.slice(node?.position?.start.offset ?? 0, node?.position?.end.offset ?? source.length)}>{tableChildren}</TableReply> }}>{source}</ReactMarkdown>;
}
