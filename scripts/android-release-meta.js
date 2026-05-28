#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const appConfigPath = path.join(projectRoot, 'app.json');
const outputFormatArg = process.argv.find((arg) => arg.startsWith('--format='));
const outputFormat = outputFormatArg ? outputFormatArg.slice('--format='.length) : 'json';
const versionCodeBase = 1000000;
const semverPattern = /^(\d+)\.(\d+)\.(\d+)$/;
const releaseTagPattern = /^v(\d+)\.(\d+)\.(\d+)(?:-build\.\d+)?$/;

function readAppVersion() {
  const appConfig = JSON.parse(fs.readFileSync(appConfigPath, 'utf8'));

  if (!appConfig.expo?.version) {
    throw new Error('Expected expo.version in app.json');
  }

  return String(appConfig.expo.version);
}

function parseSemver(version, label) {
  const match = semverPattern.exec(String(version).trim());

  if (!match) {
    throw new Error(`Expected ${label} to be x.y.z, got: ${version}`);
  }

  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
  };
}

function formatSemver(version) {
  return `${version.major}.${version.minor}.${version.patch}`;
}

function readGitTags() {
  const output = execFileSync('git', ['tag', '--list'], {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

  return output ? output.split('\n') : [];
}

function readVersionName() {
  if (process.env.VPLAYER_VERSION_NAME) {
    return process.env.VPLAYER_VERSION_NAME;
  }

  const baseVersion = parseSemver(readAppVersion(), 'expo.version in app.json');
  const highestPatch = readGitTags().reduce((maxPatch, tag) => {
    const match = releaseTagPattern.exec(tag);

    if (!match) {
      return maxPatch;
    }

    const tagVersion = {
      major: Number.parseInt(match[1], 10),
      minor: Number.parseInt(match[2], 10),
      patch: Number.parseInt(match[3], 10),
    };

    if (tagVersion.major !== baseVersion.major || tagVersion.minor !== baseVersion.minor) {
      return maxPatch;
    }

    return Math.max(maxPatch, tagVersion.patch);
  }, baseVersion.patch - 1);

  return formatSemver({
    ...baseVersion,
    patch: highestPatch + 1,
  });
}

function readGitCommitCount() {
  return execFileSync('git', ['rev-list', '--count', 'HEAD'], {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function readVersionCode() {
  const rawValue = process.env.VPLAYER_VERSION_CODE || String(versionCodeBase + Number.parseInt(readGitCommitCount(), 10));
  const parsedValue = Number.parseInt(String(rawValue), 10);

  if (!Number.isInteger(parsedValue) || parsedValue <= 0) {
    throw new Error(`Invalid Android versionCode: ${rawValue}`);
  }

  return parsedValue;
}

function sanitizeVersionName(versionName) {
  return versionName.replace(/[^0-9A-Za-z._-]/g, '-');
}

function createMetadata() {
  const versionName = readVersionName();
  const versionCode = readVersionCode();

  return {
    apk_name: `vplayer-${sanitizeVersionName(versionName)}.apk`,
    app_version: versionName,
    build_number: String(versionCode),
    release_tag: `v${versionName}-build.${versionCode}`,
    versionCodeBase,
    versionCode,
    versionName,
  };
}

function writeMetadata(metadata) {
  if (outputFormat === 'github-output') {
    for (const [key, value] of Object.entries(metadata)) {
      process.stdout.write(`${key}=${value}\n`);
    }
    return;
  }

  if (outputFormat === 'json') {
    process.stdout.write(`${JSON.stringify(metadata)}\n`);
    return;
  }

  throw new Error(`Unsupported output format: ${outputFormat}`);
}

try {
  writeMetadata(createMetadata());
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
