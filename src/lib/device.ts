import { Platform } from 'react-native';

export function isAndroidTabletLayout(width: number, height: number): boolean {
  if (Platform.OS !== 'android') {
    return false;
  }

  return Math.min(width, height) >= 600;
}
