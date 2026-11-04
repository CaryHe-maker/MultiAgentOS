import type { AssembleContextPack, ModelToolSpec } from '@multiagentos/contracts';
import type { LanguageModel } from './language-model.js';

type CallOptions = Parameters<LanguageModel['doGenerate']>[0];
type Prompt = CallOptions['prompt'];
type PackItems = Pick<AssembleContextPack, 'items'>;
type Message = Prompt[number];
type Tools = NonNullable<CallOptions['tools']>;

/**
 * The provider request of ExecutorSet 7: INSTRUCTIONS become the system message, TOOLS the tool
 * parameter, and every other item a message of its role, in pack order. The mapping is purely
 * structural; what a tool means is Workflow's business.
 */
export function toPrompt(pack: PackItems): Prompt {
  const toolNames = new Map<string, string>();
  const messages: Message[] = [];
  for (const item of pack.items) {
    switch (item.role) {
      case 'system':
        if (item.segment === 'INSTRUCTIONS')
          messages.push({ role: 'system', content: item.content });
        break;
      case 'user':
        messages.push({ role: 'user', content: [{ type: 'text', text: item.content }] });
        break;
      case 'assistant': {
        const calls = 'toolCalls' in item ? (item.toolCalls ?? []) : [];
        for (const call of calls) toolNames.set(call.toolCallId, call.toolName);
        messages.push({
          role: 'assistant',
          content: [
            ...(item.content.length > 0 ? [{ type: 'text' as const, text: item.content }] : []),
            ...calls.map((call) => ({
              type: 'tool-call' as const,
              toolCallId: call.toolCallId,
              toolName: call.toolName,
              // Arguments that could not be parsed are replayed as an empty object; the
              // feedback item that follows tells the model what was wrong.
              input: call.arguments ?? {},
            })),
          ],
        });
        break;
      }
      case 'tool':
        messages.push({
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: item.toolCallId,
              toolName: toolNames.get(item.toolCallId) ?? 'unknown',
              output: { type: 'text', value: item.content },
            },
          ],
        });
        break;
    }
  }
  return messages;
}

export function toolSpecsOf(pack: PackItems): readonly ModelToolSpec[] {
  return pack.items.flatMap((item) => (item.segment === 'TOOLS' ? item.toolSpecs : []));
}

export function toTools(specs: readonly ModelToolSpec[]): Tools {
  return specs.map((spec) => ({
    type: 'function' as const,
    name: spec.name,
    description: spec.description,
    inputSchema: spec.parameters as Tools[number] extends { inputSchema: infer S } ? S : never,
  }));
}
