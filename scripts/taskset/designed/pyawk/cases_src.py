"""Test programs of the pyawk task. build_cases.py runs each with `gawk --posix` and records stdout, the
exit status and any files the program writes. Each case: name, argv after the awk command, stdin,
input files, output files to collect."""

PEOPLE = "alice 30 NY\nbob 25 LA\ncarol 35 NY\ndave 40 SF\neve 28 LA\n"
CSV = "id,name,score\n1,ann,90\n2,ben,75.5\n3,cid,\n4,dee,82\n"
PARAS = "name: a\nage: 1\n\nname: b\nage: 2\n\n\n\nname: c\nage: 3\n"
NUMS = "10\n2\n3.5\n-4\n1e3\n0x10\n abc \n007\n+5\n.5\n"
TEXT = "The quick brown fox\njumps over the lazy dog.\nThe end; or is it?\n\nTabs\there\tand  spaces\n"
SORTFN = "function isort(a, n,   i, j, t) { for (i = 2; i <= n; i++) { t = a[i]; for (j = i - 1; j >= 1 && a[j] > t; j--) a[j+1] = a[j]; a[j+1] = t } }\n"

CASES = []


def c(name, prog, stdin=PEOPLE, pre=(), post=(), files=None, out=()):
    CASES.append({"name": name, "args": list(pre) + [prog] + list(post), "stdin": stdin, "files": files or {},
                  "out": list(out)})


# --- program structure and patterns
c("print_all", "{ print }")
c("print_field", "{ print $2 }")
c("print_fields_comma", "{ print $1, $3 }")
c("print_concat", "{ print $1 $3 }")
c("begin_only", 'BEGIN { print "hello" }', stdin="")
c("begin_end_count", 'BEGIN { n = 0 } { n++ } END { print n, NR }')
c("end_last_record", "END { print $0; print NF }")
c("pattern_expr", "$2 > 29")
c("pattern_regex", "/^[cd]/")
c("pattern_regex_field", '$3 ~ /^(NY|SF)$/ { print $1 }')
c("pattern_not_match", '$3 !~ "Y" { print $1 }')
c("pattern_and_or", '$2 > 26 && $3 == "LA" || $1 == "dave"')
c("range_pattern", "/bob/, /dave/ { print NR, $1 }")
c("range_same_line", "/carol/, /carol/ { print }")
c("range_open_end", "/dave/, /nomatch/ { print $1 }")
c("multiple_rules", '{ print "a:" $1 } $2 > 30 { print "b:" $1 }')
c("semicolons_newlines", "BEGIN { x = 1; y = 2\n z = 3 } ; END { print x + y + z }")
c("comments_and_continuation", "# comment\n{ s += \\\n $2 } # trailing\nEND { print s }")
c("empty_pattern_action", "NR == 2")
c("uninitialized", 'BEGIN { print x + 0, "[" x "]", length(x) }', stdin="")

# --- fields
c("nf_and_last_field", "{ print NF, $NF, $(NF-1) }")
c("assign_field_rebuilds", '{ $2 = "*"; print; print NF }')
c("assign_beyond_nf", '{ $6 = "x"; print; print NF }', stdin="a b c\n")
c("assign_nf_truncates", "{ NF = 2; print }")
c("assign_nf_grows", '{ NF = 5; print; print NF }', stdin="a b\n")
c("assign_dollar0_resplits", '{ $0 = "p q r s"; print NF, $3 }', stdin="a\n")
c("ofs_rebuild", 'BEGIN { OFS = "-" } { $1 = $1; print } { print $1, $2 }')
c("default_fs_whitespace", "{ print NF; print $2 }", stdin="  lead\tand   trail  \n")
c("fs_single_char", 'BEGIN { FS = "," } { print $2 "|" $3 "|" NF }', stdin=CSV)
c("fs_option", "{ print $2 }", stdin=CSV, pre=["-F", ","])
c("fs_tab_option", "{ print $2 }", stdin="a\tb c\td\n", pre=["-F", "\\t"])
c("fs_regex", 'BEGIN { FS = "[,;]+ *" } { print $3; print NF }', stdin="a,b;; c,,d\n")
c("fs_space_char_literal", 'BEGIN { FS = "[ ]" } { print NF; print $3 }', stdin="a  b\n")
c("fs_change_takes_effect_next_record", '{ FS = ","; print $1 }', stdin="a,b c\nd,e f\n")
c("field_string_number_compare", '{ print ($1 < $2), ($1 == 10) }', stdin="10 9\n10.0 9\nabc 9\n")
c("strnum_fields", '$1 == 1', stdin="1\n1.0\n01\n+1\n 1 \n1e0\nx\n")
c("negative_field_index_error", "{ print $(-1) }", stdin="a\n")

# --- records
c("rs_char", 'BEGIN { RS = ";" } { print NR ": " $0 }', stdin="a;b;c\n")
c("rs_paragraph", 'BEGIN { RS = "" } { print NR ": " $1 " / " $NF " / " NF }', stdin=PARAS)
c("rs_paragraph_fs", 'BEGIN { RS = ""; FS = ":" } { for (i = 1; i <= NF; i++) printf "[%s]", $i; print "" }',
  stdin=PARAS)
c("ors", 'BEGIN { ORS = "|" } { print $1 } END { printf "\\n" }')
c("nr_fnr_filename", "{ print FILENAME, NR, FNR }", stdin="", post=["f1", "f2"],
  files={"f1": "a\nb\n", "f2": "c\n"})
c("stdin_dash", "{ print FILENAME \":\" $0 }", stdin="from stdin\n", post=["f1", "-"], files={"f1": "file\n"})
c("cmdline_assignment_between_files", "{ print v, $0 }", stdin="", post=["v=1", "f1", "v=2", "f1"],
  files={"f1": "x\n"})
c("no_trailing_newline", "{ print NR, $0 }", stdin="a\nb")

# --- numbers and conversions
c("arith_ops", 'BEGIN { print 7 + 2, 7 - 2, 7 * 2, 7 / 2, 7 % 3, -7 % 3, 2 ^ 10, 2 ^ 3 ^ 2 }', stdin="")
c("arith_float_output", 'BEGIN { print 1/3, 100000 * 100000, 1e6, 1e-5, 0.1 + 0.2, 123456789012 }', stdin="")
c("ofmt_convfmt", 'BEGIN { OFMT = "%.2f"; CONVFMT = "%.3f"; x = 3.14159; print x; y = x ""; print y; print 17 "" }',
  stdin="")
c("integer_values_print_plain", 'BEGIN { x = 2.0; print x; print x ""; print 1e15, 1e16 + 0 }', stdin="")
c("string_to_number", "{ print $1 + 0 }", stdin=NUMS)
c("increment_decrement", 'BEGIN { x = 5; print x++, x, ++x, x--, --x, x }', stdin="")
c("compound_assign", 'BEGIN { x = 10; x += 5; x -= 3; x *= 2; x /= 4; x %= 4; x ^= 3; print x }', stdin="")
c("unary_minus_concat", 'BEGIN { x = 3; print 1 - x, 1 " " -x, -x " " x }', stdin="")
c("comparison_rules", 'BEGIN { print ("10" < "9"), (10 < 9), ("a" < "b"), (2 < "10"), ("abc" == "abc") }', stdin="")
c("int_and_math", 'BEGIN { print int(3.9), int(-3.9), int("4.5x"), sqrt(16), exp(0), log(1), sin(0), cos(0), '
  'atan2(0, -1) }', stdin="")
c("modulo_float", 'BEGIN { print 7.5 % 2, -7.5 % 2 }', stdin="")
c("division_by_zero_error", 'BEGIN { x = 0; print 1 / x }', stdin="")
c("conditional_expr", '{ print ($2 >= 30 ? "old" : "young"), ($3 == "NY" ? 1 : 0) }')
c("logical_short_circuit", 'BEGIN { x = 0; if (0 && (x = 1)) ; if (1 || (x = 2)) ; print x; print !0, !1, !"", !"a" }',
  stdin="")
c("in_operator", 'BEGIN { a["x"]; print ("x" in a), ("y" in a); if (!("z" in a)) print "no z"; n = 0; for (k in a) n++; print n }',
  stdin="")
c("concat_precedence", 'BEGIN { print 1 " " 2 + 3 " " 4 * 5; x = "a" "b" == "ab"; print x }', stdin="")
c("exponent_assoc", 'BEGIN { print 2^3^2, -2^2, (-2)^2 }', stdin="")
c("number_string_edge", 'BEGIN { print length(12345), length(0.5), substr(123456, 2, 3), index(3.25, ".") }', stdin="")

# --- strings and regex
c("length_forms", '{ print length, length($1), length() }')
c("substr_cases", 'BEGIN { s = "hello"; print substr(s, 2), substr(s, 2, 3), substr(s, 0, 2), substr(s, -1, 3), '
  'substr(s, 4, 100), "[" substr(s, 9) "]", substr(s, 1.5, 2.3) }', stdin="")
c("index_and_case", 'BEGIN { print index("banana", "an"), index("banana", "x"), toupper("abC1"), tolower("XyZ") }',
  stdin="")
c("split_default_and_sep", 'BEGIN { n = split("a b  c", arr); print n, arr[1], arr[3]; n = split("a:b::c", arr, ":"); '
  'print n, arr[3] "|" arr[4]; n = split("a1b22c", arr, /[0-9]+/); print n, arr[2], arr[3] }', stdin="")
c("split_clears_array", 'BEGIN { a[9] = 1; n = split("x y", a); print n, (9 in a) }', stdin="")
c("split_strnum", 'BEGIN { split("10 9", a); print (a[1] > a[2]) }', stdin="")
c("sub_gsub", '{ n = gsub(/o/, "0"); sub(/^./, "[&]"); print n, $0 }', stdin=TEXT)
c("gsub_ampersand_escape", 'BEGIN { s = "a.b.c"; gsub(/\\./, "\\\\&", s); print s; t = "xyz"; gsub(/y/, "<&&>", t); '
  'print t }', stdin="")
c("gsub_on_field", '{ gsub(/a/, "A", $1); print; print NF }')
c("gsub_empty_match", 'BEGIN { s = "abc"; gsub(/x*/, "-", s); print s }', stdin="")
c("match_rstart_rlength", '{ if (match($0, /[a-z]+[0-9]+/)) print RSTART, RLENGTH, substr($0, RSTART, RLENGTH); '
  'else print RSTART, RLENGTH }', stdin="abc def12 x\nnone here\n9z9\n")
c("dynamic_regex", 'BEGIN { re = "^[0-9]+$" } $0 ~ re { print "num:" $0 } $0 ~ "a" "b" { print "ab:" $0 }',
  stdin="123\nabc\nx12\n")
c("regex_classes_and_intervals", '/^[[:alpha:]]{3}[[:digit:]]{2,3}$/ { print "yes " $0 } /[[:space:]]/ { print "sp" }',
  stdin="abc12\nabcd123\nab12\nxyz999\na b\n")
c("regex_special_chars", '/\\./ { print "dot " $0 } /a\\/b/ { print "slash" } /\\$$/ { print "dollar" }',
  stdin="a.b\na/b\ncost$\nplain\n")
c("regex_alternation_grouping", '/^(ab|cd)+e?$/', stdin="abab\ncdabe\nabc\ne\nab\n")
c("regex_bracket_edge", '/[]a]/ { print "1:" $0 } /[^-a-c]/ { print "2:" $0 }', stdin="]\na\n-\nd\n")
c("escape_sequences", 'BEGIN { print "a\\tb\\nc\\\\d\\"e\\/f"; printf "%s|", "\\101\\102"; print "" }', stdin="")
c("string_comparison_fields", '$1 > "c"')
c("tolower_numbers", 'BEGIN { print toupper(12.5) "", tolower("ÀB") }', stdin="")

# --- printf
c("printf_basic", '{ printf "%-6s|%4d|%s\\n", $1, $2, $3 }')
c("printf_numbers", 'BEGIN { printf "%d %i %o %x %X %u %c %c\\n", 255.9, -3.7, 8, 255, 255, 42, 65, "hello" }',
  stdin="")
c("printf_floats", 'BEGIN { printf "%f %.2f %e %.3E %g %G %10.4f|%-10.1f|\\n", 3.14159, 2.675, 12345.678, 0.000123, '
  '0.0001234, 1e20, 3.14159, 2.5 }', stdin="")
c("printf_flags", 'BEGIN { printf "%05d|%+d|% d|%-5d|%#o|%#x|%.3d|%5.1s|\\n", 42, 42, 42, 42, 8, 255, 7, "abc" }',
  stdin="")
c("printf_star", 'BEGIN { printf "%*d|%-*s|%.*f\\n", 6, 42, 4, "ab", 2, 3.14159 }', stdin="")
c("printf_percent", 'BEGIN { printf "100%% %s|\\n", "x" }', stdin="")
c("printf_g_large_small", 'BEGIN { printf "%g %g %g %g %g\\n", 100000, 1000000, 1e-4, 1e-5, 123456789 }', stdin="")
c("sprintf_and_print_parens", 'BEGIN { s = sprintf("%3s/%-3s/", "a", "b"); print(s); print("x", "y") }', stdin="")
c("printf_c_number_string", 'BEGIN { printf "%c%c%c\\n", 72, "i!", 33 }', stdin="")

# --- arrays
c("array_count_sorted", SORTFN + '{ c[$3]++ } END { n = 0; for (k in c) keys[++n] = k; isort(keys, n); '
  'for (i = 1; i <= n; i++) print keys[i], c[keys[i]] }')
c("array_sum_by_key", SORTFN + '{ s[$3] += $2 } END { n = 0; for (k in s) ks[++n] = k; isort(ks, n); '
  'for (i = 1; i <= n; i++) print ks[i], s[ks[i]] }')
c("array_delete_element_and_all", 'BEGIN { a[1]; a[2]; a[3]; delete a[2]; n = 0; for (k in a) n++; print n, (2 in a); '
  'delete a; n = 0; for (k in a) n++; print n }', stdin="")
c("multi_dim", 'BEGIN { a[1, 2] = "x"; for (k in a) { split(k, p, SUBSEP); print p[1], p[2] } print ((1, 2) in a), '
  '((2, 1) in a) }', stdin="")
c("subsep_change", 'BEGIN { SUBSEP = ":"; a["x", "y"] = 1; for (k in a) print k }', stdin="")
c("array_numeric_string_keys", 'BEGIN { a[1] = "one"; print a["1"]; a[01] = "x"; print a[1]; b["01"] = 2; '
  'print (1 in b); x = 0.1 + 0.2; c[x] = 3; for (k in c) print k }', stdin="")
c("array_reference_creates", 'BEGIN { if (a["x"] == "") print "empty"; print ("x" in a) }', stdin="")
c("array_param_by_reference", 'function fill(arr, n,   i) { for (i = 1; i <= n; i++) arr[i] = i * i } '
  'BEGIN { fill(sq, 4); n = 0; for (k in sq) n++; print sq[3], n }', stdin="")

# --- control flow and functions
c("if_else_chain", '{ if ($2 < 28) print "a"; else if ($2 < 35) print "b"; else print "c" }')
c("while_do_for", 'BEGIN { i = 0; while (i < 3) i++; print i; do { i-- } while (i > 10); print i; '
  'for (j = 0; j < 5; j++) { if (j == 1) continue; if (j == 4) break; printf "%d ", j } print "" }', stdin="")
c("next_statement", 'NR == 2 { next } { print $1 }')
c("exit_in_main_runs_end", 'NR == 3 { exit 4 } { print } END { print "end", NR }')
c("exit_in_end", 'END { print "a"; exit 2; print "b" }')
c("exit_code_expression", 'BEGIN { exit 1 + 2 }', stdin="")
c("recursive_function", 'function fact(n) { return n <= 1 ? 1 : n * fact(n - 1) } BEGIN { print fact(10), fact(20) }',
  stdin="")
c("function_locals", 'function f(a,   t) { t = a * 2; g = t; return t } BEGIN { t = "outer"; print f(3), t, g }',
  stdin="")
c("function_no_return_value", 'function f() { x = 1 } BEGIN { v = f(); print "[" v "]", x }', stdin="")
c("function_fewer_args", 'function f(a, b) { return a "-" b "-" length(b) } BEGIN { print f(1) }', stdin="")
c("fib_memo", 'function fib(n) { if (n in m) return m[n]; return m[n] = n < 2 ? n : fib(n-1) + fib(n-2) } '
  'BEGIN { print fib(80) }', stdin="")
c("getline_plain", 'NR == 1 { getline; print "now", $0, NR } { print "rec", $1 }')
c("getline_var", 'NR == 1 { getline line; print "line=" line, "$0=" $0, NR }')
c("getline_from_file", 'BEGIN { while ((getline l < "f1") > 0) n++; print n, l; close("f1"); getline first < "f1"; '
  'print first }', stdin="", files={"f1": "one\ntwo\nthree\n"})
c("getline_file_sets_dollar0", 'BEGIN { getline < "f1"; print $2, NF, NR }', stdin="", files={"f1": "a b c\n"})
c("getline_missing_file", 'BEGIN { r = (getline x < "nofile"); print r }', stdin="")
c("getline_at_eof", 'END { r = getline; print r, $0 }', stdin="last\n")

# --- output redirection
c("redirect_write_and_append", '{ print $1 > "out.txt" } END { close("out.txt"); print "more" >> "out.txt" }',
  out=["out.txt"])
c("redirect_per_key", '{ print $1 > ($3 ".txt") }', out=["NY.txt", "LA.txt", "SF.txt"])
c("stderr_output", '{ print "err:" $1 > "/dev/stderr"; print "out:" $1 }', stdin="a\n")
c("printf_redirect", 'BEGIN { printf "%s-%d\\n", "x", 5 > "p.txt" }', stdin="", out=["p.txt"])

# --- command line
c("v_assignment", 'BEGIN { print x, y + 1 }', stdin="", pre=["-v", "x=hello", "-v", "y=41"])
c("v_assignment_escapes_and_strnum", 'BEGIN { print x; print (n == 10) }', stdin="", pre=["-v", "x=a\\tb", "-v", "n=10.0"])
c("argv_argc", 'BEGIN { for (i = 0; i < ARGC; i++) if (i > 0) print i, ARGV[i]; print ARGC }', stdin="",
  post=["a", "b c"])
c("argv_modify_skips_file", 'BEGIN { ARGV[1] = "" } { print FILENAME, $0 }', stdin="", post=["f1", "f2"],
  files={"f1": "one\n", "f2": "two\n"})
c("program_file", None, stdin=PEOPLE, pre=["-f", "prog.awk"], files={"prog.awk": "{ s += $2 }\nEND { print s / NR }\n"})
c("two_program_files", None, stdin="x\n", pre=["-f", "a.awk", "-f", "b.awk"],
  files={"a.awk": "function g() { return 7 }\n", "b.awk": "{ print g(), $0 }\n"})
c("environ", 'BEGIN { print ENVIRON["PYAWK_TEST_VAR"] }', stdin="")
c("syntax_error", "{ print $1 ", stdin="a\n")
c("syntax_error_no_actions_run", 'BEGIN { print "started" } { print ( }', stdin="a\n")

# --- larger programs
c("word_frequency", SORTFN + '{ for (i = 1; i <= NF; i++) { w = tolower($i); gsub(/[^a-z]/, "", w); if (w != "") f[w]++ } }'
  ' END { n = 0; for (w in f) ws[++n] = sprintf("%03d %s", 100 - f[w], w); isort(ws, n); for (i = 1; i <= 5; i++) '
  'print ws[i] }', stdin=TEXT * 3)
c("csv_report", 'BEGIN { FS = "," } NR > 1 { if ($3 == "") { missing++; next } total += $3; n++ ; if ($3 > max) { '
  'max = $3; who = $2 } } END { printf "n=%d avg=%.2f max=%s(%s) missing=%d\\n", n, total / n, max, who, missing }',
  stdin=CSV)
c("transpose", '{ for (i = 1; i <= NF; i++) m[NR, i] = $i; if (NF > w) w = NF } END { for (i = 1; i <= w; i++) { '
  'row = ""; for (j = 1; j <= NR; j++) row = row (j > 1 ? " " : "") m[j, i]; print row } }', stdin="1 2 3\n4 5 6\n")
c("reverse_lines", '{ l[NR] = $0 } END { for (i = NR; i > 0; i--) print l[i] }', stdin=TEXT)
c("dedupe_keep_order", '!seen[$0]++', stdin="a\nb\na\nc\nb\n")
c("join_files", 'NR == FNR { ages[$1] = $2; next } $1 in ages { print $1, ages[$1], $2 }', stdin="",
  post=["f1", "f2"], files={"f1": "alice 30\nbob 25\n", "f2": "bob LA\nzed XX\nalice NY\n"})
c("caesar_cipher", 'function rot(s, k,   out, i, c, p) { for (i = 1; i <= length(s); i++) { c = substr(s, i, 1); '
  'p = index(alpha, tolower(c)); out = out (p ? substr(alpha, (p - 1 + k) % 26 + 1, 1) : c) } return out } '
  'BEGIN { alpha = "abcdefghijklmnopqrstuvwxyz" } { print rot($0, 13) }', stdin=TEXT)
c("number_formats_table", '{ printf "%-8s %8.3f %8.2e %5d%%\\n", $1, $2 / 7, $2 * 1000, $2 }')
