import os
import subprocess
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CASES = [
    ("# a", "<h1>a</h1>\n"), ("## b", "<h2>b</h2>\n"), ("*x*", "<p><em>x</em></p>\n"),
    ("**x**", "<p><strong>x</strong></p>\n"), ("`c`", "<p><code>c</code></p>\n"), ("---", "<hr />\n"),
    ("> q", "<blockquote>\n<p>q</p>\n</blockquote>\n"), ("- a", "<ul>\n<li>a</li>\n</ul>\n"),
    ("1. a", "<ol>\n<li>a</li>\n</ol>\n"), ("[l](u)", '<p><a href="u">l</a></p>\n'),
    ("![i](s)", '<p><img src="s" alt="i" /></p>\n'), ("<http://a.b>", '<p><a href="http://a.b">http://a.b</a></p>\n'),
    ("a\\*b", "<p>a*b</p>\n"), ("&amp;", "<p>&amp;</p>\n"), ("    code", "<pre><code>code\n</code></pre>\n"),
    ("```\nx\n```", "<pre><code>x\n</code></pre>\n"), ("a  \nb", "<p>a<br />\nb</p>\n"), ("a\nb", "<p>a\nb</p>\n"),
    ("<div>\nx\n</div>", "<div>\nx\n</div>\n"), ("a\n===", "<h1>a</h1>\n"),
]


def render(text):
    return subprocess.run([sys.executable, "-m", "mdhtml"], cwd=ROOT, input=text, capture_output=True,
                          text=True).stdout


class Cases(unittest.TestCase):
    pass


def _case(md, html):
    def test(self):
        self.assertEqual(render(md), html)

    return test


for n, (md, html) in enumerate(CASES):
    setattr(Cases, f"test_case_{n:02d}", _case(md, html))
    setattr(Cases, f"test_case_{n:02d}_trailing_newline", _case(md + "\n", html))

if __name__ == "__main__":
    unittest.main()
