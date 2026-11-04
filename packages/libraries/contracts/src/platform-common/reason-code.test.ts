import { describe, expect, it } from 'vitest';
import { ErrorCategorySchema } from './common-schemas.js';
import {
  REASON_CODES,
  REASON_CODE_CATEGORY,
  ReasonCodeSchema,
  SYSCALL_REJECTED_CODES,
  UNIT_REPORT_CODES,
} from './reason-code.js';
import { validate } from './validation.js';

describe('reason codes', () => {
  it('lists each code once, with one valid category', () => {
    expect(new Set(REASON_CODES).size).toBe(REASON_CODES.length);
    for (const code of REASON_CODES) {
      expect(validate(ReasonCodeSchema, code).ok).toBe(true);
      expect(validate(ErrorCategorySchema, REASON_CODE_CATEGORY[code]).ok).toBe(true);
    }
    expect(validate(ReasonCodeSchema, 'NOT_A_CODE').ok).toBe(false);
  });

  it('keeps the SyscallRejected and UnitReport subsets inside the enumeration', () => {
    for (const code of [...SYSCALL_REJECTED_CODES, ...UNIT_REPORT_CODES])
      expect(REASON_CODES).toContain(code);
  });
});
