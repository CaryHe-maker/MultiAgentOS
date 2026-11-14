"""Expressions of the pyregex task. build_cases.py evaluates each with R = re (Python 3.12) and records
repr(result); the hidden tests evaluate the same expression with R = pyregex. M(m) turns a match into
plain data; an R.error becomes "error" and any other exception its type name."""

S = "The year 1999 and 2024; emails: ann@x.com, Bob.B@y.org! tel +64-21-555 0199. café ÉTÉ straße"
G = [
    # literals, dot, anchors
    "M(R.search('abc', 'xxabcxx'))", "M(R.match('abc', 'xxabc'))", "M(R.fullmatch('a.c', 'abc'))",
    "M(R.fullmatch('a.c', 'a\\nc'))", "M(R.fullmatch('a.c', 'a\\nc', R.S))", "M(R.search('^b', 'a\\nb'))",
    "M(R.search('^b', 'a\\nb', R.M))", "M(R.search('a$', 'a\\n'))", "M(R.search('a\\\\Z', 'a\\n'))",
    "M(R.search('\\\\Aa', 'ba'))", "R.findall('$', 'a\\nb\\n')", "R.findall('^', 'a\\nb\\n', R.M)",
    "R.findall('$', 'a\\nb\\n', R.M)", "M(R.search('\\\\bcat\\\\b', 'concat cat'))", "R.findall('\\\\B..', 'abc def')",
    "M(R.search('x*', 'aaa'))", "M(R.match('', 'abc'))",
    # escapes
    "M(R.search('\\\\x41\\\\u00e9\\\\U0001F600', 'A\\u00e9\\U0001F600'))", "M(R.search('\\\\t\\\\n\\\\r\\\\f\\\\v\\\\a', '\\t\\n\\r\\f\\v\\a'))",
    "M(R.search('\\\\101\\\\0', 'A\\x00'))", "M(R.search('\\\\N{LATIN SMALL LETTER E WITH ACUTE}', 'caf\\u00e9'))",
    "M(R.search('\\\\.\\\\*\\\\+\\\\?\\\\(\\\\)\\\\[\\\\]\\\\{\\\\}\\\\|\\\\^\\\\$\\\\\\\\', '.*+?()[]{}|^$\\\\'))",
    "R.escape('a.b*c d-é\\n')", "R.escape('_09azAZ')",
    # character classes
    "R.findall('[a-c]', 'abcd')", "R.findall('[^a-c]', 'abcd')", "R.findall('[]a]', ']a]')", "R.findall('[a\\\\]]', 'a]b')",
    "R.findall('[-a]', '-ab')", "R.findall('[a-]', '-ab')", "R.findall('[\\\\d.]', '1.2x')", "R.findall('[^\\\\W\\\\d]', 'a1_b2')",
    "R.findall('\\\\d+', '12 \\u0663\\u0664 ab')", "R.findall('\\\\d+', '12 \\u0663\\u0664 ab', R.A)", "R.findall('\\\\w+', S)",
    "R.findall('\\\\w+', S, R.A)", "R.findall('\\\\s', 'a\\tb\\u00a0c\\u2003d')", "R.findall('\\\\S+', ' a b\\n')",
    "R.findall('[\\\\s\\\\S]', 'ab')", "R.findall('[a-z]', 'ABC', R.I)", "R.findall('[^a-z]', 'aBc1', R.I)",
    "R.findall('[\\\\u00e0-\\\\u00ff]', 'caf\\u00e9 na\\u00efve')", "R.findall('[\\\\x00-\\\\x1f]', 'a\\x01b\\x1f')",
    # quantifiers
    "R.findall('a*', 'baaac')", "R.findall('a+', 'baaac aa')", "R.findall('a?', 'aba')", "R.findall('a{2}', 'aaaaa')",
    "R.findall('a{2,}', 'a aa aaa')", "R.findall('a{,2}', 'aaa')", "R.findall('a{1,2}', 'aaaaa')", "R.findall('a{2,3}?', 'aaaa')",
    "R.findall('a*?b', 'aab ab')", "M(R.search('<.*>', '<a><b>'))", "M(R.search('<.*?>', '<a><b>'))", "M(R.search('a{3', 'a{3'))",
    "M(R.search('x{2,1}', 'xx'))", "M(R.search('a++a', 'aaa'))", "M(R.search('a*+b', 'aaab'))", "M(R.search('(?:ab)?+a', 'aba'))",
    "M(R.search('a{1,3}+a', 'aaaa'))", "M(R.fullmatch('(a|ab)(c|bcd)(d*)', 'abcd'))",
    # groups
    "M(R.search('(a)(b)?(c)', 'ac'))", "M(R.search('(a)|(b)', 'b'))", "M(R.search('((a)(b))', 'ab'))",
    "M(R.search('(?:a)(b)', 'ab'))", "M(R.search('(?P<x>a)(?P<y>b)?', 'a'))", "M(R.search('(a)*', 'aaa'))",
    "M(R.search('(a|b)*', 'abba'))", "M(R.search('(a*)*', 'b'))", "M(R.search('(a*)+', 'b'))", "M(R.search('(a|)+', 'aa'))",
    "R.compile('(a)(?P<n>b)(?:c)').groups", "R.compile('(a)(?P<n>b)(?P<m>c)').groupindex", "R.compile('x', R.I | R.M).flags",
    "R.compile('x').flags", "R.compile(b'x').flags", "R.compile('(?i)x').pattern",
    # backreferences
    "M(R.search('(\\\\w)\\\\1', 'abccd'))", "M(R.search('(?P<q>[\\'\"]).*?(?P=q)', 'say \"hi\" \\'yo\\''))",
    "M(R.search('(a)\\\\1', 'aA', R.I))", "M(R.search('(a)?b\\\\1', 'b'))", "M(R.search('(\\\\d+)-\\\\1', '12-12 3-4'))",
    "M(R.search('\\\\1(a)', 'aa'))",
    # lookaround, atomic, conditional
    "R.findall('\\\\w+(?=,)', 'a, b, c')", "R.findall('\\\\w+(?!,)\\\\b', 'a, b, c')", "R.findall('(?<=\\\\$)\\\\d+', '$10 20 $30')",
    "R.findall('(?<!\\\\$)\\\\b\\\\d+', '$10 20 $30')", "M(R.search('(?<=ab|cd)x', 'cdx'))", "M(R.search('(?<=a.c)d', 'abcd'))",
    "M(R.search('(?<=a+)b', 'aab'))", "M(R.search('(?>a+)a', 'aaa'))", "M(R.search('(?>ab|a)c', 'ac'))",
    "M(R.search('(<)?\\\\w+(?(1)>|$)', '<abc>'))", "M(R.search('(<)?\\\\w+(?(1)>|$)', 'abc'))",
    "M(R.search('(?P<o>\\\\()?x(?(o)\\\\))', '(x)'))", "M(R.search('(a)?(?(1)b|c)', 'c'))", "M(R.search('(?=(\\\\w+))\\\\w', 'abc'))",
    # flags
    "R.findall('(?i)abc', 'ABC aBc')", "R.findall('(?i:a)b', 'Ab AB ab')", "R.findall('(?i)a(?-i:b)', 'AB Ab ab')",
    "M(R.search('(?s:.)', '\\n'))", "M(R.search('(?m)^b', 'a\\nb'))", "R.findall('(?a)\\\\w+', 'caf\\u00e9')",
    "M(R.search('a b # comment\\n c', 'abc', R.X))", "M(R.search('a\\\\ b [ ] c', 'a b  c', R.X))", "M(R.search('(?x) a [#] b', 'a#b'))",
    "M(R.search('\\u00df', 'SS', R.I))", "M(R.search('\\u0131', 'I', R.I))", "M(R.search('k', '\\u212a', R.I))",
    "M(R.search('[k]', '\\u212a', R.I))", "M(R.search('\\u00e9', '\\u00c9', R.I))", "M(R.search('st', '\\ufb06', R.I))",
    "M(R.search('(?#comment)a', 'a'))",
    # findall, finditer, split, sub
    "R.findall('(a)(b)', 'abab')", "R.findall('(a)b', 'abab')", "R.findall('(a)|b', 'ab')", "R.findall('', 'abc')",
    "R.findall('\\\\b', 'ab cd')", "[M(m) for m in R.finditer('\\\\d+', 'a1b22c333')]", "[M(m) for m in R.finditer('x*', 'axb')]",
    "R.split(',', 'a,b,,c')", "R.split('(,)', 'a,b')", "R.split(',', 'a,b,c', maxsplit=1)", "R.split('x*', 'axbc')",
    "R.split('\\\\b', 'ab cd')", "R.split('(?=b)', 'abab')", "R.split('(a)|b', 'xaybz')", "R.split('', 'abc')",
    "R.sub('a', 'b', 'aaa')", "R.sub('a', 'b', 'aaa', count=2)", "R.subn('a', 'b', 'aaa')", "R.sub('(\\\\w+) (\\\\w+)', '\\\\2 \\\\1', 'hello world x y')",
    "R.sub('(?P<w>\\\\w+)', '<\\\\g<w>|\\\\g<1>|\\\\g<0>>', 'ab cd')", "R.sub('x*', '-', 'abc')", "R.sub('', '-', 'abc')",
    "R.sub('a|', '-', 'bab')", "R.sub('(a)|b', '[\\\\1]', 'ab')", "R.sub('\\\\d', lambda m: str(int(m.group()) * 2), 'a1b5')",
    "R.sub('a', '\\\\n\\\\t\\\\\\\\', 'a')", "R.sub('a', lambda m: '\\\\1', 'a')", "R.sub('(a)', '\\\\g<1>0', 'a')",
    "R.sub('a', 'b', 'AaA', flags=R.I)", "R.sub('^', '>', 'a\\nb', flags=R.M)", "R.subn('(?m)$', '!', 'a\\nb\\n')",
    "R.sub('(\\\\d)', '\\\\2', '1')", "R.sub('a', '\\\\g<x>', 'a')", "R.sub('a', '\\\\q', 'a')",
    # Match object API
    "(lambda m: (m.group(), m.group(1), m.group(1, 2), m.group('n'), m[0], m['n'], m.start(2), m.end('n'), m.span(1)))"
    "(R.search('(a)(?P<n>b)', 'xab'))",
    "(lambda m: (m.groups(), m.groups('-'), m.groupdict(), m.groupdict(0), m.lastindex, m.lastgroup, m.start(2), m.span(2)))"
    "(R.search('(a)(?P<n>b)?', 'a'))",
    "(lambda m: (m.expand('\\\\2-\\\\1-\\\\g<n>'), m.string, m.pos, m.endpos, m.re.pattern))(R.search('(a)(?P<n>b)', 'xab'))",
    "(lambda m: (m.lastindex, m.lastgroup))(R.search('(?P<o>(?P<i>a))', 'a'))", "(lambda m: (m.lastindex, m.lastgroup))(R.search('(a)(b)', 'ab'))",
    "(lambda m: m.group(3))(R.search('(a)', 'a'))", "(lambda m: m.group('zz'))(R.search('(a)', 'a'))",
    # Pattern methods with pos and endpos
    "M(R.compile('a').search('aba', 1))", "M(R.compile('^a').search('ba', 1))", "M(R.compile('a$').search('ab', 0, 1))",
    "M(R.compile('\\\\bb').search('ab', 1))", "R.compile('\\\\w').findall('abcd', 1, 3)", "M(R.compile('b').match('ab', 1))",
    "M(R.compile('ab').fullmatch('xabx', 1, 3))", "R.compile('a').sub('b', 'aaa', 1)", "R.compile(',').split('a,b,c', 1)",
    "[M(m) for m in R.compile('\\\\w').finditer('abc', 1)]", "M(R.compile('a').search('a', -5, 99))",
    # bytes patterns
    "M(R.search(b'\\\\w+', b'ab cd'))", "R.findall(b'[a-c]', b'abcd')", "R.sub(b'a', b'b', b'aa')", "R.split(b',', b'a,b')",
    "M(R.search(b'(?i)\\\\xe9', b'\\\\xc9'.decode('unicode_escape').encode('latin-1')))",
    # errors
    "R.compile('(')", "R.compile(')')", "R.compile('[a')", "R.compile('a**')", "R.compile('?')", "R.compile('(?P<1>a)')",
    "R.compile('(?P<a>x)(?P<a>y)')", "R.compile('\\\\1')", "R.compile('(?<=a*)b')", "R.compile('[z-a]')", "R.compile('a{2,1}')",
    "R.compile('(?Q)')", "R.compile('\\\\')", "R.search('a', b'a')", "R.search(b'a', 'a')", "R.compile('(?i')",
    "E(lambda: R.compile('ab(c'))", "E(lambda: R.compile('x[a'))", "E(lambda: R.compile('a)b'))",
    "issubclass(R.error, Exception)",
    # longer realistic patterns
    "R.findall('[\\\\w.]+@\\\\w+\\\\.(?:com|org)', S)", "R.findall('\\\\b\\\\d{4}\\\\b', S)", "R.findall('\\\\+?\\\\d[\\\\d -]{7,}\\\\d', S)",
    "R.sub('(?<=\\\\d)(?=(?:\\\\d{3})+(?!\\\\d))', ',', '1234567 89 12345')", "R.split('[;,.!]\\\\s*', S)",
    "[M(m) for m in R.finditer('(?P<k>\\\\w+)=(?P<v>[^&]*)', 'a=1&bb=&c=x y')]",
    "R.findall('(\\\\d+)\\\\.(\\\\d+)\\\\.(\\\\d+)', 'v1.2.3 and 10.20.30')",
    "R.sub('\\\\s+', ' ', '  lots   of\\t\\twhite \\n space ').strip()",
    "M(R.fullmatch('(?:(?:25[0-5]|2[0-4]\\\\d|1?\\\\d?\\\\d)\\\\.){3}(?:25[0-5]|2[0-4]\\\\d|1?\\\\d?\\\\d)', '192.168.0.255'))",
    "M(R.fullmatch('(?:(?:25[0-5]|2[0-4]\\\\d|1?\\\\d?\\\\d)\\\\.){3}(?:25[0-5]|2[0-4]\\\\d|1?\\\\d?\\\\d)', '256.1.1.1'))",
    "R.findall('\"(?:[^\"\\\\\\\\]|\\\\\\\\.)*\"', 'say \"a\\\\\\\"b\" and \"c\"')",
    "R.sub('(?i)(?P<w>hello)', lambda m: m.group('w').upper(), 'Hello hello HELLO')",
    "R.findall('(?m)^(\\\\w+):\\\\s*(.*)$', 'name: x\\nage:  3\\nbad line\\nk:')",
    "R.findall('(?<![\\\\w.])\\\\d+(?:\\\\.\\\\d+)?(?![\\\\w.])', '3.14 x2 10 7.5.1 .5')",
]
CASES = [{"name": f"expr{i:03d}", "expr": e.replace(", S", ", " + repr(S))} for i, e in enumerate(G)]
