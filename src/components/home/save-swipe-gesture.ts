export const SAVE_REVEAL_WIDTH = 104;
export const SAVE_REVEAL_THRESHOLD = 76;
export const SAVE_SWIPE_ACTIVATION_DISTANCE = 20;
export const SAVE_SWIPE_VERTICAL_FAIL_DISTANCE = 12;
export const SAVE_SWIPE_LEFT_FAIL_DISTANCE = 8;
export const SAVE_SWIPE_DOMINANCE_RATIO = 1.5;

export function getSaveRevealTranslation(translationX: number) {
  'worklet';

  if (translationX <= 0) return 0;
  return Math.min(translationX, SAVE_REVEAL_WIDTH);
}

export function shouldRevealSaveAction(translationX: number, translationY: number) {
  'worklet';

  return (
    translationX >= SAVE_REVEAL_THRESHOLD
    && translationX > Math.abs(translationY) * SAVE_SWIPE_DOMINANCE_RATIO
  );
}
