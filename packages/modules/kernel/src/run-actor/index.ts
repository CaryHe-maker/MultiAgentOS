/**
 * Run actor (docs/M1/Kernel/Interaction.md 4): the run Inbox with a control and a work channel,
 * the non-reentrant processing loop, and the per-run state split into Core, Execution, Monitor
 * and Scheduler blocks. It is the only place that wires the four Kernel core components
 * together, and it reaches them through their `index.ts` only.
 */
export {};
