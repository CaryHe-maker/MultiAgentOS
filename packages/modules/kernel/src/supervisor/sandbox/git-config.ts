/**
 * What a command sees of `.git/config` (M2Design 6.1). The file may carry a token in a remote URL
 * (`https://user:token@host/...`) or a credential header; a command prints files, and its output
 * goes to the model and the log. The copy keeps every other setting, so git behaves as usual.
 */
const SECRET_KEY =
  /^\s*[\w.-]*(token|password|passwd|secret|authorization|extraheader|apikey)[\w.-]*\s*=/iu;
const URL_USERINFO = /(\b[a-z][a-z0-9+.-]*:\/\/)[^/@\s"']+@/giu;

export function sanitizeGitConfig(text: string): string {
  return text
    .split('\n')
    .filter((line) => !SECRET_KEY.test(line))
    .map((line) => line.replace(URL_USERINFO, '$1'))
    .join('\n');
}
