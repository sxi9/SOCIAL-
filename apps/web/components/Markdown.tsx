// Wave 1 (AUDIT-PLAN §1.1): a deliberately tiny markdown renderer for the
// operator-editable legal pages — headings, paragraphs, bullet lists, bold,
// italics, inline code and http(s) links. No raw HTML ever reaches the DOM
// (every text run is a React string), no dependency (rule 10). Server-safe.
import type { ReactNode } from 'react';

type Block =
  | { kind: 'h'; level: 1 | 2 | 3; text: string }
  | { kind: 'p'; text: string }
  | { kind: 'ul'; items: string[] };

function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];
  let list: string[] | null = null;
  const flush = (): void => {
    if (para.length) {
      blocks.push({ kind: 'p', text: para.join(' ') });
      para = [];
    }
    if (list) {
      blocks.push({ kind: 'ul', items: list });
      list = null;
    }
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      blocks.push({ kind: 'h', level: h[1]!.length as 1 | 2 | 3, text: h[2]! });
      continue;
    }
    const li = /^\s*[-*]\s+(.*)$/.exec(line);
    if (li) {
      if (para.length) {
        blocks.push({ kind: 'p', text: para.join(' ') });
        para = [];
      }
      (list ??= []).push(li[1]!);
      continue;
    }
    if (line.trim() === '') {
      flush();
      continue;
    }
    if (list) {
      blocks.push({ kind: 'ul', items: list });
      list = null;
    }
    para.push(line.trim());
  }
  flush();
  return blocks;
}

const SAFE_HREF = /^https?:\/\/[^\s)]+$/i;

/** Inline: `code`, **bold**, *italic*, [text](https://…). Left to right, one
 * pass; anything unmatched is literal text. */
function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const k = `${keyBase}-${i++}`;
    if (tok.startsWith('`')) out.push(<code key={k}>{tok.slice(1, -1)}</code>);
    else if (tok.startsWith('**')) out.push(<strong key={k}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith('*')) out.push(<em key={k}>{tok.slice(1, -1)}</em>);
    else {
      const lm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok)!;
      const href = lm[2]!.trim();
      if (SAFE_HREF.test(href)) {
        out.push(
          <a key={k} href={href} rel="noopener noreferrer" target="_blank">
            {lm[1]}
          </a>,
        );
      } else {
        out.push(lm[1]);
      }
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export default function Markdown({ source, className }: { source: string; className?: string }) {
  const blocks = parseBlocks(source);
  return (
    <div className={className}>
      {blocks.map((b, i) => {
        const key = `b${i}`;
        if (b.kind === 'h') {
          const Tag = (`h${b.level}` as 'h1' | 'h2' | 'h3');
          return <Tag key={key}>{inline(b.text, key)}</Tag>;
        }
        if (b.kind === 'ul') {
          return (
            <ul key={key}>
              {b.items.map((it, j) => (
                <li key={`${key}-${j}`}>{inline(it, `${key}-${j}`)}</li>
              ))}
            </ul>
          );
        }
        return <p key={key}>{inline(b.text, key)}</p>;
      })}
    </div>
  );
}
