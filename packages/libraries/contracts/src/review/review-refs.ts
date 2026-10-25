import type { Static } from 'typebox';
import { OpaqueRefSchema } from '../platform-common/opaque-ref.js';

export const HumanReviewRequestRefSchema = OpaqueRefSchema(
  'human-review-request',
  'review.HumanReviewRequestRef.v0',
);
export type HumanReviewRequestRef = Static<typeof HumanReviewRequestRefSchema>;
export const HumanReviewDecisionRefSchema = OpaqueRefSchema(
  'human-review-decision',
  'review.HumanReviewDecisionRef.v0',
);
export type HumanReviewDecisionRef = Static<typeof HumanReviewDecisionRefSchema>;
