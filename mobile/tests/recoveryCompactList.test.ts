/**
 * GC-RECOVERY-COMPACT-DISCOVERY-001 — mobile side.
 *
 * The app opts in to `?view=compact`, so it receives Drive metadata only:
 * no medium, no chunk count, no completion time, no protection status.
 * The list must therefore claim none of them, and its copy must not tell
 * the user these sessions are already backed up, complete or recoverable
 * — nothing has been verified at listing time. The check happens when a
 * session is opened.
 *
 * SOURCE-LEVEL assertions, following the precedent set by
 * `reliabilitySurfaces.test.ts`: this project ships no React renderer in
 * its test environment (vitest runs in `node`, no
 * @testing-library/react-native, no react-test-renderer) and adding one
 * is out of scope — no new dependencies. Reading the screen source is the
 * only way to assert "this claim is not rendered" without a renderer.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/** Strip comments so assertions see CODE only — a comment explaining
 *  that a field was removed must not satisfy an "is it gone?" check. */
function stripComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

function source(relative: string): string {
  const path = fileURLToPath(new URL(relative, import.meta.url).href);
  return stripComments(readFileSync(path, 'utf8'));
}

const listScreen = source('../app/recover/index.tsx');
const detailScreen = source('../app/recover/[id].tsx');
const apiClient = source('../src/api/recovery.ts');

/** Fields that exist only inside a manifest body. */
const BODY_ONLY_FIELDS = [
  'protection_status',
  'chunk_count',
  'completed_at',
  'created_at',
];

describe('the client opts in to compact discovery', () => {
  it('requests ?view=compact explicitly', () => {
    expect(apiClient).toContain("'/recovery/manifests?view=compact'");
  });

  it('declares only the three metadata-derived fields', () => {
    expect(apiClient).toContain('session_id');
    expect(apiClient).toContain('manifest_file_id');
    expect(apiClient).toContain('reference_date');
  });

  it('does not depend on any body-only field', () => {
    for (const field of [...BODY_ONLY_FIELDS, 'RecoverableMode']) {
      expect(apiClient).not.toContain(field);
    }
  });
});

describe('the list renders only what discovery actually read', () => {
  it('renders none of the body-only fields', () => {
    for (const field of BODY_ONLY_FIELDS) {
      expect(listScreen).not.toContain(field);
    }
  });

  it('renders the reference date, labelled as a reference', () => {
    expect(listScreen).toContain('reference_date');
    expect(listScreen).toContain('Última actualización');
  });

  it('shows no protection badge on a row', () => {
    expect(listScreen).not.toContain('recoveryListLabel');
  });

  it('still navigates to the detail with the opaque manifest_file_id', () => {
    expect(listScreen).toContain('manifest_file_id');
    expect(listScreen).toContain('/recover/');
  });
});

describe('the copy claims nothing that has not been verified', () => {
  it('no longer says the sessions are backed up', () => {
    // "Sesiones respaldadas…" asserted a verified backup for rows that,
    // under compact discovery, have not been read at all.
    expect(listScreen).not.toContain('respaldadas');
  });

  it('says they were found and will be checked on open', () => {
    expect(listScreen).toContain('Sesiones encontradas en tu Google Drive');
    expect(listScreen).toContain('Se comprobarán al');
  });

  it('adds no decision or extra step for the user', () => {
    // Exactly one action per row, unchanged: open it. Counts CALL SITES,
    // not the function declaration.
    const callSites =
      listScreen.match(/onPress=\{\(\) => handleRecover\(/g)?.length ?? 0;
    expect(callSites).toBe(1);
  });
});

describe('the detail path is untouched — it is where the body is read', () => {
  it('still fetches the full manifest by file id', () => {
    expect(detailScreen).toContain('getRecoveryManifest');
  });
});
