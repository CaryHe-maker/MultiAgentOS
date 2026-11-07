import type { ActivityLine, Console, TranscriptRecord } from '@multiagentos/user-interaction';
import { ConsoleText } from '@multiagentos/user-interaction';
import {
  Box,
  Static,
  Text,
  measureElement,
  render,
  useCursor,
  useInput,
  useStdout,
  type DOMElement,
  type Instance,
} from 'ink';
import {
  createElement as h,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
} from 'react';
import { ConsoleStore } from './console-store.js';
import { layoutThinking } from './thinking-layout.js';
import {
  EMPTY_INPUT,
  backspace,
  boxRows,
  cursorCell,
  deleteForward,
  deleteToLineEnd,
  deleteToLineStart,
  deleteWordBefore,
  inputOf,
  insert,
  left,
  lineEnd,
  lineStart,
  moveVertical,
  right,
  rowsOf,
  displayWidth,
  type InputState,
} from './text-input.js';

type ConsoleInput = Pick<Console, 'submit' | 'interrupt' | 'withdrawLast' | 'steer'>;

/** What the user typed: a bright green that stands out from everything the system says. */
export const USER_COLOR = '#39ff14';
const REPLY_COLOR = 'blueBright';

const COLORS: Partial<Record<TranscriptRecord['kind'], string>> = {
  USER: USER_COLOR,
  REPLY: REPLY_COLOR,
  THINKING: 'gray',
  STEP: 'gray',
  NOTICE: 'yellow',
  ERROR: 'red',
};

const PROMPT = '› ';
const CONTINUATION = '  ';

function Record({ record }: { readonly record: TranscriptRecord }): ReactElement {
  const prefix =
    record.kind === 'USER' ? '> ' : record.kind === 'REPLY' ? `${record.agentLabel}: ` : '';
  const color = COLORS[record.kind];
  return h(
    Text,
    {
      ...(color === undefined ? {} : { color }),
      ...(record.kind === 'THINKING' ? { dimColor: true } : {}),
    },
    `${prefix}${record.text}`,
  );
}

function seconds(from: string, now: number): number {
  return Math.max(0, Math.round((now - Date.parse(from)) / 1000));
}

/**
 * `重试中（第 n 次，x 秒后）` counts down; the other phases count up while the system works. A run
 * that waits for the user shows no seconds at all: nothing is taking long, and a counter there
 * only reads as being hurried (docs/M2/Phase1Console.md 2.1, UI-3).
 */
function Activity({
  line,
  now,
}: {
  readonly line: ActivityLine;
  readonly now: number;
}): ReactElement {
  const phase =
    line.retry !== undefined
      ? [
          `${line.phase}（第 ${String(line.retry.attempt)} 次，${String(Math.max(0, Math.round((Date.parse(line.retry.retryAt) - now) / 1000)))} 秒后）`,
        ]
      : line.waitsForUser === true
        ? [line.phase, line.tool]
        : [line.phase, line.tool, `${String(seconds(line.since, now))}s`];
  return h(
    Text,
    { color: 'gray' },
    `${line.branch ?? ''}· ${line.label} ${phase.filter(Boolean).join(' ')}`,
  );
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

/** The box drawn with a block where the cursor is, line by line. */
function InputBox({ state }: { readonly state: InputState }): ReactElement {
  const lines = state.value.split('\n');
  let offset = 0;
  return h(
    Box,
    { flexDirection: 'column' },
    ...lines.map((line, index) => {
      const start = offset;
      offset += line.length + 1;
      const prefix = index === 0 ? PROMPT : CONTINUATION;
      const here = state.cursor >= start && state.cursor <= start + line.length;
      if (!here) return h(Text, { key: index, color: USER_COLOR }, `${prefix}${line}`);
      const column = state.cursor - start;
      const under = [...line.slice(column)][0];
      return h(
        Text,
        { key: index, color: USER_COLOR },
        prefix,
        line.slice(0, column),
        h(Text, { inverse: true }, under ?? ' '),
        under === undefined ? '' : line.slice(column + under.length),
      );
    }),
  );
}

function ConsoleApp({
  store,
  input,
}: {
  readonly store: ConsoleStore;
  readonly input: ConsoleInput;
}): ReactElement {
  const { records, live, restored } = useSyncExternalStore(store.subscribe, store.snapshot);
  const { stdout } = useStdout();
  const { setCursorPosition } = useCursor();
  // Not every stream has a size (a pipe, a test); a plain terminal is the fallback.
  const size = stdout as { readonly columns?: number; readonly rows?: number };
  const columns = size.columns !== undefined && size.columns > 0 ? size.columns : 80;
  const rows = size.rows !== undefined && size.rows > 0 ? size.rows : 24;

  const [box, setBoxState] = useState<InputState>(EMPTY_INPUT);
  // Keys arrive faster than React renders: the latest state is read from here.
  const boxRef = useRef<InputState>(EMPTY_INPUT);
  const setBox = (next: InputState): void => {
    boxRef.current = next;
    setBoxState(next);
  };
  const [folded, setFolded] = useState(false);
  const history = useRef<string[]>([]);
  const browsing = useRef<number | undefined>(undefined);
  const thinking = live.thinking ?? [];
  const now = useClock(
    live.activity.length > 0 || thinking.some((block) => block.state === 'OPEN'),
  );

  useEffect(() => {
    if (restored.messages.length > 0) setBox(inputOf(restored.messages.join('\n')));
  }, [restored]);

  useInput((key, keys) => {
    const current = boxRef.current;
    if (keys.ctrl && key === 'c') {
      setBox(EMPTY_INPUT);
      void input.interrupt();
      return;
    }
    if (keys.ctrl && key === 'o') {
      setFolded((value) => !value);
      return;
    }
    // Alt+Enter sends the box as a note to the run that goes on, instead of queueing it (5.4).
    if (keys.return && keys.meta) {
      if (current.value.trim().length > 0) history.current.push(current.value);
      browsing.current = undefined;
      setBox(EMPTY_INPUT);
      void input.steer(current.value);
      return;
    }
    if (keys.return) {
      // A backslash before the cursor is a line break that is not a send.
      if (current.value[current.cursor - 1] === '\\') {
        setBox(insert(backspace(current), '\n'));
        return;
      }
      if (current.value.trim().length > 0) history.current.push(current.value);
      browsing.current = undefined;
      setBox(EMPTY_INPUT);
      void input.submit(current.value);
      return;
    }
    if (keys.escape) {
      // An empty box withdraws the last queued message instead (Module/UserInteraction 5.2).
      if (current.value.length === 0) input.withdrawLast();
      else setBox(EMPTY_INPUT);
      return;
    }
    if (keys.upArrow || keys.downArrow) {
      // Inside a box of several lines the arrows move through the lines first.
      const moved = moveVertical(current, keys.upArrow ? -1 : 1);
      if (moved !== undefined) {
        setBox(moved);
        return;
      }
      if (keys.upArrow) {
        if (current.value.length === 0 && live.queued.length > 0) {
          setBox(inputOf(input.withdrawLast() ?? ''));
          return;
        }
        const index = (browsing.current ?? history.current.length) - 1;
        const entry = history.current[index];
        if (entry === undefined) return;
        browsing.current = index;
        setBox(inputOf(entry));
        return;
      }
      if (browsing.current === undefined) return;
      const index = browsing.current + 1;
      browsing.current = index < history.current.length ? index : undefined;
      setBox(inputOf(history.current[index] ?? ''));
      return;
    }
    if (keys.leftArrow) return void setBox(left(current));
    if (keys.rightArrow) return void setBox(right(current));
    if (keys.home) return void setBox(lineStart(current));
    if (keys.end) return void setBox(lineEnd(current));
    if (keys.backspace) return void setBox(backspace(current));
    if (keys.delete) return void setBox(deleteForward(current));
    if (keys.ctrl) {
      if (key === 'a') setBox(lineStart(current));
      else if (key === 'e') setBox(lineEnd(current));
      else if (key === 'u') setBox(deleteToLineStart(current));
      else if (key === 'k') setBox(deleteToLineEnd(current));
      else if (key === 'w') setBox(deleteWordBefore(current));
      return;
    }
    if (keys.meta || keys.tab) return;
    setBox(insert(current, key));
  });

  const { pending } = live;
  const pendingText =
    pending === undefined
      ? undefined
      : live.waiting > 0
        ? `${pending.text}（另有 ${String(live.waiting)} 项等待）`
        : pending.text;
  const status = [live.status, live.hint]
    .filter((part) => part !== undefined && part.length > 0)
    .join(' · ');

  // What the thinking may take: what is left of the screen after the rest of the live area.
  const others =
    live.activity.length +
    (pendingText === undefined
      ? 0
      : pendingText
          .split('\n')
          .reduce((sum, line) => sum + rowsOf(displayWidth(line), columns), 0)) +
    (live.queued.length > 0 ? 1 : 0) +
    1 +
    boxRows(box, PROMPT, CONTINUATION, columns);
  const thinkingLines = layoutThinking(thinking, {
    now,
    columns,
    budget: Math.max(4, rows - others - 2),
    folded,
  });

  // The terminal cursor goes where the text is typed, so the input method opens its window there
  // and not below the status line. The rows above the box are measured after they are laid out.
  const above = useRef<DOMElement | null>(null);
  const [aboveRows, setAboveRows] = useState(0);
  useLayoutEffect(() => {
    const measured = above.current === null ? 0 : measureElement(above.current).height;
    if (measured !== aboveRows) setAboveRows(measured);
  });
  const cell = cursorCell(box, PROMPT, CONTINUATION, columns);
  setCursorPosition({ x: cell.column, y: aboveRows + cell.row });

  return h(
    Box,
    { flexDirection: 'column' },
    h(Static<(typeof records)[number]>, {
      items: [...records],
      children: (record) => h(Record, { key: record.id, record }),
    }),
    h(
      Box,
      { flexDirection: 'column', ref: above },
      ...live.activity.map((line) => h(Activity, { key: line.agentRunId, line, now })),
      ...thinkingLines.map((line, index) =>
        h(
          Text,
          {
            key: `t${String(index)}`,
            color: line.kind === 'HEADER' && line.live ? 'magentaBright' : 'gray',
            ...(line.kind === 'BODY' ? { dimColor: true } : {}),
            wrap: 'truncate-end',
          },
          line.text,
        ),
      ),
      pendingText === undefined ? null : h(Text, { color: 'yellow' }, pendingText),
      live.queued.length > 0
        ? h(Text, { color: 'gray' }, ConsoleText.queued(live.queued.length))
        : null,
      h(Text, { color: 'gray' }, status.length > 0 ? status : ' '),
    ),
    h(InputBox, { state: box }),
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
