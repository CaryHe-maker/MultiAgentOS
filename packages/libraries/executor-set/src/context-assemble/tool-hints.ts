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
  CAPABILITY_NOT_GRANTED: 'this agent may not use this tool; do the work another way or say so',
  ADMISSION_CHECK_FAILED: 'the system could not check this call, so it did not run it',
  WRITE_SCOPE_DELEGATED:
    'the files you may write are with your subtasks until they finish; wait for their results instead of writing',
  WRITE_OUT_OF_SCOPE:
    'the path is outside what you may write (absolute, `..`, or beyond your write root); use a relative path inside it',
  PROTECTED_PATH:
    'this path is protected (.git, .multiagentos, .env, keys, node_modules, or excluded by the project) and cannot be written; tell the user if it must change',
  FILE_CHANGED:
    'the file is not as you last read it; read it again, then redo the change against what is there',
  EDIT_NO_MATCH:
    'oldString is not in the file; read the file again and copy the text exactly, with its whitespace',
  EDIT_NOT_UNIQUE:
    'oldString occurs more than once; include more of the surrounding text, or set replaceAll',
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
  COMMAND_DENIED:
    'this command is on the list of commands that are never run; do the work another way',
  PROTECTED_PATH_CREATED:
    'the command created a protected path (.git, .multiagentos, AGENTS.md); it was moved out of the repository',
  APPROVAL_MISMATCH: 'the command is not the one the user approved, so it did not run',
  ENV_ASSERTION_FAILED: 'the command environment held a secret, so it did not run',
  SANDBOX_UNAVAILABLE: 'commands cannot run here because the sandbox is unavailable; tell the user',
  NOT_A_GIT_REPOSITORY: 'this directory is not a git repository',
  ADDRESS_FORBIDDEN:
    'this address leads into this machine or a private network; web_fetch reaches only the public internet',
  CONTEXT_COMPACTED:
    'the earlier conversation was just compacted; the system sets the context up again',
  CONTEXT_OVERFLOW: 'the conversation is longer than the model can take',
  DOMAIN_DENIED: 'the user has forbidden this site; do not try it again, use another source',
  EXTERNAL_PATH_UNAVAILABLE:
    'no such path, or it cannot be read; give the absolute path of an existing file or folder outside the repository (a path inside it is read with read_file), and do not guess',
  SECRET_IN_REQUEST:
    'the query or address contains something that looks like a credential, so it was not sent; leave it out',
  UNSUPPORTED_CONTENT:
    'the page is not text (an image, a PDF or another binary file); web_fetch reads only HTML, plain text, Markdown and JSON',
};

export const FAILED_HINTS: Record<UnitFailedCode, string> = {
  PROVIDER_UNREACHABLE: 'the provider could not be reached',
  PROVIDER_RATE_LIMITED: 'the provider is rate limiting',
  PROVIDER_AUTH: 'the provider refused the credentials or the account has no balance',
  PROVIDER_ERROR: 'the provider returned an error',
  COMPACTION_SUMMARY_INVALID: 'the summary of the earlier conversation could not be written',
  PAGE_UNAVAILABLE:
    'the page cannot be fetched (not found, needs a login, or its site refused); try another source',
  PROVIDER_TOOL_CHOICE_IGNORED: 'the model did not call the required tool',
  INTERNAL: 'the tool failed internally; try a different request',
  UNIT_TIMEOUT: 'the tool took too long; try a narrower request',
};
