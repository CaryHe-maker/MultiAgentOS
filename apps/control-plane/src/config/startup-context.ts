import {
  ContextAssembleInputSchema,
  HandoffBriefSchema,
  canonicalJson,
  estimateItemTokens,
  estimatePackTokens,
  type ModelToolSpec,
  type PinnedDefinitionSet,
  type ProtocolRegistry,
} from '@multiagentos/contracts';
import { ConfigError } from './system-config.js';

// A control character takes six bytes in a JSON string (seven after a second encoding).
// Use the real estimator on worst-case contents rather than multiplying raw UTF-8 lengths.
const MAX_ESCAPED_CHARACTER = String.fromCharCode(1);
const STATUS_MAX_BYTES = 512;

function maximum(schema: object, keyword: 'maxLength' | 'maxItems'): number {
  // TypeBox keeps these options as runtime metadata, outside its static TString/TArray shape.
  const value = (schema as Readonly<Record<string, unknown>>)[keyword];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new ConfigError('fixed context input Schema needs a finite safe length bound');
  return value;
}

function fixedUserInputTokens(): number {
  const fields = HandoffBriefSchema.properties;
  const handoff = {
    task: MAX_ESCAPED_CHARACTER.repeat(maximum(fields.task, 'maxLength')),
    focusAreas: Array<string>(maximum(fields.focusAreas, 'maxItems')).fill(
      MAX_ESCAPED_CHARACTER.repeat(maximum(fields.focusAreas.items, 'maxLength')),
    ),
    openQuestions: Array<string>(maximum(fields.openQuestions, 'maxItems')).fill(
      MAX_ESCAPED_CHARACTER.repeat(maximum(fields.openQuestions.items, 'maxLength')),
    ),
  };
  // Reserve the full HANDOFF for every reachable Agent, including the entry Agent.
  return (
    estimateItemTokens({
      role: 'user',
      content: MAX_ESCAPED_CHARACTER.repeat(
        maximum(ContextAssembleInputSchema.properties.objective, 'maxLength'),
      ),
    }) +
    estimateItemTokens({ role: 'user', content: canonicalJson(handoff) }) +
    estimateItemTokens({ role: 'user', content: MAX_ESCAPED_CHARACTER.repeat(STATUS_MAX_BYTES) })
  );
}

/**
 * Bounds the non-trimmable input of ordinary and final calls (Monitor 4).
 * Uses the pinned prompt body and model-facing descriptions only. TOOLS has empty content;
 * its complete toolSpecs are counted once. HANDOFF is bounded by its canonical JSON form.
 */
export function estimateFixedInputs(
  pinned: PinnedDefinitionSet,
  registry: ProtocolRegistry,
): { readonly normal: number; readonly final: number } {
  const label = pinned.agent.id + '@' + pinned.agent.version;
  const specs = pinned.tools.map((tool): ModelToolSpec => {
    const schemaId = tool.parametersContract.id + '.' + tool.parametersContract.version;
    if (!registry.has(schemaId) || registry.get(schemaId).status !== 'SUPPORTED')
      throw new ConfigError('Agent ' + label + ' has an unsupported tool contract: ' + schemaId);
    return {
      name: tool.modelName,
      description: tool.modelDescription,
      parameters: registry.jsonSchemaOf(tool.parametersContract),
      purpose: tool.purpose,
    };
  });
  const finishRef = pinned.agent.actions.finish.toolRef;
  const finishIndex = pinned.tools.findIndex(
    (tool) =>
      tool.id === finishRef.id && tool.version === finishRef.version && tool.purpose === 'CONTROL',
  );
  const finish = specs[finishIndex];
  if (finish === undefined) throw new ConfigError('Agent ' + label + ' has no finish control tool');

  const userTokens = fixedUserInputTokens();
  const count = (toolSpecs: readonly ModelToolSpec[]): number =>
    userTokens +
    estimatePackTokens({
      items: [
        { role: 'system', content: pinned.prompt.template },
        { role: 'system', content: '', toolSpecs },
      ],
    });
  return { normal: count(specs), final: count([finish]) };
}
