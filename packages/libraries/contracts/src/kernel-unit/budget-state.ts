import { Type, type Static } from 'typebox';

/** Advances only: NORMAL -> WRAP_UP -> EXHAUSTED. */
export const BudgetStateSchema = Type.Enum(['NORMAL', 'WRAP_UP', 'EXHAUSTED'], {
  $id: 'kernel.unit.BudgetState.v1',
});
export type BudgetState = Static<typeof BudgetStateSchema>;

/** The three ledgers of a report, each with its own state (M2Design 7.3). */
export const BudgetViewSchema = Type.Object(
  { agentRun: BudgetStateSchema, turn: BudgetStateSchema, run: BudgetStateSchema },
  { additionalProperties: false, $id: 'kernel.unit.BudgetView.v1' },
);
export type BudgetView = Static<typeof BudgetViewSchema>;

export const TurnUsageSchema = Type.Object(
  {
    inputTokens: Type.Integer({ minimum: 0 }),
    outputTokens: Type.Integer({ minimum: 0 }),
    /** Unknown consumption, counted at the reserved amount. */
    unknownTokens: Type.Integer({ minimum: 0 }),
    modelRequests: Type.Integer({ minimum: 0 }),
    toolUnits: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false, $id: 'kernel.unit.TurnUsage.v1' },
);
export type TurnUsage = Static<typeof TurnUsageSchema>;
