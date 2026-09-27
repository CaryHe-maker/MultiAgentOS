/**
 * 极小的 gitignore 风格 glob：`**` 跨目录，`*`/`?` 不跨 `/`。
 * 不含 `/` 的模式在任意层级匹配（`.env*` 也能命中 `config/.env.local`）；
 * 以 `/` 结尾表示目录，匹配其下所有文件。不支持 `!` 取反和字符类。
 */
export function matchesGlob(path: string, pattern: string): boolean {
  let normalized = pattern.endsWith('/') ? `${pattern}**` : pattern;
  const body = normalized.endsWith('/**') ? normalized.slice(0, -3) : normalized;
  if (!body.includes('/')) normalized = `**/${normalized}`;
  return globToRegExp(normalized).test(path);
}

function globToRegExp(glob: string): RegExp {
  let source = '';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === '*') {
      if (glob[index + 1] === '*') {
        const followedBySlash = glob[index + 2] === '/';
        source += followedBySlash ? '(?:.*/)?' : '.*';
        index += followedBySlash ? 2 : 1;
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += (char ?? '').replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}
