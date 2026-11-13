import os
import subprocess
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET

from mdsite.markdown import to_html


class HiddenMarkdownTest(unittest.TestCase):
    def test_spec_example(self):
        self.assertEqual(
            to_html("# Hi\n\nSome *very* **bold** `a<b` text\nwith [a link](https://x.org).\n\n- one\n- two"),
            '<h1>Hi</h1>\n<p>Some <em>very</em> <strong>bold</strong> <code>a&lt;b</code> text with '
            '<a href="https://x.org">a link</a>.</p>\n<ul><li>one</li><li>two</li></ul>',
        )

    def test_levels_and_escaping(self):
        self.assertEqual(to_html("### R&D <now>"), "<h3>R&amp;D &lt;now&gt;</h3>")
        self.assertEqual(to_html("###### six"), "<h6>six</h6>")

    def test_code_block_is_literal(self):
        self.assertEqual(
            to_html("```\nif a < b:\n    **not bold**\n```\n\nafter"),
            "<pre><code>if a &lt; b:\n    **not bold**</code></pre>\n<p>after</p>",
        )

    def test_inline_code_not_formatted(self):
        self.assertEqual(to_html("use `*x*` here"), "<p>use <code>*x*</code> here</p>")

    def test_paragraphs_split_by_blank_lines(self):
        self.assertEqual(to_html("  one\n two  \n\n\nthree"), "<p>one two</p>\n<p>three</p>")


POSTS = {
    "alpha.md": "---\ntitle: Alpha & Omega\ndate: 2026-05-05\ntags: Python, web\n---\n# Alpha\n\nbody *a*\n",
    "beta.md": "---\ntitle: Beta\ndate: 2026-06-01\ntags: python\n---\nbeta text\n",
    "gamma.md": "---\ntitle: Gamma\ndate: 2026-05-05\n---\ngamma\n",
    "hidden.md": "---\ntitle: Secret\ndate: 2026-07-01\ndraft: true\ntags: python\n---\nno\n",
}


def site(posts=POSTS, template=True):
    src = tempfile.mkdtemp()
    os.makedirs(os.path.join(src, "posts"))
    with open(os.path.join(src, "site.toml"), "w", encoding="utf8") as handle:
        handle.write('title = "My Site"\nbase_url = "https://example.org"\n')
    for name, text in posts.items():
        with open(os.path.join(src, "posts", name), "w", encoding="utf8") as handle:
            handle.write(text)
    if template:
        os.makedirs(os.path.join(src, "templates"))
        with open(os.path.join(src, "templates", "page.html"), "w", encoding="utf8") as handle:
            handle.write("<title>{{ title }} | {{ site_title }}</title><main>{{ content }}</main>")
    return src


def build(src, out):
    return subprocess.run([sys.executable, "-m", "mdsite", "build", src, out], capture_output=True, text=True)


def read(*parts):
    with open(os.path.join(*parts), encoding="utf8") as handle:
        return handle.read()


class HiddenSiteTest(unittest.TestCase):
    def setUp(self):
        self.out = os.path.join(tempfile.mkdtemp(), "out")
        os.makedirs(self.out)
        with open(os.path.join(self.out, "stale.html"), "w", encoding="utf8") as handle:
            handle.write("old")
        done = build(site(), self.out)
        self.assertEqual(done.returncode, 0, done.stderr)

    def test_post_pages(self):
        self.assertEqual(
            read(self.out, "posts", "alpha.html"),
            "<title>Alpha & Omega | My Site</title><main><h1>Alpha</h1>\n<p>body <em>a</em></p></main>",
        )
        self.assertFalse(os.path.exists(os.path.join(self.out, "posts", "hidden.html")))
        self.assertFalse(os.path.exists(os.path.join(self.out, "stale.html")))

    def test_index_order(self):
        index = read(self.out, "index.html")
        beta = index.index('<li><a href="posts/beta.html">Beta</a> <time>2026-06-01</time></li>')
        alpha = index.index('<a href="posts/alpha.html">')
        gamma = index.index('<li><a href="posts/gamma.html">Gamma</a> <time>2026-05-05</time></li>')
        self.assertLess(beta, alpha)
        self.assertLess(alpha, gamma)
        self.assertNotIn("Secret", index)

    def test_tags(self):
        python = read(self.out, "tags", "python.html")
        self.assertIn('<a href="../posts/beta.html">Beta</a>', python)
        self.assertIn('<a href="../posts/alpha.html">', python)
        self.assertNotIn("Secret", python)
        self.assertIn('<a href="../posts/alpha.html">', read(self.out, "tags", "web.html"))
        self.assertEqual(sorted(os.listdir(os.path.join(self.out, "tags"))), ["python.html", "web.html"])

    def test_feed(self):
        channel = ET.parse(os.path.join(self.out, "feed.xml")).getroot().find("channel")
        self.assertEqual(channel.find("title").text, "My Site")
        self.assertEqual(channel.find("link").text, "https://example.org")
        items = channel.findall("item")
        self.assertEqual([item.find("title").text for item in items], ["Beta", "Alpha & Omega", "Gamma"])
        self.assertEqual(items[1].find("link").text, "https://example.org/posts/alpha.html")
        self.assertEqual(items[1].find("pubDate").text, "Tue, 05 May 2026 00:00:00 +0000")


class HiddenErrorsTest(unittest.TestCase):
    def test_bad_front_matter_writes_nothing(self):
        for broken in ("---\ndate: 2026-01-01\n---\nno title\n", "---\ntitle: X\ndate: 2026-13-01\n---\n"):
            out = os.path.join(tempfile.mkdtemp(), "out")
            posts = dict(POSTS, **{"broken.md": broken})
            done = build(site(posts), out)
            self.assertEqual(done.returncode, 1)
            self.assertIn("broken.md", done.stderr)
            self.assertFalse(os.path.exists(out) and os.listdir(out))

    def test_default_template(self):
        out = os.path.join(tempfile.mkdtemp(), "out")
        self.assertEqual(build(site(template=False), out).returncode, 0)
        page = read(out, "posts", "beta.html")
        self.assertIn("<p>beta text</p>", page)
        self.assertIn("Beta", page)
        self.assertIn("My Site", page)

    def test_feed_keeps_twenty(self):
        posts = {f"p{n:02d}.md": f"---\ntitle: P{n}\ndate: 2026-01-{n:02d}\n---\nx\n" for n in range(1, 26)}
        out = os.path.join(tempfile.mkdtemp(), "out")
        self.assertEqual(build(site(posts), out).returncode, 0)
        items = ET.parse(os.path.join(out, "feed.xml")).getroot().find("channel").findall("item")
        self.assertEqual(len(items), 20)
        self.assertEqual(items[0].find("title").text, "P25")


if __name__ == "__main__":
    unittest.main()
