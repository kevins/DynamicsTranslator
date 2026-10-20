// What tools/dev/unit.ts hands each area's test file.
import type { Slot } from '../../../src/core/model';

export interface Kit {
  /** Registers a test; return a string starting with 'skipped' to mark it skipped. */
  test(name: string, fn: () => unknown): void;
  /** Deep equality by JSON. */
  eq(a: unknown, b: unknown, msg?: string): void;
  ok(c: unknown, msg?: string): void;
  /** A minimal slot: kind, key (default `${kind}|x|Label`), labels (default {1033:'Name',1036:'Nom'}). */
  slot(kind: string, key?: string, labels?: Record<number, string>): Slot;
}
