export const DEFAULT_SCIP_BUNDLE_PATH = 'scip';

export type ScipBundlePath = typeof DEFAULT_SCIP_BUNDLE_PATH;

const SCIP_BUNDLE_CACHE_VERSION =
  '2026-10-04-native-abi4-produced-pollution-flow-status-tolerance-4';

function withBasePath(path: string): string {
  const basePath = import.meta.env.BASE_URL || '/';
  return `${basePath.replace(/\/$/, '')}/${path.replace(/^\/+/, '')}`;
}

export function normalizeScipBundlePath(value: unknown): ScipBundlePath {
  if (typeof value === 'string' && value.trim().replace(/^\/+|\/+$/g, '') === 'scip') {
    return DEFAULT_SCIP_BUNDLE_PATH;
  }
  return DEFAULT_SCIP_BUNDLE_PATH;
}

export function getConfiguredScipBundlePath(): ScipBundlePath {
  return normalizeScipBundlePath(import.meta.env.VITE_SCIP_BUNDLE);
}

export function getScipAssetPath(
  fileName: string,
  bundlePath: ScipBundlePath,
  version?: string,
): string {
  const params = new URLSearchParams();
  if (version) {
    params.set('v', version);
  }
  params.set('scipv', SCIP_BUNDLE_CACHE_VERSION);
  return withBasePath(`/${bundlePath}/${fileName}`) + `?${params.toString()}`;
}

export function getScipAssetUrl(
  origin: string,
  fileName: string,
  bundlePath: ScipBundlePath,
  version?: string,
): string {
  return new URL(getScipAssetPath(fileName, bundlePath, version), `${origin}/`).href;
}
