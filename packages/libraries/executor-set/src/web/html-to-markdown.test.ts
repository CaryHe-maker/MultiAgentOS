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

  it('survives broken markup and gives nothing for an empty page', () => {
    expect(htmlToMarkdown('<p>one<p>two</div></span><b>bold').markdown).toBe('one\n\ntwo**bold**');
    expect(htmlToMarkdown('').markdown).toBe('');
    expect(htmlToMarkdown('<<<>>> & < 3').markdown).toContain('3');
  });
});
