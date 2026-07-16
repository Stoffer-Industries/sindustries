import * as Updates from 'expo-updates';

export type UpdateInfo = {
  updateId: string | null;
  runtimeVersion: string | null;
  channel: string | null;
  createdAt: Date | null;
  isEmbeddedLaunch: boolean;
  isEnabled: boolean;
};

export function getCurrentUpdateInfo(): UpdateInfo {
  return {
    updateId: Updates.updateId,
    runtimeVersion: Updates.runtimeVersion,
    channel: Updates.channel,
    createdAt: Updates.createdAt,
    isEmbeddedLaunch: Updates.isEmbeddedLaunch,
    isEnabled: Updates.isEnabled
  };
}

export function formatUpdateShortId(updateId: string | null): string {
  if (!updateId) return 'dev build';
  return updateId.slice(0, 8);
}

export function formatUpdateTimestamp(createdAt: Date | null): string {
  if (!createdAt) return 'No OTA timestamp';
  return createdAt.toISOString();
}
