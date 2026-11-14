"""Invocations of the pyjq task; build_cases.py runs each with jq 1.7 in the task image and records stdout
and the exit status. Each case: name, argv (options and filter, without the program name), stdin, files."""

import json

PEOPLE = json.dumps([
    {"name": "ann", "age": 31, "dept": "eng", "tags": ["a", "b"], "salary": 120000.5},
    {"name": "bob", "age": 25, "dept": "ops", "tags": [], "salary": 95000},
    {"name": "cid", "age": None, "dept": "eng", "tags": ["c"], "salary": 70000},
    {"name": "dee", "age": 40, "dept": "hr", "tags": ["a"], "salary": 82000.25},
])
NESTED = '{"a": {"b": [1, {"c": 2}, [3, 4]], "d": null}, "e": "x", "f": [true, false], "g": {"h": {"i": 9}}}'
CASES = []


def c(name, argv, stdin="null", files=None):
    CASES.append({"name": name, "argv": list(argv), "stdin": stdin, "files": files or {}})


# ---------------- basics and output formatting
c("identity_pretty", ["."], NESTED)
c("identity_compact", ["-c", "."], NESTED)
c("tab_and_indent", ["--tab", "."], '{"a": [1, {"b": 2}]}')
c("indent_7_and_0", ["--indent", "7", "."], '{"a": [1, 2]}')
c("sort_keys", ["-S", "-c", "."], '{"b": 1, "a": {"d": 1, "c": 2}}')
c("ascii_output", ["-a", "."], '"héllo ✓ 😀"')
c("raw_output_and_join", ["-r", ".[]"], '["a\\nb", "c", 1, null, {"x": 1}]')
c("join_output", ["-j", ".[]"], '["a", "b", 1]')
c("multiple_inputs", ["-c", ".a"], '{"a": 1} {"a": [2]}\n{"a": "three"}  {}')
c("empty_input_object_and_array", ["."], "{} []")
c("unicode_escapes", ["-c", "."], '"\\u00e9\\ud83d\\ude00\\t\\u0000\\u001f\\"\\\\/"')
c("string_escapes_output", ["."], '"line\\nnext\\ttab \\u007f \\u2028 é"')
c("number_literals_preserved", ["-c", "."], "[1.000, 3e2, 100000000000000000000, -0, 0.1, 1E-7, 12345678901234567890123]")
c("number_arithmetic_output", ["-c", "[.[] * 1]"], "[1.000, 3e2, 100000000000000000000, 0.1, 1e1000]")
c("numbers_computed", ["-n", "-c", "[1/3, 2/2, 0.1 + 0.2, 1e17, 1e-5, 3.0, -0.0 * 1, 10 / 4, pow(2; 64)]"])
c("large_and_special_numbers", ["-n", "-c", "[infinite, -infinite, nan | tostring], [nan] | sort"])

# ---------------- paths and access
c("field_access", ["-c", ".a.b, .a.d, .e, .missing, .a.b[1].c"], NESTED)
c("quoted_and_bracket_keys", ["-c", '."a", .["e"], .a["b"][2][-1]'], NESTED)
c("optional_access", ["-c", "[.[] | .a?], [.[] | try .a catch \"err\"]"], '[{"a": 1}, "str", [1], null]')
c("array_index_and_slice", ["-c", ".[0], .[-1], .[10], .[2:4], .[:2], .[-2:], .[1:-1]"], "[0, 1, 2, 3, 4, 5]")
c("string_slice", ["-c", '.[2:5], .[-3:]'], '"abcdefgh"')
c("iterate_objects_and_arrays", ["-c", ".[]"], '{"a": 1, "b": [2], "c": {"d": 3}}')
c("recursive_descent", ["-c", "[.. | numbers]"], NESTED)
c("comma_and_pipe", ["-c", ".a, .e | type"], NESTED)
c("parentheses_precedence", ["-n", "-c", "[1, 2 | . * 10], [(1, 2) | . * 10], (1 + 2) * 3"])

# ---------------- construction
c("object_construction", ["-c", '{name, age: .age, "k-1": 1, (.name): .dept, $__loc__}'], '{"name": "ann", "age": 3, "dept": "eng"}')
c("object_construction_cartesian", ["-c", "{a: (1, 2), b: (3, 4)}"])
c("object_variable_shorthand", ["-c", '. as $x | 5 as $n | {$n, $x, "lit": "v"}'], '"x"')
c("array_construction", ["-c", "[.[] | . * 2], [], [empty], [.[] | select(. > 1)]"], "[1, 2, 3]")
c("string_interpolation", ["-r", '"name=\\(.name) age=\\(.age + 1) tags=\\(.tags) nested=\\("x\\(1 + 2)y")"'],
  '{"name": "ann", "age": 30, "tags": ["a"]}')

# ---------------- operators
c("arithmetic", ["-n", "-c", "[1 + 2, 5 - 3, 2 * 3, 7 / 2, 7 % 3, -7 % 3, 7 % -3, 5.5 % 2, -(3)]"])
c("addition_types", ["-n", "-c", '[null + 1, 1 + null, "a" + "b", [1] + [2], {"a": 1} + {"b": 2, "a": 3}, null + null]'])
c("subtraction_multiplication_division", ["-n", "-c",
  '[[1, 2, 3, 2] - [2], "x" * 3, "x" * 0, {"a": {"b": 1}} * {"a": {"c": 2}}, "a,b,c" / ",", 4 / 2]'])
c("type_errors_exit", ["-n", "{} - 1"])
c("division_by_zero_error", ["-n", "1 / 0"])
c("comparisons_and_ordering", ["-n", "-c",
  '[1 < 2, "a" < "b", [1] < [1, 0], {} < [], null < false, false < true, true < 0, 0 < "", "" < [], [] < {}, '
  '{"a": 1} < {"a": 2}, {"a": 2} < {"b": 1}, 1 == 1.0, "1" == 1]'])
c("logic_and_alternative", ["-n", "-c",
  '[true and false, true or false, (false, null, 1) | not], [null // 1, false // "f", (empty // 2), (1, null) // 3, '
  '([null, false][] // "none")]'])
c("conditionals", ["-c", '.[] | if . > 2 then "big" elif . == 2 then "two" else "small" end, (if . == 1 then "one" end)'],
  "[1, 2, 3]")

# ---------------- variables, functions, control
c("variables_and_scope", ["-c", '.[] as $x | ($x * 2) as $y | [$x, $y]'], "[1, 2]")
c("destructuring", ["-c", '. as [$a, {b: $c, d: [$e]}] | [$a, $c, $e]'], '[1, {"b": 2, "d": [3]}]')
c("alternative_destructuring", ["-c", '.[] as [$a] ?// {a: $a} ?// $a | $a'], '[[1], {"a": 2}, 3]')
c("def_functions", ["-n", "-c",
  'def double: . * 2; def addvalue(f): f as $x | map(. + $x); def fac: if . <= 1 then 1 else . * (. - 1 | fac) end; '
  '[2 | double], ([1, 2] | addvalue(10)), (10 | fac)'])
c("def_with_dollar_params_and_closures", ["-n", "-c",
  'def f($a; $b): $a + $b; def g(x): [x, x]; def outer: 3 as $v | def inner: $v * 2; inner; [f(1; 2), g(1, 2), outer]'])
c("recursion_deep", ["-n", "def r: if . < 1000 then . + 1 | r else . end; 0 | r"])
c("reduce_and_foreach", ["-c", 'reduce .[] as $x (0; . + $x), [foreach .[] as $x (0; . + $x)], '
  '[foreach .[] as $x (0; . + $x; [$x, .])]'], "[1, 2, 3]")
c("reduce_pairs", ["-c", 'reduce .[] as [$k, $v] ({}; .[$k] += [$v])'], '[["a", 1], ["b", 2], ["a", 3]]')
c("try_catch_and_error", ["-n", "-c",
  '[try error("custom") catch ., try (1 / 0) catch "div", try error({"code": 1}) catch .code, (try error catch .), '
  '[.[]?], (try ([1] | .[1.5]) catch "x")]'])
c("error_null_and_halt_error", ["-n", '"bye\\n" | halt_error(3)'])
c("label_break", ["-n", "-c", "[label $out | 1, 2, break $out, 3], [label $f | range(10) | ., (select(. == 3) | break $f)]"])
c("limit_first_last_nth_until", ["-n", "-c",
  "[limit(3; range(10))], first(range(5; 10)), ([range(5)] | last), nth(2; range(10; 20)), (0 | until(. > 100; . * 2 + 1)), "
  "[1 | while(. < 50; . * 3)], [limit(0; 1, 2)]"])
c("range_forms", ["-n", "-c", "[range(4)], [range(2; 5)], [range(0; 10; 3)], [range(5; 0; -2)], [range(1; 2; 0.3)]"])
c("repeat_and_recurse", ["-c", "[limit(5; 1 | repeat(. * 2))], [recurse(.children[]?) | .name], [2 | recurse(. * .; . < 100)]"],
  '{"name": "root", "children": [{"name": "a", "children": [{"name": "a1"}]}, {"name": "b"}]}')
c("env_and_builtins", ["-n", "-c", "$ENV.PYJQ_TEST, env.PYJQ_TEST, (builtins | length > 100)"])
c("input_and_inputs", ["-c", "[., input], [inputs]"], "1 2 3 4 5")
c("null_input_inputs", ["-n", "-c", "[inputs | .a]"], '{"a": 1} {"a": 2}')
c("slurp", ["-s", "-c", "., length"], "1 [2] {\"a\": 3}")
c("raw_input", ["-R", "-c", "."], "line one\nline two\n\nlast")
c("raw_input_slurp", ["-R", "-s", "-c", "split(\"\\n\")"], "a\nb\nc\n")
c("exit_status_e", ["-e", ".a"], '{"a": false}')
c("exit_status_e_null", ["-e", ".[]"], "[1, null]")
c("exit_status_e_true", ["-e", ".a"], '{"a": 1}')
c("args_arg_argjson", ["-n", "-c", "--arg", "x", "hello", "--argjson", "y", '{"n": [1, 2]}', "[$x, $y.n[1], $ARGS.named]"])
c("positional_args", ["-n", "-c", "$ARGS", "--args", "a", "b"])
c("positional_jsonargs", ["-n", "-c", "$ARGS.positional", "--jsonargs", "1", '{"a": 2}'])
c("slurpfile_rawfile", ["-n", "-c", "--slurpfile", "s", "data.json", "--rawfile", "r", "raw.txt", "[$s, $r]"],
  files={"data.json": "1 [2]", "raw.txt": "raw\ncontent"})
c("filter_from_file", ["-c", "-f", "prog.jq"], "[3, 1, 2]", files={"prog.jq": "# comment\nsort | map(. * 10)\n"})
c("input_files_and_filename", ["-c", "[., input_filename]", "a.json", "b.json"], files={"a.json": "1", "b.json": "2 3"})
c("syntax_error_exit", ["-n", "1 +"])
c("comments_in_program", ["-n", "-c", "1 # comment\n+ 2 # another"])

# ---------------- paths and assignment
c("path_and_paths", ["-c", "path(.a.b[1].c), [paths], [paths(type == \"number\")]"], '{"a": {"b": [0, {"c": 1}]}}')
c("getpath_setpath_delpaths", ["-c", 'getpath(["a", "b"]), setpath(["a", "x"]; 1), delpaths([["a", "b"], ["e"]]), getpath(["no", "pe"])'],
  '{"a": {"b": 5}, "e": 1}')
c("del_forms", ["-c", "del(.a), del(.b[1, 2]), del(.. | numbers?)"], '{"a": 1, "b": [1, 2, 3], "c": "x"}')
c("del_array_elements", ["-c", "del(.[1, 3]), del(.[] | select(. % 2 == 0))"], "[0, 1, 2, 3, 4, 5]")
c("assignment_ops", ["-c", ".a = 1, .b |= . + 1, .c += 10, .d -= 1, .e *= 2, .f /= 2, .g %= 3, .h //= \"dflt\""],
  '{"b": 1, "c": 1, "d": 1, "e": 3, "f": 9, "g": 7, "h": null}')
c("update_with_empty", ["-c", "(.[] | select(. > 2)) |= empty, map_values(empty)"], "[1, 2, 3, 4, 5]")
c("update_paths_multiple", ["-c", ".[] .x |= . * 10, (.. | numbers) |= . + 1"], '[{"x": 1}, {"x": 2}]')
c("assignment_rhs_cartesian", ["-c", ".a = (1, 2), .a |= (1, 2)"], '{"a": 0}')
c("to_from_with_entries", ["-c", 'to_entries, (to_entries | from_entries), with_entries(.value += 1), '
  '([{"key": "a", "value": 1}, {"key": "b"}] | from_entries)'], '{"a": 1, "b": 2}')
c("tostream_fromstream", ["-c", "[tostream], fromstream(tostream), [1 | truncate_stream([[0], 1], [[1, 0], 2], [[1, 0]], [[1]])]"], '{"a": [1, {"b": 2}]}')
c("pick_and_walk", ["-c", "pick(.a.b, .c[1]), walk(if type == \"number\" then . * 2 else . end)"], '{"a": {"b": 1, "x": 2}, "c": [3, 4]}')

# ---------------- builtins on collections
c("length_variants", ["-c", "[.[] | length], [.[] | utf8bytelength?]"], '[[1, 2], "héllo", {"a": 1}, null, -5.5]')
c("keys_values_has_in", ["-c", 'keys, keys_unsorted, [.[]], has("b"), ("a" | in({"a": 1})), ([1, 2] | has(1, 5))'], '{"b": 2, "a": 1}')
c("map_select_add_any_all", ["-c", "map(. * 2), map(select(. > 1)), add, any, all, (map(. > 2) | any, all), ([] | add), "
  "any(.[]; . == 2), all(.[]; . > 0)"], "[1, 2, 3]")
c("add_strings_arrays_objects", ["-c", 'add, ([[1], [2, 3]] | add), ([{"a": 1}, {"b": 2}] | add)'], '["a", "b", "c"]')
c("sort_group_unique", ["-c", "sort, sort_by(.a), group_by(.a), unique, unique_by(.a), (map(.a) | unique)"],
  '[{"a": 2, "b": 1}, {"a": 1}, {"a": 2, "b": 0}, {"a": null}]')
c("sort_mixed_types", ["-c", "sort"], '[3, "b", null, [1], {"a": 1}, true, false, "a", 1.5, [], {}]')
c("min_max", ["-c", "min, max, min_by(.x), max_by(.x), ([] | min)"], '[{"x": 3}, {"x": 1}, {"x": 2}]')
c("reverse_contains_inside", ["-c", 'reverse, (["foobar", "baz"] | contains(["bar"])), '
  '({"a": [1, 2, 3], "b": "x"} | contains({"a": [1]})), ("bar" | inside("foobar")), ([] | reverse)'], "[1, 2, 3]")
c("indices_index_rindex", ["-c", '"a,b, cd, efg" | index(", "), rindex(", "), indices(", "), ([1, 2, 1, 2, 1] | indices([1, 2]), indices(1))'])
c("transpose_combinations_flatten", ["-c", "transpose, ([[1, 2], [3, 4]] | [combinations]), ([0, 1] | [combinations(2)]), "
  "([1, [2, [3, [4]]]] | flatten, flatten(1))"], "[[1, 2], [3]]")
c("tojson_fromjson_tostring_tonumber", ["-c", '[.[] | tojson], [.[] | tostring], ("[1,{\\"a\\":2}]" | fromjson), '
  '(["1", "1.5", " 2", "1e3"] | map(tonumber? // "bad"))'], '[1, "s", [1, "x"], {"a": null}, 1.50]')
c("type_and_filters", ["-c", "map(type), [.[] | numbers], [.[] | strings], [.[] | arrays], [.[] | objects], [.[] | booleans], "
  "[.[] | nulls], [.[] | iterables], [.[] | scalars], [.[] | values]"], '[1, "a", [1], {"a": 1}, true, null]')
c("math_functions", ["-n", "-c", "[4 | sqrt], [2.5 | floor, ceil, round, fabs], [-2.5 | round, abs, fabs], (8 | log2), (100 | log10), "
  "(2 | pow(.; 10)), (1 | exp | . * 1000 | floor), ([1, 2, 3] | map(. * 1.5 | floor)), (0 | significand), (10 | exp10)"])
c("special_numbers", ["-n", "-c", "[nan | isnan], [infinite | isinfinite], [1 | isnormal], [nan < 1, nan > 1], ([nan, 1] | sort | .[0] | isnan)"])

# ---------------- strings
c("string_functions", ["-c", '[startswith("he"), endswith("lo"), ltrimstr("he"), rtrimstr("lo"), ascii_downcase, ascii_upcase, '
  'explode, (explode | implode), split("l"), (split("l") | join("L")), (. / "l")]'], '"heLlo"')
c("join_mixed", ["-c", 'join(", "), join("")'], '["a", 1, null, true, "b"]')
c("regex_test_match", ["-c", '[.[] | test("^[a-z]+\\\\d")], (.[0] | match("([a-z]+)(\\\\d+)")), [.[] | test("ABC"; "i")]'],
  '["abc123", "xyz", "ABC9"]')
c("regex_capture_scan_splits", ["-c", '(.s | capture("(?<word>[a-z]+)-(?<num>\\\\d+)")), [.s | scan("\\\\d+")], '
  '[.s | scan("([a-z])(\\\\d)")], [.t | splits(", *")], (.t | split(", *"; null))'], '{"s": "ab-12 cd-34", "t": "a, b,c,  d"}')
c("regex_sub_gsub", ["-c", '[sub("o"; "0"), gsub("o"; "0"), gsub("(?<v>[aeiou])"; "<\\(.v)>"), gsub("^"; ">"), gsub(""; "-"), '
  'sub("(?<x>l+)"; "\\(.x | length)"; "g")]'], '"foo bool"')
c("regex_match_global_and_offsets", ["-c", '[match("a(b)?"; "g") | {offset, length, string, captures: [.captures[] | .string]}]'],
  '"ab a xab"')
c("formats", ["-r", '@text, @json, @html, @uri, @csv, @tsv, @sh, @base64, (@base64 | @base64d)'], '["a b", "<&>\'\\"", "ü/?", 1, null]')
c("format_interpolation", ["-r", '@csv "row: \\(.)", @sh "echo \\(.[0])", @uri "https://x/?q=\\(.[0])"'], '["a b", "c\\"d"]')
c("format_errors", ["-c", 'try @csv catch "csv-error"'], '[{"a": 1}]')

# ---------------- dates
c("dates", ["-n", "-c", '"2015-03-05T23:51:47Z" | fromdate, (fromdate | todate), strptime("%Y-%m-%dT%H:%M:%SZ"), '
  '(strptime("%Y-%m-%dT%H:%M:%SZ") | mktime), (1425599621 | gmtime), (1425599621 | strftime("%A %d %B %Y %H:%M %j")), '
  '(1425599621 | todate), (1425599621.5 | todate)'])

# ---------------- realistic programs
c("report_by_dept", ["-c", 'group_by(.dept) | map({dept: .[0].dept, n: length, avg: (map(.salary) | add / length), '
  'names: map(.name) | join("/")})'], PEOPLE)
c("filter_and_project", ["-r", '.[] | select(.age != null and .age > 26) | "\\(.name)\\t\\(.age)\\t\\(.tags | length)"'], PEOPLE)
c("index_by_and_lookup", ["-c", 'INDEX(.name) | .bob.dept, (map_values(.age) | to_entries | map(select(.value)) | from_entries)'], PEOPLE)
c("sql_style_builtins", ["-c", '[.[] | {name, dept}] as $p | [limit(2; $p[])], (IN($p[].dept; "hr", "x")), '
  '([$p[] | .dept] | unique | map(. as $d | {($d): [$p[] | select(.dept == $d) | .name]}) | add)'], PEOPLE)
c("tsv_csv_export", ["-r", '(.[0] | keys_unsorted | @csv), (.[] | [.name, .age, (.tags | join(";"))] | @tsv)'], PEOPLE)
c("deep_merge_and_paths", ["-c", 'reduce .[] as $o ({}; . * $o) | [paths(scalars) | join(".")]'],
  '[{"a": {"x": 1, "y": {"z": 2}}}, {"a": {"y": {"w": 3}}, "b": 4}]')
c("histogram", ["-c", 'map(.tags[]) | group_by(.) | map({(.[0]): length}) | add'], PEOPLE)
c("getpath_from_strings", ["-c", '[paths(..) as $p | {path: ($p | map(tostring) | join("/")), v: getpath($p)} | select(.v | scalars)]'],
  '{"a": [1, {"b": "c"}]}')
