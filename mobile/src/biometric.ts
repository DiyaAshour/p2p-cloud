import * as LocalAuthentication from 'expo-local-authentication';
import { loadDrivePassword } from './storage';

export async function canUseBiometricUnlock() {
  const compatible = await LocalAuthentication.hasHardwareAsync();
  const enrolled = await LocalAuthentication.isEnrolledAsync();
  return compatible && enrolled;
}

export async function unlockDrivePasswordWithBiometrics() {
  const available = await canUseBiometricUnlock();
  if (!available) throw new Error('Biometric unlock is not available on this device.');

  const result = await LocalAuthentication.authenticateAsync({
    promptMessage: 'Unlock p2p.cloud Drive',
    cancelLabel: 'Cancel',
    disableDeviceFallback: false,
  });

  if (!result.success) throw new Error('Biometric unlock cancelled or failed.');
  const password = await loadDrivePassword();
  if (!password) throw new Error('No saved Drive Password found. Save your session first.');
  return password;
}
