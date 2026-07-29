/**
 * Pure-logic tests for the recovery verdict copy (A-1, GC-AUD-033).
 *
 * These assertions pin down what the recovery screens may CLAIM, not
 * how they look, so a future edit cannot soften them silently: the
 * exact strings, the absence of "Protegido" / "correctamente", the
 * "no se puede confirmar" clause in both non-failure verdicts, no
 * assertion that the capture was interrupted (equally unprovable), and
 * no technical vocabulary or counts.
 */

import { describe, it, expect } from 'vitest';

import {
  recoveryDetailVerdict,
  recoveryListLabel,
} from '../src/recovery/recoveryVerdict';

const UNPROVABLE = 'No se puede confirmar que la grabación esté completa.';

describe('recoveryDetailVerdict', () => {
  it('1. complete — exact label and hint', () => {
    const v = recoveryDetailVerdict('complete');
    expect(v.label).toBe('Evidencia recuperada');
    expect(v.hint).toBe(
      `La evidencia disponible se ha recuperado y verificado. ${UNPROVABLE}`,
    );
  });

  it('2. partial — exact label and hint', () => {
    const v = recoveryDetailVerdict('partial');
    expect(v.label).toBe('Recuperación incompleta');
    expect(v.hint).toBe(
      `Falta parte de la evidencia disponible. ${UNPROVABLE}`,
    );
  });

  it('3. complete claims neither "Protegido" nor "correctamente"', () => {
    const v = recoveryDetailVerdict('complete');
    const text = `${v.label} ${v.hint ?? ''}`;
    expect(text).not.toMatch(/protegido/i);
    expect(text).not.toMatch(/correctamente/i);
  });

  it('4. complete and partial both state that completeness is unprovable', () => {
    for (const status of ['complete', 'partial'] as const) {
      expect(recoveryDetailVerdict(status).hint).toContain(UNPROVABLE);
    }
  });

  it('5. partial does not assert the capture was interrupted', () => {
    const v = recoveryDetailVerdict('partial');
    const text = `${v.label} ${v.hint ?? ''}`;
    // The system cannot observe why a capture ended. Any of these words
    // would assert a cause it never saw.
    expect(text).not.toMatch(/interrump/i);
    expect(text).not.toMatch(/cortad/i);
    expect(text).not.toMatch(/incompleta la grabación/i);
    expect(text).not.toMatch(/se detuvo/i);
  });

  it('6. no verdict leaks technical vocabulary or counts', () => {
    const statuses = ['complete', 'partial', 'failed'] as const;
    for (const status of statuses) {
      const v = recoveryDetailVerdict(status);
      const text = `${v.label} ${v.hint ?? ''}`;
      expect(text).not.toMatch(/chunk/i);
      expect(text).not.toMatch(/fragmento/i);
      expect(text).not.toMatch(/hash/i);
      expect(text).not.toMatch(/manifest/i);
      // No digits at all: rules out "3 de 5", percentages and indexes.
      expect(text).not.toMatch(/\d/);
    }
  });

  it('7. failed is preserved exactly as before A-1', () => {
    const v = recoveryDetailVerdict('failed');
    expect(v.label).toBe('No se pudo recuperar');
    expect(v.color).toBe('#f85149');
    expect(v.hint).toBe(
      'No se pudo reconstruir esta evidencia desde Google Drive. Inténtalo de nuevo.',
    );
  });
});

describe('recoveryListLabel', () => {
  it('8. uses the exact containment labels', () => {
    expect(recoveryListLabel('complete').label).toBe('Evidencia disponible');
    expect(recoveryListLabel('partial').label).toBe('Subida sin completar');
  });

  it('8b. the list no longer claims protection either', () => {
    for (const status of ['complete', 'partial'] as const) {
      const l = recoveryListLabel(status);
      expect(l.label).not.toMatch(/protegido/i);
      expect(l.label).not.toMatch(/protección/i);
      expect(l.label).not.toMatch(/\d/);
    }
  });

  it('8c. colours are unchanged — A-1 is semantic, not a redesign', () => {
    expect(recoveryListLabel('complete').color).toBe('#3ddc84');
    expect(recoveryListLabel('partial').color).toBe('#d29922');
  });
});
