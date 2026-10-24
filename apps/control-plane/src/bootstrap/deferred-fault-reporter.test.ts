import type { SystemFault } from '@multiagentos/contracts';
import { describe, expect, it, vi } from 'vitest';
import { createDeferredFaultReporter } from './deferred-fault-reporter.js';

const fault = (source: string, phase: SystemFault['phase']): SystemFault => ({
  source,
  phase,
  error: new Error(source),
});

describe('deferred fault reporter', () => {
  it('buffers composition-time faults and forwards them after binding', () => {
    const lines: string[] = [];
    const target = vi.fn();
    const deferred = createDeferredFaultReporter((line) => lines.push(line));
    const early = fault('catalog', 'BOOT');

    deferred.report(early);
    expect(target).not.toHaveBeenCalled();
    expect(lines[0]).toContain('catalog');

    deferred.bind(target);
    expect(target).toHaveBeenCalledWith(early);

    const late = fault('workflow', 'RUN');
    deferred.report(late);
    expect(target).toHaveBeenCalledWith(late);
  });

  it('uses the target directly when a fault arrives after binding', () => {
    const target = vi.fn();
    const deferred = createDeferredFaultReporter();
    deferred.bind(target);
    const late = fault('kernel-core', 'RUN');

    deferred.report(late);
    expect(target).toHaveBeenCalledTimes(1);
    expect(target).toHaveBeenCalledWith(late);
  });

  it('does not let a rejected target or logger prevent reporting', () => {
    const lines: string[] = [];
    const target = () => {
      throw new Error('target failed');
    };
    const deferred = createDeferredFaultReporter((line) => {
      lines.push(line);
      throw new Error('log failed');
    });

    expect(() => deferred.report(fault('entry', 'BOOT'))).not.toThrow();
    expect(() => deferred.bind(target)).not.toThrow();
    expect(lines.length).toBeGreaterThan(0);
  });
});
