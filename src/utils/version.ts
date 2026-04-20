/**
 * Version comparison and GitHub Release helpers for tarball-based updates.
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { version: CURRENT_VERSION } = require('../../package.json') as { version: string };

const REPO = 'wtokarzewski/janus-agent';
const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;

export { CURRENT_VERSION };

/**
 * Compare two semver strings. Returns true if `latest` is newer than `current`.
 * Strips leading 'v' prefix if present.
 */
export function isNewerVersion(current: string, latest: string): boolean {
  const parse = (v: string) => v.replace(/^v/, '').split('.').map(Number);
  const [cMaj, cMin, cPat] = parse(current);
  const [lMaj, lMin, lPat] = parse(latest);
  if (lMaj !== cMaj) return lMaj > cMaj;
  if (lMin !== cMin) return lMin > cMin;
  return lPat > cPat;
}

export interface ReleaseInfo {
  version: string;       // e.g. "1.0.1" (no v prefix)
  tag: string;           // e.g. "v1.0.1"
  tarballUrl: string;    // browser_download_url of the .tar.gz asset
  publishedAt: string;   // ISO date
}

/**
 * Query GitHub Releases API for the latest release.
 * Returns null if no release found or network error.
 */
export async function getLatestRelease(): Promise<ReleaseInfo | null> {
  try {
    const res = await fetch(API_URL, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;

    const data = await res.json() as {
      tag_name: string;
      published_at: string;
      assets: Array<{ name: string; browser_download_url: string }>;
    };

    const asset = data.assets.find(a => a.name.endsWith('.tar.gz'));
    if (!asset) return null;

    return {
      version: data.tag_name.replace(/^v/, ''),
      tag: data.tag_name,
      tarballUrl: asset.browser_download_url,
      publishedAt: data.published_at,
    };
  } catch {
    return null;
  }
}

/**
 * Download a file from URL to a local path.
 */
export async function downloadFile(url: string, destPath: string): Promise<void> {
  const { createWriteStream } = await import('node:fs');
  const { pipeline } = await import('node:stream/promises');

  const res = await fetch(url, {
    signal: AbortSignal.timeout(120_000),
    headers: { Accept: 'application/octet-stream' },
  });

  if (!res.ok || !res.body) {
    throw new Error(`Download failed: HTTP ${res.status}`);
  }

  const fileStream = createWriteStream(destPath);
  await pipeline(res.body, fileStream);
}
