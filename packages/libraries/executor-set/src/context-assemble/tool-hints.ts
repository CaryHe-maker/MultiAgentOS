import type { UnitFailedCode, UnitRejectedCode } from '@multiagentos/contracts';

/**
 * What a tool that gave no output says to the model. Everything is plain text: JSON tool results
 * cost 18% more input tokens than numbered text for no gain.
 */
export const REJECTED_HINTS: Record<UnitRejectedCode, string> = {
  INVALID_INPUT: 'the arguments do not match the tool parameters; fix them and call again',
  INVALID_ARTIFACT_REF: 'an internal reference was invalid; continue with what you have',
  USER_DECLINED: 'the user rejected this tool; answer from what you already have',
  BUDGET_WRAP_UP: 'the budget is nearly used up; finish with what you already have',
  BUDGET_EXHAUSTED: 'the budget is used up; finish with what you already have',
  FINAL_CALL_USED: 'no more tool calls are possible; finish now',
  ARTIFACT_EXPIRED: 'the output it refers to is no longer kept; call the tool again if you need it',
  QUOTA_EXHAUSTED:
    'this agent has used up its tools or its time; finish with what you already have',
  OUT_OF_SCOPE:
    'the path is outside the readable repository (absolute, `..`, or a protected file such as .env, keys or node_modules); use a relative path inside the repository',
  NOT_FOUND:
    'no file at this path; use search_repository with mode PATH to find the right path, and do not guess paths',
  UNSUPPORTED_FILE:
    'the path is a directory, a binary file or not UTF-8 text; read a UTF-8 text file instead',
  INVALID_RANGE:
    'the line range is outside the file; check totalLines and ask for an existing range',
  INVALID_QUERY:
    'the query is empty or not usable for this mode (SYMBOL needs a plain identifier such as parseConfig); change it',
  LIMIT_EXCEEDED: 'the result would be too large; ask for a smaller range or a more specific query',
};

export const FAILED_HINTS: Record<UnitFailedCode, string> = {
  PROVIDER_UNREACHABLE: 'the model provider could not be reached',
  PROVIDER_RATE_LIMITED: 'the model provider is rate limiting',
  PROVIDER_AUTH: 'the model provider refused the credentials',
  PROVIDER_ERROR: 'the model provider returned an error',
  PROVIDER_TOOL_CHOICE_IGNORED: 'the model did not call the required tool',
  INTERNAL: 'the tool failed internally; try a different request',
  UNIT_TIMEOUT: 'the tool took too long; try a narrower request',
};
