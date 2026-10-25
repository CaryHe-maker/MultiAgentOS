import { Type, type Static } from 'typebox';

/** Advances only: NORMAL -> WRAP_UP -> EXHAUSTED (docs/M1/Kernel/Monitor.md 3.2). */
export const BudgetStateSchema = Type.Enum(['NORMAL', 'WRAP_UP', 'EXHAUSTED'], {
  $id: 'kernel.unit.BudgetState.v0',
});
export type BudgetState = Static<typeof BudgetStateSchema>;
