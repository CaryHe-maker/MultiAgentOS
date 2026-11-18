#!/usr/bin/env python3
"""Live view of one mas run started by mas-live.sh (or mas-run.sh), refreshed every few seconds.

    python3 scripts/taskset/mas-watch.py tu-k4 [--every 15]

It reads the Session log inside the run's container while it runs, the model requests the usage
proxy counted, and, once the run has ended, the record and the verifier's result. It only reads.
Ctrl-C leaves it; the run goes on.
"""
import argparse
import datetime as dt
import glob
import json
import os
import subprocess
import sys
import time

HOME = os.path.expanduser('~')
BENCH = os.path.join(HOME, 'bench')
# DeepSeek, USD per million tokens (the price table of the M2 runs).
PRICE = {'hit': 0.003, 'miss': 0.15, 'out': 0.60}
ERRORS = {
    'INVALID_ARGUMENTS', 'CONTROL_ARGUMENTS_INVALID', 'TOOL_INPUT_REFUSED', 'UNKNOWN_TOOL',
    'INVALID_ACTION', 'OUTPUT_TRUNCATED', 'TOO_MANY_TOOL_CALLS', 'CONTROL_MIXED', 'SLEEP_REFUSED',
}
SENT_BACK = {'NOT_VERIFIED', 'RESULT_INCOMPLETE', 'PLAYBOOK_UNFINISHED', 'TESTER_AFTER_BUILD', 'PLAN_REQUIRED'}


def parse(at):
    return dt.datetime.fromisoformat(at.replace('Z', '+00:00'))


class DockerSilent(Exception):
    """Docker did not answer in time: the run's state is unknown, not 'not started'."""


def docker(args, timeout=15):
    try:
        return subprocess.run(['docker', *args], capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired as error:
        raise DockerSilent() from error


def container(label):
    done = docker(['ps', '--format', '{{.Names}}', '-f', f'name=ar-{label}-mas-'])
    if done.returncode != 0:
        raise DockerSilent()
    out = done.stdout.split()
    return out[0] if out else None


def live_log(name):
    cmd = 'cat /tmp/mas-bench-data-*/sessions/*/workflow/log.v1.jsonl 2>/dev/null'
    text = docker(['exec', name, 'sh', '-c', cmd], timeout=20).stdout
    lines = []
    for line in text.splitlines():
        try:
            lines.append(json.loads(line))
        except ValueError:
            pass  # the last line may be half written
    return lines


def ended_log(label):
    files = sorted(glob.glob(os.path.join(BENCH, 'p3mas', 'results', f'{label}-mas-*', 'session-log.jsonl')))
    if not files:
        return [], None
    return [json.loads(line) for line in open(files[-1]) if line.strip()], os.path.dirname(files[-1])


def usage(label):
    files = sorted(glob.glob(os.path.join(BENCH, 'usage', f'{label}-mas-*.jsonl')))
    n = hit = miss = out = reasoning = 0
    if files:
        for line in open(files[-1]):
            u = (json.loads(line).get('usage') or {})
            n += 1
            hit += u.get('prompt_cache_hit_tokens', 0)
            miss += u.get('prompt_cache_miss_tokens', 0)
            out += u.get('completion_tokens', 0)
            reasoning += (u.get('completion_tokens_details') or {}).get('reasoning_tokens', 0)
    cost = (hit * PRICE['hit'] + miss * PRICE['miss'] + out * PRICE['out']) / 1e6
    return n, cost, out, reasoning


def render(label, log, ended, result_dir):
    if not log:
        return f'{label}: waiting for the run to start (the build comes first)...'
    t0 = parse(next(r['at'] for r in log if 'at' in r))
    now = parse(log[-1].get('at') or log[-2]['at']) if ended else dt.datetime.now(dt.timezone.utc)
    minute = lambda at: (parse(at) - t0).total_seconds() / 60
    name_of, run_node, agent_of, inherits, started, finished, status = {}, {}, {}, {}, {}, {}, {}
    rounds, last_tool, last_at, asleep = {}, {}, {}, {}
    for r in log:
        kind = r.get('type')
        if kind == 'GRAPH_EXTENDED':
            for n in r['nodes']:
                name_of[n['nodeId']] = n['name']
                # A task that inherits runs as its caller's Agent; it is the one its phase names (D90).
                inherited = ((n.get('spawn') or {}).get('inherits') or {}).get('as')
                agent_of.setdefault(n['name'], inherited or (n.get('agentRef') or {}).get('id', ''))
                if n.get('spawn') and n['spawn'].get('inherits'):
                    inherits[n['name']] = True
        elif kind == 'AGENT_RUN_REGISTERED':
            run_node[r['agentRunId']] = r['nodeId']
        elif kind == 'NODE_STARTED':
            started.setdefault(name_of.get(r['nodeId'], '?'), minute(r['at']))
        elif kind == 'NODE_ENDED':
            n = name_of.get(r['nodeId'], '?')
            status[n] = r.get('status')
            if r.get('status') != 'YIELDED':
                finished[n] = minute(r['at'])
        elif kind == 'MODEL_TURN':
            n = name_of.get(run_node.get(r['agentRunId']), '?')
            rounds[n] = rounds.get(n, 0) + 1
            last_tool[n] = ','.join(c['toolName'] for c in r.get('toolCalls') or []) or '(text)'
            last_at[n] = minute(r['at'])
            asleep[n] = 'sleep' in last_tool[n]
    errors, sent_back = {}, {}
    for r in log:
        if r.get('type') == 'FEEDBACK':
            if r.get('code') in ERRORS:
                errors[r['code']] = errors.get(r['code'], 0) + 1
            if r.get('code') in SENT_BACK:
                sent_back[r['code']] = sent_back.get(r['code'], 0) + 1
    messages = [r for r in log if r.get('type') == 'MISSION_MESSAGE']
    n, cost, out, reasoning = usage(label)
    elapsed = (now - t0).total_seconds() / 60
    lines = [
        f'{label}   {"ENDED" if ended else "running"}   {elapsed:5.1f} min   '
        f'requests {n}   cost ${cost:.2f}   output {out / 1000:.0f}k (thinking {100 * reasoning / max(out, 1):.0f}%)',
        '',
        f'{"task":24s} {"agent":8s} {"ctx":4s} {"start":>6s} {"end":>6s} {"rounds":>6s}  now',
    ]
    order = sorted(rounds.keys() | started.keys(), key=lambda x: (started.get(x, 0), x))
    for t in order:
        if t in ('prompt', '?'):
            continue
        end = finished.get(t)
        if end is not None:
            now_doing = f'{(status.get(t) or "").lower()}'
        elif asleep.get(t):
            now_doing = 'waiting'
        else:
            ago = elapsed - last_at.get(t, elapsed)
            now_doing = f'{last_tool.get(t, "starting")} ({ago:.1f} min ago)'
        lines.append(
            f'{t[:24]:24s} {agent_of.get(t, "")[:8]:8s} {"yes" if inherits.get(t) else "":4s} '
            f'{started.get(t, 0):6.1f} {"" if end is None else f"{end:6.1f}":>6s} {rounds.get(t, 0):6d}  {now_doing[:60]}'
        )
    lines += ['', f'tool-call errors: {sum(errors.values())} {errors or ""}',
              f'sent back to the task: {sent_back or "none"}',
              f'messages between tasks: {len(messages)}']
    for m in messages[-3:]:
        said = (m.get('summary') or m.get('text') or '').replace('\n', ' ')
        lines.append(f'  {minute(m["at"]):5.1f}  {m.get("fromLabel")} -> {len(m["to"])} task(s): {said[:90]}')
    if ended and result_dir:
        record = os.path.join(BENCH, 'p3mas', f'{label}.jsonl')
        if os.path.exists(record):
            j = json.loads(open(record).read().strip().splitlines()[-1])
            lines += ['', f'RESULT  reward {j.get("reward")}   agent {j.get("agentSeconds", 0) / 60:.1f} min   '
                          f'cost ${j.get("costUsd") or 0:.2f}   outcome {j.get("outcome")}',
                      f'kept in {result_dir}']
    return '\n'.join(lines)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('label')
    ap.add_argument('--every', type=float, default=15)
    ap.add_argument('--once', action='store_true')
    a = ap.parse_args()
    try:
        while True:
            try:
                name = container(a.label)
                if name is not None:
                    text, done = render(a.label, live_log(name), False, None), False
                else:
                    log, where = ended_log(a.label)
                    text, done = render(a.label, log, bool(log), where), bool(log)
            except DockerSilent:
                text, done = (f'{a.label}: Docker does not answer ({time.strftime("%H:%M:%S")}); '
                              'the run may be stuck. Check Docker Desktop.'), False
            sys.stdout.write('\033[H\033[2J' + text + '\n')
            sys.stdout.flush()
            if done or a.once:
                return
            time.sleep(a.every)
    except KeyboardInterrupt:
        return


if __name__ == '__main__':
    main()
