"""Invocations of the textutils task; build_cases.py runs each with the GNU tool in the task image
(LC_ALL=C) and records stdout, the exit status and written files. Each case: name, argv (tool first),
stdin, input files, output files to collect."""

LINES = "apple 3 red\nbanana 12 yellow\ncherry 7 red\napple 3 green\ndate 10 brown\nElder 2 purple\nfig 12 green\n"
CSV = "id,name,dept,salary\n3,Cid,ops,70000\n1,Ann,eng,120000\n2,Bob,eng,95000\n5,Eve,,50000\n4,Dee,ops,82000.5\n"
TEXT = ("The quick brown fox jumps over the lazy dog.\nA second line, with commas, and more.\n\n"
        "	tabbed line	here\nthe end? THE END!\nfoo bar foo baz foo\n")
NUMS = "10\n9\n100\n-3\n2.5\n1e2\n0x10\n\n007\n9\n1K\n2M\n500\n"
CASES = []


def c(name, argv, stdin="", files=None, out=()):
    CASES.append({"name": name, "argv": list(argv), "stdin": stdin, "files": files or {}, "out": list(out)})


F = {"a.txt": LINES, "b.txt": TEXT, "csv": CSV}

# ---------------- grep
c("grep_basic", ["grep", "apple"], LINES)
c("grep_bre_vs_ere", ["grep", "a\\(p\\)\\1"], LINES)
c("grep_ere_alternation", ["grep", "-E", "red|green$"], LINES)
c("grep_fixed", ["grep", "-F", "a.e"], "a.e\nabe\n")
c("grep_options_icnv", ["grep", "-i", "-n", "the"], TEXT)
c("grep_count_invert", ["grep", "-vc", "e"], LINES)
c("grep_only_matching", ["grep", "-o", "fo*"], TEXT)
c("grep_word_line", ["grep", "-w", "foo"], "foo\nfood\na foo b\nfoo_x\n")
c("grep_line_exact", ["grep", "-x", "-E", "[a-z]+"], "abc\nabc1\nxyz\n")
c("grep_files_with_names", ["grep", "-n", "e", "a.txt", "b.txt"], files=F)
c("grep_l_L", ["grep", "-l", "red", "a.txt", "b.txt"], files=F)
c("grep_L", ["grep", "-L", "red", "a.txt", "b.txt"], files=F)
c("grep_context", ["grep", "-n", "-C1", "cherry\\|fig", "a.txt"], files=F)
c("grep_after_before", ["grep", "-A1", "-B2", "date", "a.txt"], files=F)
c("grep_max_count", ["grep", "-m2", "e"], LINES)
c("grep_multiple_e_and_f", ["grep", "-e", "fig", "-e", "^b", "-f", "pats"], LINES, files={"pats": "Elder\n"})
c("grep_quiet_status_found", ["grep", "-q", "fig"], LINES)
c("grep_quiet_status_missing", ["grep", "-q", "zzz"], LINES)
c("grep_missing_file", ["grep", "-s", "x", "nofile"], "")
c("grep_classes_and_anchors", ["grep", "-E", "^[[:upper:]][[:alpha:]]+ [[:digit:]]+ [[:lower:]]+$"], LINES)
c("grep_bre_interval_and_star", ["grep", "x\\{2,3\\}y*$"], "xy\nxxy\nxxxyyy\nxxxx\n")
c("grep_ere_backref_plus", ["grep", "-E", "(ab)+c\\b"], "ababc d\nabc\nac\nabcd\n")
c("grep_o_with_n_i", ["grep", "-o", "-n", "-i", "the"], TEXT)
c("grep_h_H", ["grep", "-H", "fox", "b.txt"], files=F)
c("grep_recursive", ["grep", "-r", "-h", "apple", "d"], files={"d/x.txt": "apple pie\n", "d/sub/y.txt": "no\napple\n"})

# ---------------- sed
c("sed_substitute", ["sed", "s/apple/APPLE/"], LINES)
c("sed_global_nth_flags", ["sed", "s/o/0/2;s/a/A/g"], TEXT)
c("sed_groups_and_amp", ["sed", "-E", "s/^([a-z]+) ([0-9]+)/\\2:\\1 [&]/"], LINES)
c("sed_case_conversion", ["sed", "-E", "s/(\\w+) (\\w+)/\\U\\1\\E \\u\\2/"], LINES)
c("sed_n_p_and_addresses", ["sed", "-n", "2,4p;$p"], LINES)
c("sed_regex_ranges", ["sed", "-n", "/banana/,/date/{=;p}"], LINES)
c("sed_step_and_plus", ["sed", "-n", "1~3p;2,+1s/^/>/p"], LINES)
c("sed_zero_address", ["sed", "0,/red/s/red/RED/"], LINES)
c("sed_negation_delete", ["sed", "/red/!d"], LINES)
c("sed_insert_append_change", ["sed", "2i\\\ninserted\n4a\\\nappended\n$c\\\nchanged"], LINES)
c("sed_gnu_one_liner_aic", ["sed", "-e", "1i top", "-e", "3a after three", "-e", "/fig/c replaced fig"], LINES)
c("sed_y_command", ["sed", "y/abc/xyz/"], LINES)
c("sed_hold_space_reverse", ["sed", "-n", "1!G;h;$p"], LINES)
c("sed_N_join_lines", ["sed", "N;s/\\n/ | /"], LINES)
c("sed_D_P_pairs", ["sed", "$!N;P;D"], "a\na\nb\nb\nb\nc\n")
c("sed_branch_label_loop", ["sed", "-E", ":a;s/^([0-9]+)([0-9]{3})/\\1,\\2/;ta"], "1234567\n12\n1234\n")
c("sed_T_command", ["sed", "s/x/X/;T;s/$/ (changed)/"], "axb\nabc\n")
c("sed_quit_and_Q", ["sed", "3q"], LINES)
c("sed_Q", ["sed", "/cherry/Q"], LINES)
c("sed_line_number_eq", ["sed", "-n", "$="], LINES)
c("sed_l_command", ["sed", "-n", "l"], "tab\there\nback\\slash\n\x01ctl\n")
c("sed_w_flag_and_command", ["sed", "-n", "s/red/RED/w changed.txt\n/green/w green.txt"], LINES,
  out=["changed.txt", "green.txt"])
c("sed_r_command", ["sed", "/date/r extra.txt"], LINES, files={"extra.txt": "EXTRA LINE\n"})
c("sed_script_file", ["sed", "-f", "prog.sed"], LINES, files={"prog.sed": "# comment\n/red/{\n  s/red/R/\n  s/^/* /\n}\n$d\n"})
c("sed_in_place", ["sed", "-i.bak", "s/a/@/g", "work.txt"], files={"work.txt": "banana\napple\n"},
  out=["work.txt", "work.txt.bak"])
c("sed_separate_files", ["sed", "-s", "-n", "$p", "a.txt", "b.txt"], files=F)
c("sed_custom_delimiter", ["sed", "s|/usr/local|/opt|g;\\,^#,d"], "# comment\npath=/usr/local/bin:/usr/local/lib\n")
c("sed_case_insensitive_flag", ["sed", "s/the/[x]/Ig"], TEXT)
c("sed_null_data", ["sed", "-z", "s/\\n/,/g"], "a\nb\nc\n")
c("sed_empty_regex_reuse", ["sed", "-n", "/e/{s//E/gp}"], LINES)
c("sed_special_replacement_newline", ["sed", "s/ /\\n/"], "one two three\n")

# ---------------- sort
c("sort_default", ["sort"], LINES)
c("sort_reverse_unique", ["sort", "-ru"], "b\na\nb\nc\na\n")
c("sort_numeric", ["sort", "-n"], NUMS)
c("sort_general_numeric", ["sort", "-g"], NUMS)
c("sort_human", ["sort", "-h"], "1K\n2M\n500\n3G\n1k\n")
c("sort_key_numeric", ["sort", "-k2,2n", "-k1,1"], LINES)
c("sort_key_reverse_modifier", ["sort", "-t,", "-k4,4nr"], CSV)
c("sort_key_char_positions", ["sort", "-k1.2,1.3"], LINES)
c("sort_fold_case", ["sort", "-f"], LINES)
c("sort_stable", ["sort", "-s", "-k3,3"], LINES)
c("sort_last_resort_compare", ["sort", "-k3,3"], LINES)
c("sort_dictionary_blank", ["sort", "-d", "-b"], "  b-x\na_y\n c.z\n")
c("sort_month_version", ["sort", "-M"], "Mar\nJan\nfoo\nDec\nfeb\n")
c("sort_version", ["sort", "-V"], "v1.10\nv1.2\nv1.9.1\nv1.9\n")
c("sort_check", ["sort", "-c"], "a\nc\nb\n")
c("sort_output_file", ["sort", "-o", "sorted.txt", "a.txt"], files=F, out=["sorted.txt"])
c("sort_unique_by_key", ["sort", "-u", "-k1,1"], LINES)

# ---------------- uniq, cut, tr, wc
c("uniq_counts", ["uniq", "-c"], "a\na\nb\nc\nc\nc\na\n")
c("uniq_d_u", ["uniq", "-d"], "a\na\nb\nc\nc\n")
c("uniq_u", ["uniq", "-u"], "a\na\nb\nc\nc\n")
c("uniq_ignore_fields_chars", ["uniq", "-i", "-f1", "-s1"], "1 Xab\n2 xac\n3 yab\n")
c("uniq_w", ["uniq", "-w2", "-c"], "abc\nabd\nacd\n")
c("cut_fields", ["cut", "-d,", "-f2,4"], CSV)
c("cut_field_ranges_and_s", ["cut", "-d", " ", "-f2-", "-s"], "a b c\nnodelim\nx y\n")
c("cut_chars_bytes", ["cut", "-c1-3,5"], LINES)
c("cut_bytes_open_range", ["cut", "-b", "-2,8-"], LINES)
c("cut_complement_output_delim", ["cut", "-d,", "-f1,3", "--complement", "--output-delimiter=|"], CSV)
c("tr_ranges", ["tr", "a-z", "A-Z"], TEXT)
c("tr_delete_squeeze", ["tr", "-s", " "], "a   b    c\n")
c("tr_delete_complement", ["tr", "-cd", "[:alnum:]\\n"], TEXT)
c("tr_classes_and_repeat", ["tr", "[:lower:]", "[:upper:]"], "abc DEF\n")
c("tr_truncate_and_short_set2", ["tr", "abcd", "xy"], "abcdabcd\n")
c("tr_t_option", ["tr", "-t", "abcd", "xy"], "abcdabcd\n")
c("tr_escapes", ["tr", "\\n\\t", " _"], "a\tb\nc\n")
c("tr_squeeze_with_set2", ["tr", "-s", "a-z", "A-Z"], "aabbccdd zz\n")
c("wc_default_single", ["wc"], TEXT)
c("wc_options", ["wc", "-l", "-w", "-c", "-m", "-L"], TEXT)
c("wc_multiple_files", ["wc", "a.txt", "b.txt"], files=F)
c("wc_L_only", ["wc", "-L", "a.txt"], files=F)

# ---------------- head, tail
c("head_n", ["head", "-n", "3"], LINES)
c("head_negative", ["head", "-n", "-2"], LINES)
c("head_bytes", ["head", "-c", "10"], LINES)
c("head_multiple_files", ["head", "-n", "2", "a.txt", "b.txt"], files=F)
c("tail_n", ["tail", "-n", "2"], LINES)
c("tail_plus", ["tail", "-n", "+5"], LINES)
c("tail_bytes", ["tail", "-c", "12"], LINES)
c("tail_quiet_multiple", ["tail", "-q", "-n", "1", "a.txt", "b.txt"], files=F)

# ---------------- join, paste, comm
J1 = "1 ann eng\n2 bob ops\n4 dee hr\n5 eve eng\n"
J2 = "1 30\n2 25\n3 40\n5 28\n"
c("join_default", ["join", "j1", "j2"], files={"j1": J1, "j2": J2})
c("join_unpaired_and_empty", ["join", "-a1", "-a2", "-e", "NA", "-o", "auto", "j1", "j2"], files={"j1": J1, "j2": J2})
c("join_v_and_fields", ["join", "-v", "2", "j1", "j2"], files={"j1": J1, "j2": J2})
c("join_output_format", ["join", "-o", "2.2,1.2,0", "j1", "j2"], files={"j1": J1, "j2": J2})
c("join_separator_fields", ["join", "-t", ",", "-1", "2", "-2", "1", "x", "y"],
  files={"x": "1,a,p\n2,b,q\n", "y": "a,100\nb,200\nc,300\n"})
c("join_ignore_case", ["join", "-i", "x", "y"], files={"x": "A 1\nb 2\n", "y": "a x\nB y\n"})
c("paste_files", ["paste", "x", "y"], files={"x": "1\n2\n3\n", "y": "a\nb\n"})
c("paste_delims_cycle", ["paste", "-d", ",;", "x", "y", "x"], files={"x": "1\n2\n", "y": "a\nb\n"})
c("paste_serial", ["paste", "-s", "-d", "\\t,", "x"], files={"x": "1\n2\n3\n4\n"})
c("paste_stdin_columns", ["paste", "-", "-", "-"], "a\nb\nc\nd\ne\n")
c("comm_default", ["comm", "x", "y"], files={"x": "a\nb\nd\ne\n", "y": "b\nc\nd\nf\n"})
c("comm_suppress", ["comm", "-12", "x", "y"], files={"x": "a\nb\nd\ne\n", "y": "b\nc\nd\nf\n"})
c("comm_output_delimiter", ["comm", "--output-delimiter=|", "x", "y"], files={"x": "a\nb\n", "y": "b\nc\n"})

# ---------------- nl, fold, expand
c("nl_default", ["nl"], TEXT)
c("nl_all_and_format", ["nl", "-b", "a", "-n", "rz", "-w", "4", "-s", ": "], TEXT)
c("nl_ln_and_start_increment", ["nl", "-n", "ln", "-v", "10", "-i", "5"], LINES)
c("nl_regex_body", ["nl", "-b", "p^[a-c]"], LINES)
c("fold_width", ["fold", "-w", "12"], TEXT)
c("fold_spaces", ["fold", "-s", "-w", "15"], TEXT)
c("fold_bytes", ["fold", "-b", "-w", "5"], "tab\there and more\n")
c("expand_default", ["expand"], "a\tb\tc\n\tlead\n12345678\tx\n")
c("expand_tabs_list", ["expand", "-t", "4,10,12"], "a\tb\tc\td\te\n")
c("expand_initial", ["expand", "-i", "-t", "3"], "\t\tx\ty\n")

# ---------------- pipelines of behaviour across tools (single tool each, realistic data)
c("grep_count_multiple_files", ["grep", "-c", "e", "a.txt", "b.txt", "csv"], files=F)
c("sort_csv_by_dept_then_salary", ["sort", "-t,", "-k3,3", "-k4,4gr"], CSV)
c("sed_csv_reformat", ["sed", "-E", "1d;s/^([0-9]+),([^,]*),([^,]*),(.*)$/\\2 (\\3) earns \\4/"], CSV)
c("cut_and_tr_like", ["cut", "-c", "1-5,10-"], TEXT)
c("uniq_after_sorted_input", ["uniq", "-c"], "apple\napple\nbanana\ncherry\ncherry\n")
