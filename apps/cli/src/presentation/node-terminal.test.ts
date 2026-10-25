import { PassThrough } from 'node:stream';
import { getEventListeners } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNodeTerminal } from './node-terminal.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.restoreAllMocks();
});

function fixture() {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks: string[] = [];
  output.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));
  const controller = new AbortController();
  cleanups.push(() => {
    controller.abort();
    input.destroy();
    output.destroy();
  });
  return { input, output, controller, chunks, terminal: createNodeTerminal(input, output) };
}

describe('Node terminal adapter', () => {
  it.each([
    ['y', 'YES'],
    ['YES', 'YES'],
    [' n ', 'NO'],
    ['No', 'NO'],
  ] as const)('accepts %s without leaking input or abort listeners', async (answer, expected) => {
    const test = fixture();
    const listeners = test.input.listenerCount('data');
    const result = test.terminal.askYesNo('允许读取？', test.controller.signal);
    test.input.write(answer + '\n');
    expect(await result).toBe(expected);
    expect(test.input.listenerCount('data')).toBe(listeners);
    expect(getEventListeners(test.controller.signal, 'abort')).toHaveLength(0);
  });

  it('asks again after invalid input and keeps prompts in Chinese', async () => {
    const test = fixture();
    const result = test.terminal.askYesNo('允许读取？', test.controller.signal);
    test.input.write('maybe\n');
    test.input.write('n\n');
    expect(await result).toBe('NO');
    expect(test.chunks.join('')).toContain('允许读取？');
  });

  it('does not acquire an input reader when already aborted', async () => {
    const test = fixture();
    test.controller.abort();
    expect(await test.terminal.askYesNo('允许读取？', test.controller.signal)).toBeUndefined();
    expect(test.input.listenerCount('data')).toBe(0);
    expect(test.chunks).toEqual([]);
  });

  it('aborts an unanswered question and releases its reader', async () => {
    const test = fixture();
    const result = test.terminal.askYesNo('允许读取？', test.controller.signal);
    test.controller.abort();
    expect(await result).toBeUndefined();
    expect(test.input.listenerCount('data')).toBe(0);
    expect(getEventListeners(test.controller.signal, 'abort')).toHaveLength(0);
  });

  it('ends without an answer on EOF instead of leaving a pending question', async () => {
    const test = fixture();
    let hasFinished = false;
    const result = test.terminal.askYesNo('允许读取？', test.controller.signal).then((answer) => {
      hasFinished = true;
      return answer;
    });
    test.input.end();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(hasFinished).toBe(true);
    expect(await result).toBeUndefined();
    expect(getEventListeners(test.controller.signal, 'abort')).toHaveLength(0);
  });

  it('does not open a reader for input that ended before the question', async () => {
    const test = fixture();
    test.input.resume();
    test.input.end();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(test.input.readableEnded).toBe(true);
    let hasFinished = false;
    const result = test.terminal.askYesNo('允许读取？', test.controller.signal).then((answer) => {
      hasFinished = true;
      return answer;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(hasFinished).toBe(true);
    expect(await result).toBeUndefined();
    expect(test.chunks).toEqual([]);
    expect(test.input.listenerCount('data')).toBe(0);
  });

  it('ends an unanswered question when input closes without an end event', async () => {
    const test = fixture();
    let hasFinished = false;
    const result = test.terminal.askYesNo('允许读取？', test.controller.signal).then((answer) => {
      hasFinished = true;
      return answer;
    });
    test.input.destroy();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(hasFinished).toBe(true);
    expect(await result).toBeUndefined();
    expect(getEventListeners(test.controller.signal, 'abort')).toHaveLength(0);
  });

  it('rejects an input failure that happened before the question', async () => {
    const test = fixture();
    test.input.once('error', () => {});
    test.input.destroy(new Error('Earlier input failure'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const result = test.terminal.askYesNo('允许读取？', test.controller.signal);
    const observed = expect(result).rejects.toThrow('Earlier input failure');
    // Make a broken implementation settle without waiting for its authorization deadline.
    await new Promise<void>((resolve) => setImmediate(resolve));
    test.controller.abort();
    await observed;
    expect(test.input.listenerCount('data')).toBe(0);
  });

  it('rejects a question when the output stream is already closed', async () => {
    const test = fixture();
    test.output.destroy();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const result = test.terminal.askYesNo('允许读取？', test.controller.signal);
    const observed = expect(result).rejects.toThrow('Terminal output is not writable');
    await new Promise<void>((resolve) => setImmediate(resolve));
    test.controller.abort();
    await observed;
    expect(test.input.listenerCount('data')).toBe(0);
  });

  it('rejects and releases the reader when output closes during a question', async () => {
    const test = fixture();
    const result = test.terminal.askYesNo('允许读取？', test.controller.signal);
    const observed = expect(result).rejects.toThrow('Terminal output closed during input');
    test.output.destroy();
    await new Promise<void>((resolve) => setImmediate(resolve));
    test.controller.abort();
    await observed;
    expect(test.input.listenerCount('data')).toBe(0);
    expect(getEventListeners(test.controller.signal, 'abort')).toHaveLength(0);
  });

  it('does not turn a terminal Ctrl+C into an authorization answer', async () => {
    const test = fixture();
    const result = test.terminal.askYesNo('允许读取？', test.controller.signal);
    test.input.write('\u0003');
    test.controller.abort();
    expect(await result).toBeUndefined();
  });

  it('observes reader failures so the interaction question boundary can report them', async () => {
    const test = fixture();
    const result = test.terminal.askYesNo('允许读取？', test.controller.signal);
    const observed = expect(result).rejects.toThrow('Input failed');
    test.input.emit('error', new Error('Input failed'));
    await observed;
  });

  it('observes output failures and releases the unanswered reader', async () => {
    const test = fixture();
    const result = test.terminal.askYesNo('允许读取？', test.controller.signal);
    const observed = expect(result).rejects.toThrow('Output failed');
    test.output.emit('error', new Error('Output failed'));
    await observed;
    expect(test.input.listenerCount('data')).toBe(0);
    expect(getEventListeners(test.controller.signal, 'abort')).toHaveLength(0);
  });

  it('releases the reader when writing the prompt throws synchronously', async () => {
    const test = fixture();
    vi.spyOn(test.output, 'write').mockImplementation(() => {
      throw new Error('Prompt failed');
    });
    await expect(test.terminal.askYesNo('允许读取？', test.controller.signal)).rejects.toThrow(
      'Prompt failed',
    );
    expect(test.input.listenerCount('data')).toBe(0);
    expect(getEventListeners(test.controller.signal, 'abort')).toHaveLength(0);
    expect(test.output.listenerCount('error')).toBe(0);
  });

  it('forwards SIGINT and removes only its own listener', () => {
    const test = fixture();
    const handlers = process.listeners('SIGINT');
    const handler = vi.fn();
    const remove = test.terminal.onInterrupt(handler);
    const added = process.listeners('SIGINT').filter((listener) => !handlers.includes(listener));
    expect(added).toHaveLength(1);
    added[0]?.('SIGINT');
    expect(handler).toHaveBeenCalledTimes(1);
    remove();
    remove();
    expect(process.listeners('SIGINT')).toEqual(handlers);
  });

  it('writes UTF-8 output without interpreting it', () => {
    const test = fixture();
    test.terminal.write('分析结果：已完成。\n');
    expect(test.chunks.join('')).toBe('分析结果：已完成。\n');
  });
});
