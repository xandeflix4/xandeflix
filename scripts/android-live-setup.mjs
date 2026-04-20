import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

const PORT = String(process.env.CAPACITOR_LIVE_PORT || '5173');

const run = (adbPath, args) => {
  const result = spawnSync(adbPath, args, {
    encoding: 'utf8',
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const stderr = String(result.stderr || '').trim();
    const stdout = String(result.stdout || '').trim();
    throw new Error(
      `Failed running: ${adbPath} ${args.join(' ')}\n${stderr || stdout || 'No output from adb'}`
    );
  }

  return String(result.stdout || '');
};

const canRun = (command) => {
  const result = spawnSync(command, ['version'], {
    encoding: 'utf8',
  });
  return !result.error && result.status === 0;
};

const collectAdbCandidates = () => {
  const candidates = [];
  const pushIfPresent = (value) => {
    if (value && !candidates.includes(value)) {
      candidates.push(value);
    }
  };

  pushIfPresent(process.env.ADB_PATH);

  const sdkRoots = [process.env.ANDROID_SDK_ROOT, process.env.ANDROID_HOME].filter(Boolean);
  for (const sdkRoot of sdkRoots) {
    pushIfPresent(path.join(sdkRoot, 'platform-tools', 'adb'));
    pushIfPresent(path.join(sdkRoot, 'platform-tools', 'adb.exe'));
  }

  const windowsUsersRoot = '/mnt/c/Users';
  if (existsSync(windowsUsersRoot)) {
    const users = readdirSync(windowsUsersRoot, { withFileTypes: true });
    for (const user of users) {
      if (!user.isDirectory() || user.name.startsWith('.')) {
        continue;
      }
      pushIfPresent(
        path.join(
          windowsUsersRoot,
          user.name,
          'AppData',
          'Local',
          'Android',
          'Sdk',
          'platform-tools',
          'adb.exe'
        )
      );
    }
  }

  pushIfPresent('adb');
  pushIfPresent('adb.exe');

  return candidates;
};

const resolveAdbPath = () => {
  for (const candidate of collectAdbCandidates()) {
    if (canRun(candidate)) {
      return candidate;
    }
  }
  return null;
};

const parseConnectedDevices = (adbDevicesOutput) =>
  adbDevicesOutput
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .map((line) => line.match(/^([^\s]+)\s+device\b/))
    .filter(Boolean)
    .map((match) => match[1]);

const adbPath = resolveAdbPath();
if (!adbPath) {
  console.error('[android-live] adb was not found. Set ADB_PATH or ANDROID_SDK_ROOT and try again.');
  process.exit(1);
}

console.log(`[android-live] Using adb: ${adbPath}`);
run(adbPath, ['start-server']);

const devicesOutput = run(adbPath, ['devices', '-l']);
const connectedDevices = parseConnectedDevices(devicesOutput);

if (connectedDevices.length === 0) {
  console.error('[android-live] No connected Android devices were found.');
  console.error(devicesOutput.trim());
  process.exit(1);
}

for (const deviceId of connectedDevices) {
  run(adbPath, ['-s', deviceId, 'reverse', `tcp:${PORT}`, `tcp:${PORT}`]);
  console.log(`[android-live] Reverse TCP ready for ${deviceId}: tcp:${PORT} -> tcp:${PORT}`);
}

console.log('[android-live] Setup complete.');
