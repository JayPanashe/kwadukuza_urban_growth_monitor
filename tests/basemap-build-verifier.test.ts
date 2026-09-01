import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const verifierPath = path.join(repositoryRoot, 'scripts', 'verify_basemap_build.mjs');
const tileEndpoint = 'https://api.mapbox.com/styles/v1/mapbox/light-v11/tiles/512/{z}/{x}/{y}?access_token=';
const temporaryRoots: string[] = [];

function createFixture(source: string, builtJavaScript: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ugm-basemap-verifier-'));
  temporaryRoots.push(root);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'dist', 'assets'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'basemap.ts'), source);
  fs.writeFileSync(path.join(root, 'dist', 'assets', 'index.js'), builtJavaScript);
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  execFileSync('git', ['add', 'src/basemap.ts'], { cwd: root });
  return root;
}

function runVerifier(root: string, configuredToken?: string, release = false) {
  const env = { ...process.env };
  if (configuredToken === undefined) delete env.VITE_MAPBOX_ACCESS_TOKEN;
  else env.VITE_MAPBOX_ACCESS_TOKEN = configuredToken;
  return spawnSync(process.execPath, [verifierPath, '--root', root, ...(release ? ['--release'] : [])], {
    encoding: 'utf8',
    env,
  });
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('post-build basemap verifier', () => {
  it('accepts the Mapbox Light endpoint and verifies a configured token without printing it', () => {
    const token = 'pk.sentinel-build-token';
    const root = createFixture(
      `const endpoint = '${tileEndpoint}'; const token = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN;`,
      `const endpoint = '${tileEndpoint}'; const token = '${token}';`,
    );

    const result = runVerifier(root, token);
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).toBe(0);
    expect(output).not.toContain(token);
  });

  it('fails when a configured token is absent from the build without printing it', () => {
    const token = 'pk.sentinel-missing-from-build';
    const root = createFixture(
      `const endpoint = '${tileEndpoint}'; const token = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN;`,
      `const endpoint = '${tileEndpoint}';`,
    );

    const result = runVerifier(root, token);
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain('Basemap build verification failed');
    expect(output).not.toContain(token);
  });

  it.each([
    ['tracked source legacy provider marker', 'const provider = "CARTO";', `${tileEndpoint}`],
    ['tracked source legacy hostname', 'const endpoint = "https://a.basemaps.cartocdn.com/light";', `${tileEndpoint}`],
    [
      'built missing-key marker',
      `const endpoint = '${tileEndpoint}';`,
      `const endpoint = '${tileEndpoint}'; const message = 'API KEY REQUIRED';`,
    ],
  ])('rejects a %s', (_name, source, builtJavaScript) => {
    const root = createFixture(source, builtJavaScript);

    const result = runVerifier(root);

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain('Basemap build verification failed');
  });

  it('rejects a production-looking public token in tracked source without echoing it', () => {
    const productionLookingToken = 'pk.abcdefghijklmnopqrstuvwxyz012345.ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';
    const root = createFixture(
      `const endpoint = '${tileEndpoint}'; const token = '${productionLookingToken}';`,
      tileEndpoint,
    );

    const result = runVerifier(root);
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain('Basemap build verification failed');
    expect(output).not.toContain(productionLookingToken);
  });

  it('rejects built JavaScript that omits the Mapbox Light endpoint', () => {
    const root = createFixture('const token = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN;', 'const renderer = "webgl";');

    const result = runVerifier(root, 'pk.sentinel-build-token');

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain('Basemap build verification failed');
  });

  it('allows a tokenless generic build but rejects a tokenless release build', () => {
    const root = createFixture(
      `const endpoint = '${tileEndpoint}'; const token = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN;`,
      `const warning = 'Mapbox basemap unavailable: token is not configured';`,
    );

    expect(runVerifier(root).status).toBe(0);
    expect(runVerifier(root, undefined, true).status).toBe(1);
  });

  it.each(['sk.secret-token', 'not-a-mapbox-token'])('rejects %s in release mode without printing it', (token) => {
    const root = createFixture(
      `const endpoint = '${tileEndpoint}'; const token = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN;`,
      `const endpoint = '${tileEndpoint}'; const token = '${token}';`,
    );

    const result = runVerifier(root, token, true);
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).not.toContain(token);
  });
});
