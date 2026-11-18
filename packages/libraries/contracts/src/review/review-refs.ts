import type { Static } from 'typebox';
import { OpaqueRefSchema } from '../platform-common/opaque-ref.js';

export const HumanReviewRequestRefSchema = OpaqueRefSchema(
  'human-review-request',
  'review.HumanReviewRequestRef.v1',
);
export type HumanReviewRequestRef = Static<typeof HumanReviewRequestRefSchema>;
export const HumanReviewDecisionRefSchema = OpaqueRefSchema(
  'human-review-decision',
  'review.HumanReviewDecisionRef.v1',
);
export type HumanReviewDecisionRef = Static<typeof HumanReviewDecisionRefSchema>;
