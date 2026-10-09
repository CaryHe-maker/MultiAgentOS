import { Type, type Static } from 'typebox';
import { ArtifactRefSchema } from '../platform-common/common-schemas.js';
import { IdSchemas } from '../platform-common/ids.js';
import {
  CORE_REJECTED_CODES,
  GATEWAY_REJECTED_CODES,
  reasonCodeOf,
} from '../platform-common/reason-code.js';
import { closed } from '../platform-common/schema-helpers.js';
import { CloseReasonSchema } from './run-outcome.js';

export const SyscallAckSchema = closed(
  { requestId: IdSchemas.requestId, outcome: Type.Literal('ACCEPTED') },
  'kernel.control.SyscallAck.v0',
);
export type SyscallAck = Static<typeof SyscallAckSchema>;

const rejected = { requestId: IdSchemas.requestId, outcome: Type.Literal('REJECTED') };
/**
 * Each issuer may only use its own reason codes (M1Interface 3.4). RUN_BLOCKED may come from
 * either and is the only reason that carries `closeReason`, which it always does.
 */
export const SyscallRejectedSchema = Type.Union(
  [
    closed({
      ...rejected,
      issuer: Type.Literal('GATEWAY'),
      reasonCode: reasonCodeOf(GATEWAY_REJECTED_CODES),
    }),
    closed({
      ...rejected,
      issuer: Type.Literal('CORE'),
      reasonCode: reasonCodeOf(CORE_REJECTED_CODES),
    }),
    closed({
      ...rejected,
      issuer: Type.Enum(['GATEWAY', 'CORE']),
      reasonCode: Type.Literal('RUN_BLOCKED'),
      closeReason: CloseReasonSchema,
    }),
  ],
  { $id: 'kernel.control.SyscallRejected.v0' },
);
export type SyscallRejected = Static<typeof SyscallRejectedSchema>;

export const RunCreatedSchema = closed(
  {
    requestId: IdSchemas.requestId,
    outcome: Type.Literal('ACCEPTED'),
    workflowRunId: IdSchemas.workflowRunId,
  },
  'kernel.control.RunCreated.v0',
);
export type RunCreated = Static<typeof RunCreatedSchema>;

/** Every M1 artifact is UTF-8 text or JSON. */
export const ArtifactContentSchema = closed(
  {
    requestId: IdSchemas.requestId,
    outcome: Type.Literal('ACCEPTED'),
    ref: ArtifactRefSchema,
    text: Type.String(),
  },
  'kernel.control.ArtifactContent.v0',
);
export type ArtifactContent = Static<typeof ArtifactContentSchema>;
