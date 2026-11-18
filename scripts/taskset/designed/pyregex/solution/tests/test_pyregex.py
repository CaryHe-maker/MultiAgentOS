import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import pyregex as R  # noqa: E402

CASES = [
    ("abc", "xabcx", (1, 4)), ("a+", "baaa", (1, 4)), ("a*?", "aaa", (0, 0)), (r"\d+", "ab123", (2, 5)), ("^a", "ba", None),
    ("a$", "ba", (1, 2)), ("[a-c]+", "xxbca", (2, 5)), ("(a)(b)", "ab", (0, 2)), ("a{2}", "aaa", (0, 2)), ("a|b", "cb", (1, 2)),
    (r"\bx", "a x", (2, 3)), ("(?i)A", "a", (0, 1)), ("(?=b)", "ab", (1, 1)), ("(?<=a)b", "ab", (1, 2)), ("x?", "y", (0, 0)),
    (r"(\w)\1", "abb", (1, 3)), ("[^a]", "ab", (1, 2)), (".", "\n", None), ("(?s).", "\n", (0, 1)), ("a.c", "abc", (0, 3)),
]


class Cases(unittest.TestCase):
    pass


def _case(pattern, text, span):
    def test(self):
        m = R.search(pattern, text)
        self.assertEqual(m.span() if m else None, span)

    return test


for n, case in enumerate(CASES):
    setattr(Cases, f"test_search_{n:02d}", _case(*case))
    setattr(Cases, f"test_search_{n:02d}_compiled", _case(*case))

if __name__ == "__main__":
    unittest.main()
