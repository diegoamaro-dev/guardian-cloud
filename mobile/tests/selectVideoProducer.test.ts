/**
 * Producer selection.
 *
 * This is where the exclusivity rule lives, so this is where it is asserted:
 * a session gets exactly one video producer, or none at all.
 */
import { describe, expect, it } from 'vitest';

import { selectVideoProducer } from '@/video/selectVideoProducer';

describe('selectVideoProducer', () => {
  it('1 · returns null for audio, whatever the flag says', () => {
    expect(selectVideoProducer('audio', true)).toBeNull();
    expect(selectVideoProducer('audio', false)).toBeNull();
  });

  it('2 · video with the flag on selects the native segmented producer', () => {
    expect(selectVideoProducer('video', true)).toBe('native-segmented');
  });

  it('3 · video with the flag off keeps the expo-camera fallback', () => {
    expect(selectVideoProducer('video', false)).toBe('expo-camera');
  });

  it('maps the two flag states to two different producers', () => {
    // The real exclusivity guarantee: one flag value yields one producer, and
    // the two values never converge on the same one — so a session can never
    // end up with both preview surfaces mounted.
    const chosen = [
      selectVideoProducer('video', true),
      selectVideoProducer('video', false),
    ];
    expect(new Set(chosen).size).toBe(2);
    for (const producer of chosen) {
      expect(['native-segmented', 'expo-camera']).toContain(producer);
    }
  });
});
