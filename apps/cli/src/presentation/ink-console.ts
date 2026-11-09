import type { ActivityLine, Console, TranscriptRecord } from '@multiagentos/user-interaction';
import { ConsoleText, exceedsInputLimit } from '@multiagentos/user-interaction';
import {
  Box,
  Static,
  Text,
  render,
  useCursor,
  useInput,
  usePaste,
  useStdout,
  type Instance,
} from 'ink';
import {
  createElement as h,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
} from 'react';
import { ConsoleStore } from './console-store.js';
import { MARGIN, TAIL_SHARE, planTail, prefixOf, wrapLines } from './thinking-layout.js';
import {
  EMPTY_INPUT,
  backspace,
  boxHeight,
  deleteForward,
  deleteToLineEnd,
  deleteToLineStart,
  deleteWordBefore,
  expand,
  inputOf,
  insert,
  insertPaste,
  left,
  lineEnd,
  lineStart,
  moveVertical,
  right,
  viewBox,
  type BoxView,
  type InputState,
} from './text-input.js';

type ConsoleInput = Pick<Console, 'submit' | 'interrupt' | 'withdrawLast' | 'steer'>;

/** What the user typed: a soft green that stands out from everything the system says. */
export const USER_COLOR = '#7ee787';
/**
 * Everything the system says at its own level is yellow: its notices (a new conversation, opened,
 * allowed), what it asks (authorization, questions), what is waiting and the status line.
 */
export const SYSTEM_COLOR = '#F9F1A5';
/** The status line above the input box: a pink of its own, between dashes. */
export const STATUS_COLOR = '#ff79c6';
/** What an agent answers: a light blue. */
export const REPLY_COLOR = '#79c0ff';

const COLORS: Partial<Record<TranscriptRecord['kind'], string>> = {
  USER: USER_COLOR,
  REPLY: REPLY_COLOR,
  THINKING: 'gray',
  STEP: 'gray',
  NOTICE: SYSTEM_COLOR,
  LIST: 'gray',
  ERROR: 'red',
};

const PROMPT = '› ';
const CONTINUATION = '  ';

function Record({ record }: { readonly record: TranscriptRecord }): ReactElement {
  const prefix = prefixOf(record);
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

/**
 * Ink draws an empty line as no row at all, which would make the count of rows (and with it the
 * place of the cursor and what fits) wrong by one for every blank line: a blank line is a space.
 */
function row(line: string): string {
  return line.length === 0 ? ' ' : line;
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
    { color: 'gray', wrap: 'truncate-end' },
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

/**
 * The box drawn with a block where the cursor is: every row is one `Text` of its own, cut by
 * `layoutBox` exactly as Ink would cut the line (so nothing is cut again), and a side that has
 * more rows hidden has a `…` row (`viewBox`). The cursor is placed from the same rows.
 */
export function InputBox({ view }: { readonly view: BoxView }): ReactElement {
  const marker = (key: string): ReactElement =>
    h(Text, { key, color: 'gray', dimColor: true, wrap: 'truncate-end' }, `${CONTINUATION}…`);
  return h(
    Box,
    { flexDirection: 'column' },
    view.above ? marker('above') : null,
    ...view.rows.map((each, index) =>
      h(
        Text,
        { key: index, color: USER_COLOR, wrap: 'truncate-end' },
        each.lead,
        each.before,
        each.here ? h(Text, { inverse: true }, each.under) : '',
        each.after,
      ),
    ),
    view.below ? marker('below') : null,
  );
}

/** `lines` cut to `cap` rows: the first and the last ones stay, a `…` stands for the middle. */
function elide(lines: readonly string[], cap: number): string[] {
  if (lines.length <= cap) return [...lines];
  if (cap <= 1) return lines.slice(-1);
  const head = Math.ceil((cap - 1) / 2);
  const tail = Math.floor((cap - 1) / 2);
  return [...lines.slice(0, head), '…', ...lines.slice(lines.length - tail)];
}

function ConsoleApp({
  store,
  input,
}: {
  readonly store: ConsoleStore;
  readonly input: ConsoleInput;
}): ReactElement {
  const {
    static: written,
    tail,
    live,
    restored,
  } = useSyncExternalStore(store.subscribe, store.snapshot);
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
  const history = useRef<InputState[]>([]);
  const browsing = useRef<number | undefined>(undefined);
  /** What came back from the console as text is put in the box as the history entry it was. */
  const recall = (text: string): InputState => {
    const entry = [...history.current].reverse().find((each) => expand(each) === text);
    return entry === undefined ? inputOf(text) : { ...entry, cursor: entry.value.length };
  };
  // The first row of the box that is drawn, kept while the cursor is in the window.
  const viewTop = useRef(0);
  const open = tail.some((item) => item.kind === 'BLOCK' && item.block.state === 'OPEN');
  const now = useClock(live.activity.length > 0 || open);

  useEffect(() => {
    if (restored.messages.length > 0) setBox(recall(restored.messages.join('\n')));
  }, [restored]);

  // A paste arrives whole (bracketed paste): a long one is one placeholder in the box.
  usePaste((text) => {
    setBox(insertPaste(boxRef.current, text));
  });

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
      const text = expand(current);
      // Too long to send: the console says so, and what was typed stays where it is.
      if (exceedsInputLimit(text)) return void input.steer(text);
      if (text.trim().length > 0) history.current.push(current);
      browsing.current = undefined;
      setBox(EMPTY_INPUT);
      void input.steer(text);
      return;
    }
    if (keys.return) {
      // A backslash before the cursor is a line break that is not a send.
      if (current.value[current.cursor - 1] === '\\') {
        setBox(insert(backspace(current), '\n'));
        return;
      }
      const text = expand(current);
      if (exceedsInputLimit(text)) return void input.submit(text);
      if (text.trim().length > 0) history.current.push(current);
      browsing.current = undefined;
      setBox(EMPTY_INPUT);
      void input.submit(text);
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
          setBox(recall(input.withdrawLast() ?? ''));
          return;
        }
        const index = (browsing.current ?? history.current.length) - 1;
        const entry = history.current[index];
        if (entry === undefined) return;
        browsing.current = index;
        setBox({ ...entry, cursor: entry.value.length });
        return;
      }
      if (browsing.current === undefined) return;
      const index = browsing.current + 1;
      browsing.current = index < history.current.length ? index : undefined;
      const next = history.current[index];
      setBox(next === undefined ? EMPTY_INPUT : { ...next, cursor: next.value.length });
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
    setBox(
      key.length > 1 && /[\r\n]/u.test(key) ? insertPaste(current, key) : insert(current, key),
    );
  });

  const { pending } = live;
  const pendingText =
    pending === undefined
      ? undefined
      : live.waiting > 0
        ? `${pending.text}（另有 ${String(live.waiting)} 项等待）`
        : pending.text;
  // How full the context is, beside the status, whatever the status is.
  const share = live.context === undefined ? '' : ` (上下文已用${String(live.context)}%)`;
  const status = [live.status, live.hint]
    .filter((part) => part !== undefined && part.length > 0)
    .join(' · ');

  // Every line of the part drawn in place is one row (cut to the screen, or truncated), so the
  // rows can be counted. The frame must always be shorter than the terminal: a frame as tall as
  // the screen cannot be erased, and every redraw leaves a copy of it behind. So the box has a
  // height of its own (`boxHeight`), and what is drawn under the tail shares what is left.
  const view = viewBox(box, PROMPT, CONTINUATION, columns, boxHeight(rows), viewTop.current);
  viewTop.current = view.top;
  const wholeQuestion =
    pendingText === undefined
      ? []
      : pendingText.split('\n').flatMap((line) => wrapLines(line, Math.max(10, columns - MARGIN)));
  const fixedRows = view.shown + 1 + (live.queued.length > 0 ? 1 : 0);
  const spare = Math.max(2, rows - 2 - fixedRows);
  const questionLines = elide(
    wholeQuestion,
    Math.max(1, Math.min(wholeQuestion.length, spare - (live.activity.length > 0 ? 1 : 0))),
  );
  const activityRoom = Math.max(0, spare - questionLines.length);
  const activityShown =
    live.activity.length <= activityRoom
      ? live.activity
      : live.activity.slice(0, Math.max(0, activityRoom - 1));
  const activityMore = live.activity.length - activityShown.length;
  const below =
    activityShown.length +
    (activityMore > 0 ? 1 : 0) +
    questionLines.length +
    (live.queued.length > 0 ? 1 : 0) +
    1;
  const others = below + view.shown;
  const room = Math.max(1, rows - others - 3);
  // What is drawn in place keeps to 90% of that: the rest is slack against a miscount.
  const limit = Math.max(1, Math.floor(room * TAIL_SHARE));
  const plan = planTail(tail, { now, columns, limit, folded });
  // What does not fit goes into the scroll-back, so that a frame is never as tall as the
  // terminal: that would make the terminal library clear the screen and write it all again.
  const { commitBefore } = plan;
  const foldKey = plan.fold.join(',');
  const elidedKey = plan.elided.join(',');
  useEffect(() => {
    if (foldKey.length > 0) store.foldBlocks(foldKey.split(','));
    if (elidedKey.length > 0) store.markElided(elidedKey.split(','));
    if (commitBefore !== undefined) store.advanceFloor(commitBefore);
  }, [commitBefore, foldKey, elidedKey, store]);

  // The terminal cursor goes where the text is typed, so the input method opens its window there
  // and not below the status line: after the rows above the box, in the row and column of the text.
  setCursorPosition({ x: view.cursorColumn, y: plan.rows + below + view.cursorRow });

  return h(
    Box,
    { flexDirection: 'column' },
    h(Static<(typeof written)[number]>, {
      items: [...written],
      children: (item) =>
        item.kind === 'RECORD'
          ? h(Record, { key: item.id, record: item.record })
          : h(Text, { key: item.id, color: 'gray', dimColor: true }, item.text),
    }),
    h(
      Box,
      { flexDirection: 'column' },
      ...plan.items.flatMap((item): ReactElement[] =>
        item.kind === 'RECORD'
          ? item.lines.map((line, index) =>
              h(
                Text,
                {
                  key: `r${String(item.seq)}-${String(index)}`,
                  ...(COLORS[item.record.kind] === undefined
                    ? {}
                    : { color: COLORS[item.record.kind] }),
                  ...(item.record.kind === 'THINKING' ? { dimColor: true } : {}),
                  wrap: 'truncate-end',
                },
                row(line),
              ),
            )
          : item.lines.map((line, index) =>
              h(
                Text,
                {
                  key: `b${String(item.seq)}-${String(index)}`,
                  // Thinking is grey while it streams and after, like the rest of the status text.
                  color: 'gray',
                  ...(line.kind === 'BODY' ? { dimColor: true } : {}),
                  wrap: 'truncate-end',
                },
                row(line.text),
              ),
            ),
      ),
      ...activityShown.map((line) => h(Activity, { key: line.agentRunId, line, now })),
      activityMore > 0
        ? h(
            Text,
            { key: 'more', color: 'gray', wrap: 'truncate-end' },
            ConsoleText.moreActivities(activityMore),
          )
        : null,
      ...questionLines.map((line, index) =>
        h(Text, { key: `q${String(index)}`, color: SYSTEM_COLOR, wrap: 'truncate-end' }, row(line)),
      ),
      live.queued.length > 0
        ? h(
            Text,
            { color: SYSTEM_COLOR, wrap: 'truncate-end' },
            ConsoleText.queued(live.queued.length),
          )
        : null,
      h(
        Text,
        { color: STATUS_COLOR, wrap: 'truncate-end' },
        status.length > 0 ? `------ ${status}${share} ------` : ' ',
      ),
    ),
    h(InputBox, { view }),
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
        // A terminal is a terminal: Ink would otherwise draw only the last frame when the CI
        // variable is set, which leaves a person who has it set in their shell with a dead screen.
        interactive: Boolean(stdout.isTTY),
      }),
  };
}
