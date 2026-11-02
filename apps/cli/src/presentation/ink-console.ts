import type { ActivityLine, Console, TranscriptRecord } from '@multiagentos/user-interaction';
import { ConsoleText } from '@multiagentos/user-interaction';
import { Box, Static, Text, render, useInput, type Instance } from 'ink';
import {
  createElement as h,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
} from 'react';
import { ConsoleStore } from './console-store.js';

type ConsoleInput = Pick<Console, 'submit' | 'interrupt' | 'withdrawLast'>;

const COLORS: Partial<Record<TranscriptRecord['kind'], string>> = {
  USER: 'cyan',
  STEP: 'gray',
  NOTICE: 'yellow',
  ERROR: 'red',
};

function Record({ record }: { readonly record: TranscriptRecord }): ReactElement {
  const prefix =
    record.kind === 'USER' ? '> ' : record.kind === 'REPLY' ? `${record.agentLabel}: ` : '';
  const color = COLORS[record.kind];
  return h(Text, color === undefined ? {} : { color }, `${prefix}${record.text}`);
}

function seconds(from: string, now: number): number {
  return Math.max(0, Math.round((now - Date.parse(from)) / 1000));
}

/** `重试中（第 n 次，x 秒后）` counts down; every other phase counts up (Module/UserInteraction 6). */
function Activity({
  line,
  now,
}: {
  readonly line: ActivityLine;
  readonly now: number;
}): ReactElement {
  const phase =
    line.retry === undefined
      ? [line.phase, line.tool, `${String(seconds(line.since, now))}s`]
      : [
          `${line.phase}（第 ${String(line.retry.attempt)} 次，${String(Math.max(0, Math.round((Date.parse(line.retry.retryAt) - now) / 1000)))} 秒后）`,
        ];
  return h(Text, { color: 'gray' }, `· ${line.label} ${phase.filter(Boolean).join(' ')}`);
}

function useClock(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  return now;
}

function ConsoleApp({
  store,
  input,
}: {
  readonly store: ConsoleStore;
  readonly input: ConsoleInput;
}): ReactElement {
  const { records, live, restored } = useSyncExternalStore(store.subscribe, store.snapshot);
  const [buffer, setBuffer] = useState('');
  const history = useRef<string[]>([]);
  const browsing = useRef<number | undefined>(undefined);
  const now = useClock(live.activity.length > 0);

  useEffect(() => {
    if (restored.messages.length > 0) setBuffer(restored.messages.join('\n'));
  }, [restored]);

  useInput((key, keys) => {
    if (keys.ctrl && key === 'c') {
      setBuffer('');
      void input.interrupt();
      return;
    }
    if (keys.return) {
      if (buffer.endsWith('\\')) {
        setBuffer(`${buffer.slice(0, -1)}\n`);
        return;
      }
      if (buffer.trim().length > 0) history.current.push(buffer);
      browsing.current = undefined;
      setBuffer('');
      void input.submit(buffer);
      return;
    }
    if (keys.escape) {
      // An empty box withdraws the last queued message instead (Module/UserInteraction 5.2).
      if (buffer.length === 0) input.withdrawLast();
      else setBuffer('');
      return;
    }
    if (keys.upArrow) {
      if (buffer.length === 0 && live.queued.length > 0) {
        setBuffer(input.withdrawLast() ?? '');
        return;
      }
      const index = (browsing.current ?? history.current.length) - 1;
      const entry = history.current[index];
      if (entry === undefined) return;
      browsing.current = index;
      setBuffer(entry);
      return;
    }
    if (keys.downArrow) {
      if (browsing.current === undefined) return;
      const index = browsing.current + 1;
      browsing.current = index < history.current.length ? index : undefined;
      setBuffer(history.current[index] ?? '');
      return;
    }
    if (keys.backspace || keys.delete) {
      setBuffer((current) => current.slice(0, -1));
      return;
    }
    if (keys.ctrl || keys.meta || keys.tab) return;
    setBuffer((current) => current + key);
  });

  const { pending } = live;
  return h(
    Box,
    { flexDirection: 'column' },
    h(Static<(typeof records)[number]>, {
      items: [...records],
      children: (record) => h(Record, { key: record.id, record }),
    }),
    ...live.activity.map((line) => h(Activity, { key: line.agentRunId, line, now })),
    pending === undefined
      ? null
      : h(
          Text,
          { color: 'yellow' },
          live.waiting > 0
            ? `${pending.text}（另有 ${String(live.waiting)} 项等待）`
            : pending.text,
        ),
    live.queued.length > 0
      ? h(Text, { color: 'gray' }, ConsoleText.queued(live.queued.length))
      : null,
    h(Text, null, `› ${buffer}`),
    h(
      Text,
      { color: 'gray' },
      [live.status, live.hint].filter((part) => part !== undefined && part.length > 0).join(' · '),
    ),
  );
}

export function consoleApp(store: ConsoleStore, input: ConsoleInput): ReactElement {
  return h(ConsoleApp, { store, input });
}

export interface InkConsole {
  readonly store: ConsoleStore;
  /** Draws the console and starts reading keys; Ctrl+C goes to the console, never to Ink. */
  mount(input: ConsoleInput): Instance;
}

export function createInkConsole(
  stdin: NodeJS.ReadStream = process.stdin,
  stdout: NodeJS.WriteStream = process.stdout,
): InkConsole {
  const store = new ConsoleStore();
  return {
    store,
    mount: (input) =>
      render(consoleApp(store, input), {
        stdin,
        stdout,
        exitOnCtrlC: false,
        patchConsole: false,
      }),
  };
}
