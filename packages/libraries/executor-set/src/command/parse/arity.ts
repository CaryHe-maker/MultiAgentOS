/**
 * How many leading words name "the same kind of command" (M2Design 5.2). `git push origin` has the
 * prefix `git push`, `docker compose up -d` has `docker compose up`. A command that is not in the
 * table has its first word as prefix. The longest matching key wins.
 */
export const ARITY: Readonly<Record<string, number>> = {
  git: 2,
  npm: 2,
  pnpm: 2,
  yarn: 2,
  bun: 2,
  npx: 2,
  cargo: 2,
  go: 2,
  pip: 2,
  pip3: 2,
  poetry: 2,
  uv: 2,
  make: 2,
  gradle: 2,
  mvn: 2,
  dotnet: 2,
  docker: 2,
  podman: 2,
  kubectl: 2,
  helm: 2,
  terraform: 2,
  gh: 3,
  aws: 3,
  'docker compose': 3,
  'docker container': 3,
  'docker image': 3,
  'docker volume': 3,
  'docker network': 3,
  'podman compose': 3,
  'cargo run': 3,
  'cargo test': 3,
  'cargo build': 3,
  'git remote': 3,
  'git stash': 3,
  'git config': 3,
};

/**
 * The prefix of a word list, or undefined when an option stands inside the words the table asks
 * for: `git -C /other push` must not turn into the broad prefix `git -C`.
 */
export function commandPrefix(words: readonly string[]): string | undefined {
  const [name] = words;
  if (name === undefined || name === '') return undefined;
  let arity = 1;
  for (let length = Math.min(words.length, 3); length >= 1; length -= 1) {
    const key = words.slice(0, length).join(' ');
    const found = ARITY[key];
    if (found !== undefined) {
      arity = found;
      break;
    }
  }
  const taken = words.slice(0, arity);
  if (taken.slice(1).some((word) => word.startsWith('-'))) return undefined;
  // A command with fewer words than the table asks for is its own prefix.
  return taken.join(' ');
}
