export function shareResultConfirmsCompletion(
  platform: string,
  resultAction: string,
  sharedAction: string,
): boolean {
  // React Native reports sharedAction even when Android's chooser is dismissed.
  // iOS is the only supported platform whose result distinguishes dismissal.
  return platform === 'ios' && resultAction === sharedAction;
}
