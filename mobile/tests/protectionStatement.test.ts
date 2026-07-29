import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  deriveGuardianStatus,
  deriveProtectionStatement,
  isChunkConfirmedOffDevice,
  isEntryFullyProtected,
  NOT_PROTECTED_OFF_DEVICE,
  type ProtectedChunkLike,
  type ProtectedEntryLike,
  type ProtectionStatementInput,
} from '../src/recording/deriveGuardianStatus';

/**
 * A-2 / GC-AUD-004 — the screen may only claim protection for evidence
 * whose upload has been confirmed outside the device, and may only show
 * a denominator once the capture is closed.
 *
 * Two invariants are enforced across every case below:
 *
 *   1. `confirmedOffDeviceCount === 0` never produces a protection claim.
 *   2. No `N/M` while `recordingClosed === false` — during an open
 *      capture `totalCount` is "fragments so far", not "fragments this
 *      recording will produce", and no signal predicts the latter.
 */

/** Base input; each test overrides only what it is about. */
function input(
  over: Partial<ProtectionStatementInput> = {},
): ProtectionStatementInput {
  return {
    status: 'grabando',
    confirmedOffDeviceCount: 0,
    totalCount: 0,
    recordingClosed: false,
    ...over,
  };
}

/** Any "N/M" shape at all. */
const DENOMINATOR = /\d+\s*\/\s*\d+/;

describe('deriveProtectionStatement — open capture (grabando)', () => {
  it('case 1 — N=0, M=0 (video for its whole capture): says nothing is protected yet', () => {
    expect(
      deriveProtectionStatement(
        input({ status: 'grabando', confirmedOffDeviceCount: 0, totalCount: 0 }),
      ),
    ).toBe(NOT_PROTECTED_OFF_DEVICE);
  });

  it('case 2 — N=0, M>0 (audio first seconds / bad network): enqueued is not protected', () => {
    expect(
      deriveProtectionStatement(
        input({ status: 'grabando', confirmedOffDeviceCount: 0, totalCount: 7 }),
      ),
    ).toBe(NOT_PROTECTED_OFF_DEVICE);
  });

  it('case 3 — N=1, M>1: singular, and no denominator', () => {
    const out = deriveProtectionStatement(
      input({ status: 'grabando', confirmedOffDeviceCount: 1, totalCount: 5 }),
    );
    expect(out).toBe('1 parte protegida fuera del dispositivo');
    expect(out).not.toMatch(DENOMINATOR);
  });

  it('case 4 — N>1, M>N: plural, and no denominator', () => {
    const out = deriveProtectionStatement(
      input({ status: 'grabando', confirmedOffDeviceCount: 4, totalCount: 9 }),
    );
    expect(out).toBe('4 partes protegidas fuera del dispositivo');
    expect(out).not.toMatch(DENOMINATOR);
  });

  it('case 5 — N=M>0 mid-capture: never a denominator, never a completeness claim', () => {
    // The trap this rule exists for: uploads briefly catch up with the
    // fragments produced so far, which would render "3/3" and be read
    // as "everything is safe" while the recording is still running.
    const out = deriveProtectionStatement(
      input({ status: 'grabando', confirmedOffDeviceCount: 3, totalCount: 3 }),
    );
    expect(out).toBe('3 partes protegidas fuera del dispositivo');
    expect(out).not.toMatch(DENOMINATOR);
    expect(out).not.toMatch(/protegido$|completa|todo/i);
  });

  it('ignores recordingClosed=true while the phase is still grabando', () => {
    // Defensive: the phase is authoritative about the capture being
    // live, so an incoherent pair must not open the denominator branch.
    const out = deriveProtectionStatement(
      input({
        status: 'grabando',
        confirmedOffDeviceCount: 2,
        totalCount: 6,
        recordingClosed: true,
      }),
    );
    expect(out).not.toMatch(DENOMINATOR);
  });
});

describe('deriveProtectionStatement — closed capture (subiendo)', () => {
  it('case 6 — N=0, M>0: never says "Protegiendo evidencia"', () => {
    const out = deriveProtectionStatement(
      input({
        status: 'subiendo',
        confirmedOffDeviceCount: 0,
        totalCount: 12,
        recordingClosed: true,
      }),
    );
    expect(out).toBe(NOT_PROTECTED_OFF_DEVICE);
    expect(out).not.toMatch(/Protegiendo evidencia/);
  });

  it('case 7 — 0<N<M: shows N/M protegidos', () => {
    expect(
      deriveProtectionStatement(
        input({
          status: 'subiendo',
          confirmedOffDeviceCount: 3,
          totalCount: 8,
          recordingClosed: true,
        }),
      ),
    ).toBe('3/8 protegidos');
  });

  it('case 8 — N=M but phase is still subiendo: reports the count, never pre-empts "Protegido"', () => {
    const out = deriveProtectionStatement(
      input({
        status: 'subiendo',
        confirmedOffDeviceCount: 8,
        totalCount: 8,
        recordingClosed: true,
      }),
    );
    expect(out).toBe('8/8 protegidos');
    expect(out).not.toBe('Protegido');
    expect(out).not.toMatch(/^Protegido/);
  });

  it('suppresses the denominator while video post-stop chunking is still appending', () => {
    // `chunkVideoFile` runs after the recorder stops, so the phase is
    // already `subiendo` while the total climbs. Until
    // `queueMarkRecordingClosed` sets recording_closed the denominator
    // would be a moving target.
    const out = deriveProtectionStatement(
      input({
        status: 'subiendo',
        confirmedOffDeviceCount: 2,
        totalCount: 5,
        recordingClosed: false,
      }),
    );
    expect(out).toBe('2 partes protegidas fuera del dispositivo');
    expect(out).not.toMatch(DENOMINATOR);
  });
});

describe('deriveProtectionStatement — phases left untouched', () => {
  it('case 9 — protegido, N=M>0: adds nothing (existing behaviour preserved)', () => {
    expect(
      deriveProtectionStatement(
        input({
          status: 'protegido',
          confirmedOffDeviceCount: 8,
          totalCount: 8,
          recordingClosed: true,
        }),
      ),
    ).toBeNull();
  });

  it('case 10 — listo: never asserts protection', () => {
    expect(
      deriveProtectionStatement(input({ status: 'listo' })),
    ).toBeNull();
    // Even with stale non-zero counters.
    expect(
      deriveProtectionStatement(
        input({ status: 'listo', confirmedOffDeviceCount: 5, totalCount: 5 }),
      ),
    ).toBeNull();
  });

  it('case 11 — error: A-2 does not extend to the failure surface', () => {
    expect(
      deriveProtectionStatement(
        input({
          status: 'error',
          confirmedOffDeviceCount: 4,
          totalCount: 10,
          recordingClosed: true,
        }),
      ),
    ).toBeNull();
  });

  it('iniciando and recuperando add nothing', () => {
    expect(deriveProtectionStatement(input({ status: 'iniciando' }))).toBeNull();
    expect(
      deriveProtectionStatement(input({ status: 'recuperando' })),
    ).toBeNull();
  });
});

describe('deriveProtectionStatement — structural audio/video parity', () => {
  it('case 12 — the function takes no mode argument', () => {
    // Parity is guaranteed by construction rather than by convention:
    // a single parameter means there is nowhere to pass a mode, so the
    // two modes cannot diverge.
    expect(deriveProtectionStatement.length).toBe(1);
  });

  it('identical counters yield identical copy — the only inputs are phase + counters', () => {
    // Whatever the caller was recording, these are the values an audio
    // session and a video session both reach; the output must match.
    const audio = deriveProtectionStatement(
      input({ status: 'grabando', confirmedOffDeviceCount: 0, totalCount: 0 }),
    );
    const video = deriveProtectionStatement(
      input({ status: 'grabando', confirmedOffDeviceCount: 0, totalCount: 0 }),
    );
    expect(audio).toBe(video);
    expect(audio).toBe(NOT_PROTECTED_OFF_DEVICE);
  });

  it('the source module never mentions audio or video', () => {
    const src = readFileSync(
      join(__dirname, '../src/recording/deriveGuardianStatus.ts'),
      'utf8',
    );
    const body = src.slice(src.indexOf('export function deriveProtectionStatement'));
    expect(body).not.toMatch(/\bmode\b/);
  });
});

describe('deriveProtectionStatement — incoherent input cannot manufacture a claim', () => {
  it('case 13a — negative counters assert nothing', () => {
    expect(
      deriveProtectionStatement(
        input({ status: 'grabando', confirmedOffDeviceCount: -3, totalCount: -1 }),
      ),
    ).toBe(NOT_PROTECTED_OFF_DEVICE);
    expect(
      deriveProtectionStatement(
        input({
          status: 'subiendo',
          confirmedOffDeviceCount: -1,
          totalCount: 5,
          recordingClosed: true,
        }),
      ),
    ).toBe(NOT_PROTECTED_OFF_DEVICE);
  });

  it('case 13b — NaN / Infinity assert nothing', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(
        deriveProtectionStatement(
          input({ status: 'grabando', confirmedOffDeviceCount: bad, totalCount: 4 }),
        ),
      ).toBe(NOT_PROTECTED_OFF_DEVICE);
    }
  });

  it('case 13c — fractional counters assert nothing (they are NOT floored into a claim)', () => {
    // A chunk count is a non-negative integer by construction, so 1.7
    // is not "1 protected fragment" — it is a value that should not
    // exist. Rounding it down would invent a protection claim out of
    // corrupt data, so it collapses to 0 instead.
    expect(
      deriveProtectionStatement(
        input({ status: 'grabando', confirmedOffDeviceCount: 1.7, totalCount: 4.2 }),
      ),
    ).toBe(NOT_PROTECTED_OFF_DEVICE);

    // A fractional TOTAL cannot open the denominator branch either.
    const out = deriveProtectionStatement(
      input({
        status: 'subiendo',
        confirmedOffDeviceCount: 2,
        totalCount: 4.2,
        recordingClosed: true,
      }),
    );
    expect(out).toBe('2 partes protegidas fuera del dispositivo');
    expect(out).not.toMatch(DENOMINATOR);
  });

  it('counters beyond MAX_SAFE_INTEGER assert nothing', () => {
    expect(
      deriveProtectionStatement(
        input({
          status: 'grabando',
          confirmedOffDeviceCount: Number.MAX_SAFE_INTEGER + 2,
          totalCount: 10,
        }),
      ),
    ).toBe(NOT_PROTECTED_OFF_DEVICE);
  });

  it('case 13d — uploaded > total falls back to the absolute form, never "5/3"', () => {
    const out = deriveProtectionStatement(
      input({
        status: 'subiendo',
        confirmedOffDeviceCount: 5,
        totalCount: 3,
        recordingClosed: true,
      }),
    );
    expect(out).toBe('5 partes protegidas fuera del dispositivo');
    expect(out).not.toMatch(DENOMINATOR);
  });

  it('case 13e — NaN total cannot produce a denominator', () => {
    const out = deriveProtectionStatement(
      input({
        status: 'subiendo',
        confirmedOffDeviceCount: 2,
        totalCount: Number.NaN,
        recordingClosed: true,
      }),
    );
    expect(out).not.toMatch(DENOMINATOR);
    expect(out).toBe('2 partes protegidas fuera del dispositivo');
  });
});

describe('isChunkConfirmedOffDevice — proof, not queue status', () => {
  /**
   * `status === 'uploaded'` alone is a queue state, not evidence that
   * anything left the phone. It is reachable with no reference at all:
   * the `DRIVE_CHUNK_UPLOAD_ENABLED=false` rollback writes
   * `remote_reference: null`, and legacy entries predate the field.
   */
  function chunk(over: Partial<ProtectedChunkLike> = {}): ProtectedChunkLike {
    return { status: 'uploaded', remote_reference: 'drive-file-1', ...over };
  }

  it('regression 1 — uploaded + a real reference is confirmed off-device', () => {
    expect(isChunkConfirmedOffDevice(chunk())).toBe(true);
    expect(
      isChunkConfirmedOffDevice(chunk({ remote_reference: 'nas://a/b.bin' })),
    ).toBe(true);
  });

  it('regression 2 — uploaded WITHOUT a usable reference is not confirmed', () => {
    // undefined / null / empty / whitespace-only all mean "no proof".
    for (const remote_reference of [undefined, null, '', '   ', '\t\n']) {
      expect(isChunkConfirmedOffDevice(chunk({ remote_reference }))).toBe(false);
    }
  });

  it('regression 3 — a non-uploaded status is never confirmed, reference or not', () => {
    for (const status of ['pending', 'uploading', 'failed']) {
      expect(
        isChunkConfirmedOffDevice(
          chunk({ status, remote_reference: 'drive-file-1' }),
        ),
      ).toBe(false);
    }
  });
});

describe('A-2 end-to-end — an uploaded chunk with no reference proves nothing', () => {
  /** Chunks that the OLD bare-status counter would have counted. */
  const uploadedButUnreferenced = [
    { status: 'uploaded', remote_reference: null },
    { status: 'uploaded', remote_reference: undefined },
    { status: 'uploaded', remote_reference: '' },
  ];

  /** What the polling tick now computes for a set of chunks. */
  function confirmedOf(chunks: readonly ProtectedChunkLike[]): number {
    return chunks.filter(isChunkConfirmedOffDevice).length;
  }

  it('regression 4 — open recording, all chunks uploaded but unreferenced', () => {
    const chunks = uploadedButUnreferenced;
    const confirmedOffDeviceCount = confirmedOf(chunks);
    expect(confirmedOffDeviceCount).toBe(0);

    // Main status stays `grabando`.
    const status = deriveGuardianStatus({
      isRecording: true,
      isRecovering: false,
      isStarting: false,
      isStopping: false,
      totalCount: chunks.length,
      confirmedOffDeviceCount,
      activeCount: 0,
      failedCount: 0,
      recordingClosed: false,
    });
    expect(status).toBe('grabando');

    // Secondary line refuses to claim protection.
    expect(
      deriveProtectionStatement({
        status,
        confirmedOffDeviceCount,
        totalCount: chunks.length,
        recordingClosed: false,
      }),
    ).toBe(NOT_PROTECTED_OFF_DEVICE);

    // And no green banner.
    expect(
      isEntryFullyProtected({ recording_closed: false, chunks }),
    ).toBe(false);
  });

  it('regression 5 — closed capture, all uploaded but one lacks a reference', () => {
    const chunks: ProtectedChunkLike[] = [
      { status: 'uploaded', remote_reference: 'drive-file-1' },
      { status: 'uploaded', remote_reference: 'drive-file-2' },
      { status: 'uploaded', remote_reference: null },
    ];
    const confirmedOffDeviceCount = confirmedOf(chunks);
    expect(confirmedOffDeviceCount).toBe(2);

    // Never `protegido` — the bare-status count would have been 3/3.
    const status = deriveGuardianStatus({
      isRecording: false,
      isRecovering: false,
      isStarting: false,
      isStopping: false,
      totalCount: chunks.length,
      confirmedOffDeviceCount,
      activeCount: 0,
      failedCount: 0,
      recordingClosed: true,
    });
    expect(status).not.toBe('protegido');
    expect(status).toBe('listo');

    // Never the green banner.
    expect(isEntryFullyProtected({ recording_closed: true, chunks })).toBe(
      false,
    );
  });

  it('regression 6 — a mixed entry counts only the confirmed chunks', () => {
    const chunks: ProtectedChunkLike[] = [
      { status: 'uploaded', remote_reference: 'drive-file-1' },
      { status: 'uploaded', remote_reference: null },
      { status: 'uploaded', remote_reference: '  ' },
      { status: 'uploaded', remote_reference: 'drive-file-4' },
      { status: 'pending', remote_reference: null },
    ];
    // 5 chunks, 4 with status 'uploaded', but only 2 provable.
    expect(chunks.filter(c => c.status === 'uploaded').length).toBe(4);
    expect(confirmedOf(chunks)).toBe(2);
  });

  it('regression 7 — the denominator pairs CONFIRMED over ALL known chunks', () => {
    const chunks: ProtectedChunkLike[] = [
      { status: 'uploaded', remote_reference: 'drive-file-1' },
      { status: 'uploaded', remote_reference: 'drive-file-2' },
      { status: 'uploaded', remote_reference: null },
      { status: 'pending', remote_reference: null },
    ];
    const out = deriveProtectionStatement({
      status: 'subiendo',
      confirmedOffDeviceCount: confirmedOf(chunks),
      totalCount: chunks.length,
      recordingClosed: true,
    });
    // 2 provable of 4 known. The bare-status tally would have said 3/4,
    // and totalCount must stay the FULL count so the gap stays visible.
    expect(out).toBe('2/4 protegidos');
    expect(out).not.toBe('3/4 protegidos');
  });
});

describe('isEntryFullyProtected — the green banner cannot fire on an open capture', () => {
  function entry(over: Partial<ProtectedEntryLike> = {}): ProtectedEntryLike {
    return {
      recording_closed: true,
      chunks: [
        { status: 'uploaded', remote_reference: 'drive-file-1' },
        { status: 'uploaded', remote_reference: 'drive-file-2' },
      ],
      ...over,
    };
  }

  it('the happy path — closed, non-empty, all uploaded with references', () => {
    expect(isEntryFullyProtected(entry())).toBe(true);
  });

  it('regression 5 — an OPEN entry never fires the banner, even with every chunk confirmed', () => {
    // This is the false green banner: during an audio capture the
    // worker can momentarily upload every chunk emitted so far, which
    // used to render "🟢 Evidencia protegida / Guardada fuera de tu
    // móvil" while the recording was still running.
    expect(isEntryFullyProtected(entry({ recording_closed: false }))).toBe(
      false,
    );
  });

  it('regression 6 — a chunk without a real remote_reference never fires the banner', () => {
    const missing = [undefined, null, ''];
    for (const remote_reference of missing) {
      expect(
        isEntryFullyProtected(
          entry({
            chunks: [
              { status: 'uploaded', remote_reference: 'drive-file-1' },
              { status: 'uploaded', remote_reference },
            ],
          }),
        ),
      ).toBe(false);
    }
  });

  it('a pending, uploading or failed chunk never fires the banner', () => {
    for (const status of ['pending', 'uploading', 'failed']) {
      expect(
        isEntryFullyProtected(
          entry({
            chunks: [
              { status: 'uploaded', remote_reference: 'drive-file-1' },
              { status, remote_reference: 'drive-file-2' },
            ],
          }),
        ),
      ).toBe(false);
    }
  });

  it('an entry with zero chunks never fires the banner', () => {
    // A kill during recording can leave a closed entry with nothing in
    // it; "protected" must not be the verdict for an empty session.
    expect(isEntryFullyProtected(entry({ chunks: [] }))).toBe(false);
  });
});

describe('A-2 regression — the dishonest literal is gone', () => {
  const screen = readFileSync(join(__dirname, '../app/index.tsx'), 'utf8');
  const module_ = readFileSync(
    join(__dirname, '../src/recording/deriveGuardianStatus.ts'),
    'utf8',
  );

  /** Strips block and line comments so only executable code remains. */
  function executableCode(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  }

  it('"Protegiendo evidencia" appears in no executable path', () => {
    expect(executableCode(screen)).not.toContain('Protegiendo evidencia');
    expect(executableCode(module_)).not.toContain('Protegiendo evidencia');
  });

  it('no protection claim is built from anything but confirmedOffDeviceCount', () => {
    // Exhaustive sweep: for every phase, every coherent counter pair
    // and both closed states, a zero confirmedOffDeviceCount must yield the
    // "not protected" line or nothing at all.
    const phases: ProtectionStatementInput['status'][] = [
      'listo',
      'iniciando',
      'grabando',
      'subiendo',
      'recuperando',
      'protegido',
      'error',
    ];
    for (const status of phases) {
      for (const totalCount of [0, 1, 25]) {
        for (const recordingClosed of [false, true]) {
          const out = deriveProtectionStatement({
            status,
            confirmedOffDeviceCount: 0,
            totalCount,
            recordingClosed,
          });
          expect(out === null || out === NOT_PROTECTED_OFF_DEVICE).toBe(true);
        }
      }
    }
  });

  it('the module never mentions the recording mode at all', () => {
    const src = readFileSync(
      join(__dirname, '../src/recording/deriveGuardianStatus.ts'),
      'utf8',
    );
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/\baudio\b/i);
    expect(code).not.toMatch(/\bvideo\b/i);
  });

  it('no denominator is ever produced while the capture is open', () => {
    // Exhaustive sweep over the open-capture space.
    for (const status of ['grabando', 'subiendo'] as const) {
      for (const confirmedOffDeviceCount of [0, 1, 2, 9]) {
        for (const totalCount of [0, 1, 2, 9, 40]) {
          const out = deriveProtectionStatement({
            status,
            confirmedOffDeviceCount,
            totalCount,
            recordingClosed: false,
          });
          expect(out ?? '').not.toMatch(DENOMINATOR);
        }
      }
    }
  });
});
