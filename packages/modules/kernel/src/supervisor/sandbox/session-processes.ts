import { readdirSync, readFileSync } from 'node:fs';

/**
 * The processes of one session, for stopping an unisolated command whole (Orchestration D84).
 * Such a command starts as the leader of a session of its own (`detached`), but a signal to its
 * process group misses what moved to another group: `timeout`, for one, puts the program it runs
 * in a new group, so the program went on until its own limit, held the output pipe open, and the
 * stop was never confirmed. Every process keeps the session it was born in unless it calls
 * `setsid` itself, so the session holds all of the command. `bwrap` commands do not need this:
 * their PID namespace ends with them.
 */

/** The state and session of a process from the text of `/proc/<pid>/stat`, or undefined. */
export function statFields(
  text: string,
): { readonly state: string; readonly session: number } | undefined {
  // The name in parentheses may hold spaces and parentheses: the fields start after the last ")".
  const close = text.lastIndexOf(')');
  if (close < 0) return undefined;
  const fields = text
    .slice(close + 1)
    .trim()
    .split(/\s+/u);
  // state, ppid, pgrp, session, ...
  const state = fields[0];
  const session = Number(fields[3]);
  return state === undefined || !Number.isInteger(session) ? undefined : { state, session };
}

/**
 * The live processes whose session is `session`. A zombie is left out: it has ended, holds no
 * pipe, and only waits for a parent to collect it (in a container whose first process collects
 * nothing, it waits for ever).
 */
export function sessionMembers(session: number, proc = '/proc'): number[] {
  let names: string[];
  try {
    names = readdirSync(proc);
  } catch {
    return [];
  }
  const members: number[] = [];
  for (const name of names) {
    if (!/^\d+$/u.test(name)) continue;
    let text: string;
    try {
      text = readFileSync(`${proc}/${name}/stat`, 'utf8');
    } catch {
      continue; // Gone meanwhile.
    }
    const fields = statFields(text);
    if (fields !== undefined && fields.session === session && fields.state !== 'Z')
      members.push(Number(name));
  }
  return members;
}

/** Sends `signal` to every live process of the session, and to its group as before. */
export function signalSession(session: number, signal: NodeJS.Signals, proc = '/proc'): void {
  try {
    process.kill(-session, signal);
  } catch {
    // The group is gone, or never had other members.
  }
  for (const pid of sessionMembers(session, proc))
    try {
      process.kill(pid, signal);
    } catch {
      // Ended meanwhile.
    }
}
