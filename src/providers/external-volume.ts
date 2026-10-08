import { VolumePercentageSchema } from '@/utils/volume';

import type { MusicPlayer } from '@/types/music-player';

export function applyExternalVolume(
  api: Pick<MusicPlayer, 'setVolume'>,
  document: Pick<Document, 'querySelector'>,
  volume: number,
) {
  if (!VolumePercentageSchema.safeParse(volume).success) return;
  const value = Math.round(volume);
  // The player bar's updateVolume applies a curve that getVolume does not undo.
  api.setVolume(value);
  for (const selector of ['#volume-slider', '#expand-volume-slider']) {
    const slider = document.querySelector<HTMLInputElement>(selector);
    if (slider) slider.value = String(value > 0 && value < 5 ? 5 : value);
  }
}
