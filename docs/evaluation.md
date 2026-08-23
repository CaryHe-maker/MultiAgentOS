# Evaluation Plan

## Question

Does this orchestration approach improve quality and wall-clock time enough to justify its additional token and coordination cost?

## Fixed Task Set

Create 5-10 small, repeatable tasks against the same example application. Each task must define a starting commit, expected acceptance commands, maximum human intervention, and whether it is plausibly parallelizable.

The first task is JWT login for a Todo application. It includes an API contract, backend endpoint, frontend form, and end-to-end test.

## Baselines

Run each task in three modes:

1. One coding agent working serially.
2. A human manually coordinating two coding-agent windows.
3. MultiAgentOS using the same model family, task target, and acceptance tests where practical.

Do not compare a powerful model in one mode with a weaker model in another without recording the difference.

## Required Metrics

| Metric | Why record it |
|---|---|
| success and test pass rate | quality outcome |
| wall-clock and queue time | actual delivery speed |
| input/output tokens and estimated cost | coordination overhead |
| retry and rework count | plan and worker reliability |
| merge conflict count | ownership effectiveness |
| human intervention count | automation level |
| approval and policy rejection count | safety behavior |

Each run produces one machine-readable record and one human-readable summary. Report medians across repeated runs where possible; one successful demo is not evidence of a general improvement.
