#!/usr/bin/env python3
"""Statistics of one finished mas run, from its saved data directory.

  python3 scripts/taskset/mas-analyze.py ~/bench/p3mas/results/<run-id>

Prints, per task: agent, start and end minute, rounds, minutes spent in model calls and in
commands; the root's segments; commands over 30 s; how many check commands each task ran (tests,
builds, comparisons) and how many of the root's checks repeat one a subtask already ran; the size of
the first request of the root and of one worker; wrap-ups, refusals and background jobs.
"""
import collections
import datetime
import glob
import json
import re
import sys

CHECK = re.compile(r'unittest|pytest|\bmake\b|npm (run )?test|cargo test|go test|diff|compare|cmp\b|\btest_', re.I)


def main(run_dir: str) -> None:
    log_path = glob.glob(run_dir + '/data/sessions/*/workflow/log.v1.jsonl')[0]
    log = [json.loads(line) for line in open(log_path)]
    t0 = datetime.datetime.fromisoformat(log[0]['at'].replace('Z', '+00:00'))

    def minute(at: str) -> float:
        return (datetime.datetime.fromisoformat(at.replace('Z', '+00:00')) - t0).total_seconds() / 60

    names = {}
    agents = {}
    for record in log:
        if record['type'] == 'GRAPH_EXTENDED':
            for node in record['nodes']:
                if node.get('mission'):
                    names[node['mission']['id']] = (node['name'], (node.get('agentRef') or {}).get('id', '?'))
    task_of = {}
    for record in log:
        if record['type'] == 'AGENT_RUN_REGISTERED':
            task_of[record['agentRunId']] = names.get(record.get('missionId'), ('?', '?'))
    root = log and next((name for name, agent in names.values()), None)

    span = {}
    rounds = collections.Counter()
    busy = collections.defaultdict(collections.Counter)
    submitted = {}
    commands = collections.defaultdict(list)
    long_commands = []
    for record in log:
        kind = record['type']
        if kind == 'AGENT_RUN_REGISTERED':
            name = task_of[record['agentRunId']][0]
            span.setdefault(name, [minute(record['at']), None])
        elif kind == 'AGENT_RUN_ENDED':
            name = task_of.get(record['agentRunId'], ('?',))[0]
            if name in span:
                span[name][1] = minute(record['at'])
        elif kind == 'UNIT_SUBMITTED':
            submitted[record['requestId']] = record
        elif kind == 'UNIT_COMPLETED' and record['requestId'] in submitted:
            unit = submitted[record['requestId']]
            name = task_of.get(unit['agentRunId'], ('?',))[0]
            seconds = (minute(record['at']) - minute(unit['at'])) * 60
            unit_id = unit['unitRef']['id']
            busy[name][unit_id] += seconds / 60
            if unit_id == 'model-call':
                rounds[name] += 1
            if unit_id == 'run-command':
                command = ((unit.get('inputSource') or {}).get('workflowFields') or {}).get('command', '')
                commands[name].append((minute(unit['at']), seconds, command))
                if seconds > 30:
                    long_commands.append((minute(unit['at']), name, seconds, command))

    total = minute(log[-1]['at'])
    print(f'run {total:.1f} min, {len(span)} tasks')
    print(f"{'task':16} {'agent':8} {'start':>6} {'end':>6} {'rounds':>6} {'model':>6} {'cmd':>5} {'checks':>6}")
    for name, (start, end) in sorted(span.items(), key=lambda item: item[1][0]):
        agent = next((a for n, a in names.values() if n == name), '?')
        checks = sum(1 for _, _, command in commands[name] if CHECK.search(command))
        print(f"{name:16} {agent:8} {start:6.1f} {(end or total):6.1f} {rounds[name]:6} "
              f"{busy[name]['model-call']:6.1f} {busy[name]['run-command']:5.1f} {checks:6}")

    # The root's checks that repeat a command a subtask already ran.
    root_name = next(iter(span)) if span else None
    if root_name is not None:
        others = {re.sub(r'\s+', ' ', c).strip() for n, cs in commands.items() if n != root_name for _, _, c in cs if CHECK.search(c)}
        mine = [re.sub(r'\s+', ' ', c).strip() for _, _, c in commands[root_name] if CHECK.search(c)]
        repeated = [c for c in mine if c in others]
        print(f'root checks {len(mine)}, of which repeat a subtask\'s check: {len(repeated)}')
        last_child_end = max((end or total) for name, (start, end) in span.items() if name != root_name) if len(span) > 1 else 0
        print(f'root alone after the last subtask ended: {total - last_child_end:.1f} min')

    print('commands over 30 s:')
    for start, name, seconds, command in long_commands:
        print(f'  {start:6.1f} {name:12} {seconds:4.0f}s {command.strip().splitlines()[-1][:100] if command.strip() else ""!r}')
    print('wrap-ups, refusals, jobs:')
    for record in log:
        kind = record['type']
        if kind in ('AGENT_WRAP_UP', 'JOB_STARTED', 'MODEL_ATTEMPT_FAILED') or (
            kind == 'FEEDBACK' and record.get('code') not in ('ASLEEP', 'SENT', 'STARTED', 'TASKS', 'TODOS_UPDATED', 'JOBS', 'JOB_OUTPUT', 'JOB_KILLED')):
            name = task_of.get(record.get('agentRunId'), (names.get(record.get('missionId'), ('',))[0],))[0]
            what = record.get('code') or record.get('reason') or record.get('reasonCode') or record.get('jobId', '')
            print(f"  {minute(record['at']):6.1f} {kind:20} {name:12} {what} {str(record.get('message', ''))[:110]!r}")

    profile = run_dir + '/request-profile.jsonl'
    try:
        first = json.loads(open(profile).readline())
        print(f"first request: system {first['byRole'].get('system', 0)} chars, user {first['byRole'].get('user', 0)}, tools {first['toolsChars']}")
    except OSError:
        pass


if __name__ == '__main__':
    main(sys.argv[1])
