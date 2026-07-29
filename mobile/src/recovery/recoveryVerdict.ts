/**
 * Recovery verdict copy — what the two recovery screens may claim about
 * recovered evidence. Containment for GC-AUD-033 (phase A-1); the full
 * reasoning lives in `docs/audits/`.
 *
 * What the available signals DO prove:
 *   - `ExportResult.status` — every KNOWN piece of evidence was
 *     downloaded and hash-verified (or was not).
 *   - `completed_at` — remote confirmation that the session was
 *     finalised server-side.
 *   - `is_partial` — the nature of the manifest itself: it was written
 *     incrementally during recording rather than as a final one.
 *   - `protection_status` — a manifest/upload lifecycle classification
 *     derived from `is_partial`, `completed_at` and the presence of
 *     uploaded evidence.
 *
 * What NONE of them proves: that the capture itself ran to the end.
 * The manifest records how many fragments arrived, never how many the
 * recording should have produced, so a tail-truncated session leaves no
 * gap to detect. Therefore this module never claims the recording is
 * complete — and never claims it was interrupted either, which is
 * equally unobserved. That distinction arrives with `capture_end_reason`
 * and an expected total, in phases E-1 / E-2 / E-3.
 *
 * Purity: imported by expo-router routes AND by vitest, so it must load
 * in plain Node — no react-native, no expo-*, no `@/api/*` (those pull
 * expo-file-system at import time). The two status unions are declared
 * locally and are structurally identical to `ExportStatus` and
 * `ProtectionStatus`. No side effects, no I/O, no state.
 */

/** Structurally identical to `ExportStatus` in `@/api/export`. */
export type RecoveryExportStatus = 'complete' | 'partial' | 'failed';

/** Structurally identical to `ProtectionStatus` in `@/api/recovery`. */
export type RecoveryProtectionStatus = 'complete' | 'partial';

export interface RecoveryVerdict {
  label: string;
  color: string;
  hint: string | null;
}

export interface RecoveryListLabel {
  label: string;
  color: string;
}

/**
 * The clause both non-failure verdicts carry. One constant so the two
 * branches cannot drift apart.
 */
const COMPLETION_UNPROVABLE =
  'No se puede confirmar que la grabación esté completa.';

/**
 * Verdict for the recovery detail screen, derived ONLY from the export
 * status. No counts and no technical vocabulary reach the user.
 *
 * `failed` is preserved byte-for-byte from the previous implementation:
 * it makes no claim about capture completeness, so A-1 leaves it alone.
 */
export function recoveryDetailVerdict(
  status: RecoveryExportStatus,
): RecoveryVerdict {
  if (status === 'complete') {
    return {
      label: 'Evidencia recuperada',
      color: '#3ddc84',
      hint: `La evidencia disponible se ha recuperado y verificado. ${COMPLETION_UNPROVABLE}`,
    };
  }
  if (status === 'partial') {
    return {
      label: 'Recuperación incompleta',
      color: '#d29922',
      hint: `Falta parte de la evidencia disponible. ${COMPLETION_UNPROVABLE}`,
    };
  }
  return {
    label: 'No se pudo recuperar',
    color: '#f85149',
    hint: 'No se pudo reconstruir esta evidencia desde Google Drive. Inténtalo de nuevo.',
  };
}

/**
 * Badge for the recovery list screen.
 *
 * `protection_status` classifies the manifest/upload lifecycle, so the
 * copy describes exactly that and stops there. The previous "Protegido"
 * / "Protección parcial" wording asserted the same unprovable
 * completeness the detail screen asserted — and from a different signal,
 * so the two screens could contradict each other on one session.
 *
 * Colours unchanged: A-1 is semantic containment, not a redesign.
 */
export function recoveryListLabel(
  status: RecoveryProtectionStatus,
): RecoveryListLabel {
  return status === 'complete'
    ? { label: 'Evidencia disponible', color: '#3ddc84' }
    : { label: 'Subida sin completar', color: '#d29922' };
}
