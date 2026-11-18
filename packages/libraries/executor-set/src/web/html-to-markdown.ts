/**
 * The page a local fetch got, as Markdown for a model (ExecutorSet 5d): headings, paragraphs,
 * lists, links with absolute addresses, fenced code, tables and quotes are kept, what is not
 * content (scripts, styles, navigation, forms, frames) is dropped. No dependency, and no attempt
 * to be a browser: the text is what a reader of the page sees, in the order it comes.
 */
interface ElementNode {
  readonly tag: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: Node[];
}
type Node = ElementNode | string;

const VOID = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'wbr', 'source', 'area', 'col']);
const DROPPED = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'nav',
  'header',
  'footer',
  'aside',
  'form',
  'svg',
  'iframe',
  'button',
  'select',
  'head',
]);
const BLOCKS = new Set([
  'p',
  'div',
  'section',
  'article',
  'main',
  'details',
  'summary',
  'figure',
  'figcaption',
  'dl',
  'dt',
  'dd',
  'address',
  'body',
  'html',
]);

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  copy: '©',
  rarr: '→',
  larr: '←',
};

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (whole, name: string) => {
    if (name.startsWith('#')) {
      const code =
        name[1]?.toLowerCase() === 'x' ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
      return Number.isInteger(code) && code > 0 && code < 0x110000
        ? String.fromCodePoint(code)
        : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

function attributesOf(source: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const match of source.matchAll(
    /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/gu,
  )) {
    const name = match[1]?.toLowerCase();
    if (name !== undefined) found[name] = decode(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return found;
}

function parse(html: string): ElementNode {
  const root: ElementNode = { tag: '#root', attributes: {}, children: [] };
  const stack: ElementNode[] = [root];
  const top = () => stack[stack.length - 1] ?? root;
  const token =
    /<!--[\s\S]*?-->|<!(?:doctype)[^>]*>|<\/([a-zA-Z][a-zA-Z0-9-]*)\s*>|<([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^'">])*?)(\/?)>|[^<]+|</giu;
  let raw: string | undefined;
  for (const match of html.matchAll(token)) {
    const [text, close, open, attributes, selfClosing] = match;
    // The body of a script or a style is not markup.
    if (raw !== undefined) {
      if (close?.toLowerCase() === raw) {
        raw = undefined;
        stack.pop();
      }
      continue;
    }
    if (close !== undefined) {
      const name = close.toLowerCase();
      const at = stack.map((node) => node.tag).lastIndexOf(name);
      if (at > 0) stack.length = at;
    } else if (open !== undefined) {
      const tag = open.toLowerCase();
      const element: ElementNode = {
        tag,
        attributes: attributesOf(attributes ?? ''),
        children: [],
      };
      top().children.push(element);
      if (VOID.has(tag) || selfClosing === '/') continue;
      stack.push(element);
      if (tag === 'script' || tag === 'style') raw = tag;
    } else if (!text.startsWith('<!')) top().children.push(text);
  }
  return root;
}

const squash = (text: string): string => decode(text).replace(/\s+/gu, ' ');

function plainText(node: Node): string {
  return typeof node === 'string'
    ? decode(node)
    : DROPPED.has(node.tag)
      ? ''
      : node.children.map(plainText).join('');
}

function absolute(href: string | undefined, base: URL | undefined): string | undefined {
  if (href === undefined || /^(javascript:|mailto:|tel:|#)/iu.test(href)) return undefined;
  try {
    return new URL(href, base).href;
  } catch {
    return undefined;
  }
}

function languageOf(node: ElementNode): string {
  const code = node.children.find(
    (child): child is ElementNode => typeof child !== 'string' && child.tag === 'code',
  );
  const classes = `${node.attributes['class'] ?? ''} ${code?.attributes['class'] ?? ''}`;
  return /(?:language|lang)-([a-z0-9+#-]+)/iu.exec(classes)?.[1]?.toLowerCase() ?? '';
}

class Writer {
  readonly #parts: string[] = [];
  /** How much was written, and how many line breaks end it: kept as it goes, never recounted. */
  #length = 0;
  #trailing = 0;
  base: URL | undefined;

  text(value: string): void {
    if (value === '') return;
    this.#parts.push(value);
    this.#length += value.length;
    let ending = 0;
    while (ending < value.length && value[value.length - 1 - ending] === '\n') ending += 1;
    this.#trailing = ending === value.length ? this.#trailing + ending : ending;
  }

  /** At least `lines` line breaks since the last text, so blocks do not run together. */
  break(lines: number): void {
    if (this.#length === 0 || this.#trailing >= lines) return;
    this.text('\n'.repeat(lines - this.#trailing));
  }

  result(): string {
    return this.#parts
      .join('')
      .replace(/[ \t]+\n/gu, '\n')
      .replace(/\n{3,}/gu, '\n\n')
      .trim();
  }
}

function inline(node: Node, out: Writer, quote: boolean): void {
  render(node, out, { list: [], quote });
}

interface Context {
  /** `ul` for a bullet list, a number for the next item of an ordered one; innermost last. */
  readonly list: readonly ('ul' | number)[];
  readonly quote: boolean;
}

function render(node: Node, out: Writer, context: Context): void {
  if (typeof node === 'string') {
    const text = squash(node);
    if (text.trim() === '' && !text.startsWith(' ')) return;
    out.text(text);
    return;
  }
  const { tag } = node;
  if (DROPPED.has(tag)) return;
  const children = () => {
    for (const child of node.children) render(child, out, context);
  };
  if (/^h[1-6]$/u.test(tag)) {
    out.break(2);
    out.text(`${'#'.repeat(Number(tag[1]))} ${squash(plainText(node)).trim()}`);
    out.break(2);
    return;
  }
  switch (tag) {
    case 'br':
      out.text('\n');
      return;
    case 'hr':
      out.break(2);
      out.text('---');
      out.break(2);
      return;
    case 'img': {
      const alt = squash(node.attributes['alt'] ?? '').trim();
      if (alt !== '') out.text(alt);
      return;
    }
    case 'a': {
      const target = absolute(node.attributes['href'], out.base);
      const label = squash(plainText(node)).trim();
      if (label === '') return;
      out.text(target === undefined ? label : `[${label}](${target})`);
      return;
    }
    case 'code':
    case 'kbd':
    case 'samp': {
      const text = plainText(node).replace(/\s+/gu, ' ').trim();
      if (text !== '') out.text(`\`${text}\``);
      return;
    }
    case 'strong':
    case 'b': {
      const text = squash(plainText(node)).trim();
      if (text !== '') out.text(`**${text}**`);
      return;
    }
    case 'em':
    case 'i': {
      const text = squash(plainText(node)).trim();
      if (text !== '') out.text(`*${text}*`);
      return;
    }
    case 'pre': {
      out.break(2);
      const code = plainText(node).replace(/\n$/u, '');
      out.text(`\`\`\`${languageOf(node)}\n${code}\n\`\`\``);
      out.break(2);
      return;
    }
    case 'blockquote': {
      const inner = new Writer();
      inner.base = out.base;
      for (const child of node.children) render(child, inner, context);
      out.break(2);
      out.text(
        inner
          .result()
          .split('\n')
          .map((line) => `> ${line}`.trimEnd())
          .join('\n'),
      );
      out.break(2);
      return;
    }
    case 'ul':
    case 'ol': {
      out.break(2);
      let number = 1;
      for (const child of node.children) {
        if (typeof child === 'string' || child.tag !== 'li') {
          render(child, out, context);
          continue;
        }
        const indent = '  '.repeat(context.list.length);
        const bullet = tag === 'ol' ? `${String(number)}.` : '-';
        number += 1;
        out.break(1);
        out.text(`${indent}${bullet} `);
        const item = new Writer();
        item.base = out.base;
        for (const part of child.children)
          render(part, item, {
            list: [...context.list, tag === 'ol' ? number : 'ul'],
            quote: context.quote,
          });
        out.text(
          item
            .result()
            .replace(/\n{2,}/gu, '\n')
            .replace(/\n(?=\S)/gu, `\n${indent}  `),
        );
      }
      out.break(2);
      return;
    }
    case 'table': {
      out.break(2);
      const rows: string[][] = [];
      let headed = false;
      const collect = (parent: ElementNode): void => {
        for (const child of parent.children) {
          if (typeof child === 'string') continue;
          if (child.tag === 'tr') {
            const cells = child.children.filter(
              (cell): cell is ElementNode =>
                typeof cell !== 'string' && (cell.tag === 'td' || cell.tag === 'th'),
            );
            if (rows.length === 0 && cells.some((cell) => cell.tag === 'th')) headed = true;
            rows.push(cells.map((cell) => squash(plainText(cell)).trim().replace(/\|/gu, '\\|')));
          } else collect(child);
        }
      };
      collect(node);
      const width = Math.max(0, ...rows.map((row) => row.length));
      const lines = rows
        .filter((row) => row.length > 0)
        .map((row) => `| ${[...row, ...Array<string>(width - row.length).fill('')].join(' | ')} |`);
      if (lines.length > 0) {
        const head = headed ? lines[0] : `| ${Array<string>(width).fill('').join(' | ')} |`;
        const body = headed ? lines.slice(1) : lines;
        out.text([head, `| ${Array<string>(width).fill('---').join(' | ')} |`, ...body].join('\n'));
      }
      out.break(2);
      return;
    }
    default:
  }
  if (BLOCKS.has(tag)) {
    out.break(2);
    children();
    out.break(2);
    return;
  }
  if (tag === 'li' || tag === 'tr') {
    out.break(1);
    children();
    out.break(1);
    return;
  }
  children();
}

/** The part of the page that is its content: `main` or `article` when there is one. */
function contentOf(root: ElementNode): ElementNode {
  const find = (node: ElementNode, tag: string): ElementNode | undefined => {
    for (const child of node.children) {
      if (typeof child === 'string') continue;
      if (child.tag === tag) return child;
      const deeper = find(child, tag);
      if (deeper !== undefined) return deeper;
    }
    return undefined;
  };
  return find(root, 'main') ?? find(root, 'article') ?? root;
}

export interface Converted {
  readonly title: string;
  readonly markdown: string;
}

/** `base` resolves the relative links of the page into absolute ones. */
export function htmlToMarkdown(html: string, base?: URL): Converted {
  const root = parse(html);
  const titleNode = (function find(node: ElementNode): ElementNode | undefined {
    for (const child of node.children) {
      if (typeof child === 'string') continue;
      if (child.tag === 'title') return child;
      const deeper = find(child);
      if (deeper !== undefined) return deeper;
    }
    return undefined;
  })(root);
  const out = new Writer();
  out.base = base;
  inline(contentOf(root), out, false);
  return {
    title: titleNode === undefined ? '' : squash(plainText(titleNode)).trim(),
    markdown: out.result(),
  };
}
