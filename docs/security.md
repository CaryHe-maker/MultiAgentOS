# Security and Approval Policy

## MVP Default

Workers may only operate inside their assigned Git worktree and declared `owned_paths`. They receive no secrets by default and must not read outside the project directory.

## Approval Required

The MVP pauses for human approval before any of these actions:

- deletion or bulk overwrite of files;
- `git push`, release, deployment, or external write operation;
- changing permissions, credentials, or repository settings;
- reading secret files, environment variables, `.ssh`, or credential directories;
- installing arbitrary packages or using unrestricted network access.

## Command Policy

Initial allowlisted commands should be narrow and project-specific: test runners, linters, type checkers, package installation from locked project dependencies, and Git inspection commands. Every command needs a timeout, captured output, and task association.

The policy is enforced by the runtime, not by asking an LLM to behave safely in a prompt.

## Secret Handling

- Never commit API keys, tokens, databases, logs containing secrets, or local IDE configuration.
- Use environment variables or a local secret manager only at the process boundary that needs a model API key.
- Store prompt hashes and redacted metadata in reports; do not persist unrestricted conversation content by default.
