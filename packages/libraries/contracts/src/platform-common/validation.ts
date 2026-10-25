import type { TSchema } from 'typebox';
import { Compile } from 'typebox/compile';
import type { ModuleError } from './common-schemas.js';

export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly string[] };

type Validator = ReturnType<typeof Compile>;
// Schemas are module-level constants, so compiling each one once is enough.
const validators = new WeakMap<TSchema, Validator>();

function validatorOf(schema: TSchema): Validator {
  let validator = validators.get(schema);
  if (validator === undefined) {
    validator = Compile(schema);
    validators.set(schema, validator);
  }
  return validator;
}

export function validate<T>(schema: TSchema, value: unknown): ValidationResult<T> {
  const validator = validatorOf(schema);
  if (validator.Check(value)) return { ok: true, value: value as T };
  return {
    ok: false,
    issues: [...validator.Errors(value)].map(
      (error) => `${error.instancePath || '/'} ${error.message}`,
    ),
  };
}
export function assertValid<T>(schema: TSchema, value: unknown): T {
  const result = validate<T>(schema, value);
  if (!result.ok) throw new ContractValidationError(result.issues);
  return result.value;
}
export class ContractValidationError extends Error {
  public readonly issues: readonly string[];
  public constructor(issues: readonly string[]) {
    super(`Contract validation failed: ${issues.join('; ')}`);
    this.name = 'ContractValidationError';
    this.issues = issues;
  }
}
/** Builds the `UNSUPPORTED_CAPABILITY` error of a capability M1 does not implement. */
export function unsupported(
  capability: string,
  schemaName: string,
  correlationId: string,
): ModuleError {
  return {
    code: 'UNSUPPORTED_CAPABILITY',
    category: 'CONTRACT',
    message: `${capability} is not supported for ${schemaName}`,
    retryable: false,
    correlationId,
  };
}
