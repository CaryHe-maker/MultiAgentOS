/** Artifact media types of M1Interface 6.1 and the RunSummary media type. */
export const MEDIA_TYPES = {
  contextPack: 'application/vnd.multiagentos.context-pack+json',
  fileText: 'text/plain; charset=utf-8',
  modelOutput: 'application/vnd.multiagentos.model-output+json',
  analysisReport: 'application/vnd.multiagentos.analysis-report+json',
  runSummary: 'application/vnd.multiagentos.run-summary+json',
} as const;
export type MediaType = (typeof MEDIA_TYPES)[keyof typeof MEDIA_TYPES];
