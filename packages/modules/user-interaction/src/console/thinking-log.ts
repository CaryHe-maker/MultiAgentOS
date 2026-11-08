/**
 * What the model is thinking, kept for the person watching and nowhere else
 * (docs/M2/Phase1Console.md 4.2). It lives in the memory of the console process: it is not in the
 * Session log, not on disk, and nothing in the system reads it. Each model call makes one block,
 * numbered in the order they began (`/think <N>`); a block is cut at `THINKING_MAX_CHARS`, and the
 * oldest go when there are more than `THINKING_MAX_BLOCKS`. Switching to another Session or
 * leaving drops all of it. The complete thinking of a finished call is in the Session log
 * (`mas log` shows it); this is the preview that was there while the call ran.
 */

export const THINKING_MAX_CHARS = 64 * 1024;
export const THINKING_MAX_BLOCKS = 100;

export type ThinkingState = 'OPEN' | 'DONE' | 'ABORTED';

export interface ThinkingBlock {
  /** 1 for the first block of the Session in view, then upwards. */
  readonly number: number;
  readonly callId: string;
  readonly agentRunId: string;
  readonly label: string;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly text: string;
  /** The block reached its size limit and the rest was left out. */
  readonly cut: boolean;
  readonly state: ThinkingState;
}

interface MutableBlock {
  number: number;
  callId: string;
  agentRunId: string;
  label: string;
  startedAt: string;
  endedAt?: string;
  text: string;
  cut: boolean;
  state: ThinkingState;
}

export class ThinkingLog {
  readonly #blocks: MutableBlock[] = [];
  #next = 1;

  /** Adds a piece to the block of `callId`, which this opens when it is the first. */
  append(
    call: {
      readonly callId: string;
      readonly agentRunId: string;
      readonly label: string;
    },
    delta: string,
    at: string,
  ): void {
    let block = this.#blocks.find((candidate) => candidate.callId === call.callId);
    if (block === undefined) {
      block = { ...call, number: this.#next, startedAt: at, text: '', cut: false, state: 'OPEN' };
      this.#next += 1;
      this.#blocks.push(block);
      if (this.#blocks.length > THINKING_MAX_BLOCKS) this.#blocks.shift();
    }
    if (block.state !== 'OPEN') return;
    const room = THINKING_MAX_CHARS - block.text.length;
    if (delta.length > room) {
      block.text += delta.slice(0, Math.max(0, room));
      block.cut = true;
    } else block.text += delta;
  }

  /** The stream of `callId` ended. */
  end(callId: string, at: string, state: ThinkingState = 'DONE'): void {
    const block = this.#blocks.find((candidate) => candidate.callId === callId);
    if (block === undefined || block.state !== 'OPEN') return;
    block.state = state;
    block.endedAt = at;
  }

  /** Nothing is running any more, or the run was cut off: no block stays open. */
  closeAll(at: string, state: ThinkingState): void {
    for (const block of this.#blocks)
      if (block.state === 'OPEN') {
        block.state = state;
        block.endedAt = at;
      }
  }

  blocks(): readonly ThinkingBlock[] {
    return this.#blocks;
  }

  /** The block with this number, while it is still kept. */
  byNumber(number: number): ThinkingBlock | undefined {
    return this.#blocks.find((block) => block.number === number);
  }

  clear(): void {
    this.#blocks.length = 0;
    this.#next = 1;
  }
}
