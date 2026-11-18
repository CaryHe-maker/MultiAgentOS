import { describe, expect, it } from 'vitest';
import { htmlToMarkdown } from './html-to-markdown.js';

const page = (body: string, head = '') =>
  `<!doctype html><html><head><title>A &amp; B</title>${head}</head><body>${body}</body></html>`;
const base = new URL('https://example.com/docs/guide/');

describe('HTML as Markdown for a model', () => {
  it('keeps the title, the headings and the paragraphs, and decodes entities', () => {
    const { title, markdown } = htmlToMarkdown(
      page(
        '<h1>Guide</h1><p>One &amp; two &lt;3 &#x41;.</p><h2>Part  <em>two</em></h2><p>Next.</p>',
      ),
    );
    expect(title).toBe('A & B');
    expect(markdown).toBe('# Guide\n\nOne & two <3 A.\n\n## Part two\n\nNext.');
  });

  it('keeps links as absolute addresses and drops those that lead nowhere', () => {
    const { markdown } = htmlToMarkdown(
      page(
        '<p>See <a href="../api">the API</a>, <a href="/x?y=1">x</a>, <a href="#top">top</a> and <a href="javascript:void(0)">no</a>.</p>',
      ),
      base,
    );
    expect(markdown).toBe(
      'See [the API](https://example.com/docs/api), [x](https://example.com/x?y=1), top and no.',
    );
  });

  it('keeps code in fences, with the language, and inline code in backticks', () => {
    const { markdown } = htmlToMarkdown(
      page(
        '<p>Call <code>fs.readFile()</code> like this:</p><pre><code class="language-js">const a = 1;\nif (a &lt; 2) {\n  go();\n}\n</code></pre>',
      ),
    );
    expect(markdown).toBe(
      'Call `fs.readFile()` like this:\n\n```js\nconst a = 1;\nif (a < 2) {\n  go();\n}\n```',
    );
  });

  it('keeps lists, ordered and nested', () => {
    const { markdown } = htmlToMarkdown(
      page(
        '<ul><li>a</li><li>b<ul><li>b1</li></ul></li></ul><ol><li>first</li><li>second</li></ol>',
      ),
    );
    expect(markdown).toBe('- a\n- b\n  - b1\n\n1. first\n2. second');
  });

  it('keeps tables, with the header row when there is one', () => {
    const { markdown } = htmlToMarkdown(
      page(
        '<table><tr><th>Name</th><th>Type</th></tr><tr><td>id</td><td>number | null</td></tr></table>',
      ),
    );
    expect(markdown).toBe('| Name | Type |\n| --- | --- |\n| id | number \\| null |');
  });

  it('keeps quotes and the alt text of an image', () => {
    const { markdown } = htmlToMarkdown(
      page('<blockquote><p>Quoted.</p></blockquote><p><img src="a.png" alt="a diagram"></p>'),
    );
    expect(markdown).toBe('> Quoted.\n\na diagram');
  });

  it('drops what is not content: scripts, styles, navigation, forms, frames', () => {
    const { markdown } = htmlToMarkdown(
      page(
        '<nav><a href="/">Home</a></nav><script>var x = "<p>no</p>";</script><style>p { color: red }</style><form><input></form><iframe src="x"></iframe><footer>(c)</footer><p>Only this.</p>',
        '<script>alert(1)</script>',
      ),
    );
    expect(markdown).toBe('Only this.');
  });

  it('takes the main content when the page has one', () => {
    const { markdown } = htmlToMarkdown(
      page('<div>sidebar words</div><main><h1>Real</h1><p>Body.</p></main><div>more sidebar</div>'),
    );
    expect(markdown).toBe('# Real\n\nBody.');
  });

  it('takes time in proportion to the size of the page, because it runs on the one thread of the program', () => {
    // A page of many blocks: the conversion once recounted everything written at every block, so
    // 400 KB took twelve seconds and a page of the largest size the fetch allows took minutes,
    // while nothing else in the process (the other fetches, the models, the screen) could run.
    const row =
      '<div class="item"><a href="/school/1.html">学校名称</a><p>2024 年 理科 招生计划 <b>120</b></p><ul><li>一</li><li>二</li></ul></div>\n';
    const html = page(row.repeat(Math.ceil((2 * 1024 * 1024) / row.length)));
    const started = performance.now();
    const { markdown } = htmlToMarkdown(html);
    expect(performance.now() - started).toBeLessThan(3000);
    expect(markdown.length).toBeGreaterThan(500_000);
  });

  it('writes the line breaks between blocks exactly once, however the blocks follow each other', () => {
    expect(htmlToMarkdown('<p>a</p><p></p><p></p><p>b</p>').markdown).toBe('a\n\nb');
    expect(htmlToMarkdown('<p>a</p>\n\n\n<p>b</p>').markdown).toBe('a\n\nb');
    expect(htmlToMarkdown('<ul><li>a</li></ul><ul><li>b</li></ul>').markdown).toContain('a');
  });

  it('survives broken markup and gives nothing for an empty page', () => {
    expect(htmlToMarkdown('<p>one<p>two</div></span><b>bold').markdown).toBe('one\n\ntwo**bold**');
    expect(htmlToMarkdown('').markdown).toBe('');
    expect(htmlToMarkdown('<<<>>> & < 3').markdown).toContain('3');
  });
});
