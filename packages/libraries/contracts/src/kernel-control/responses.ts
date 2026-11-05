import { Type, type Static } from 'typebox';
import { ArtifactRefSchema } from '../platform-common/common-schemas.js';
import { IdSchemas } from '../platform-common/ids.js';
import {
  CORE_REJECTED_CODES,
  GATEWAY_REJECTED_CODES,
  reasonCodeOf,
} from '../platform-common/reason-code.js';
import { closed, count } from '../platform-common/schema-helpers.js';
import { CloseReasonSchema } from './run-outcome.js';

export const SyscallAckSchema = closed(
  { requestId: IdSchemas.requestId, outcome: Type.Literal('ACCEPTED') },
  'kernel.control.SyscallAck.v1',
);
export type SyscallAck = Static<typeof SyscallAckSchema>;

const rejected = { requestId: IdSchemas.requestId, outcome: Type.Literal('REJECTED') };

/** Every artifact is UTF-8 text or JSON. */
export const ArtifactContentSchema = closed(
  {
    requestId: IdSchemas.requestId,
    outcome: Type.Literal('ACCEPTED'),
    ref: ArtifactRefSchema,
    text: Type.String(),
  },
  'kernel.control.ArtifactContent.v1',
);
export type ArtifactContent = Static<typeof ArtifactContentSchema>;

/** Each issuer answers with its own reason codes (Interface documents, section 5). */
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
    /** The shares of a delegation are more than the parent can lend; it is told what it can. */
    closed({
      ...rejected,
      issuer: Type.Literal('CORE'),
      reasonCode: Type.Literal('BUDGET_INSUFFICIENT'),
      delegable: count(),
    }),
  ],
  { $id: 'kernel.control.SyscallRejected.v1' },
);
export type SyscallRejected = Static<typeof SyscallRejectedSchema>;

export const SessionAcceptedSchema = closed(
  {
    requestId: IdSchemas.requestId,
    outcome: Type.Literal('ACCEPTED'),
    sessionId: IdSchemas.sessionId,
  },
  'kernel.control.SessionAccepted.v1',
);
export type SessionAccepted = Static<typeof SessionAcceptedSchema>;
