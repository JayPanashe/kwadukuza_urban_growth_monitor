import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAPBOX_LIGHT_ENDPOINT =
  'https://api.mapbox.com/styles/v1/mapbox/light-v11/tiles/512/{z}/{x}/{y}?access_token=';
const FORBIDDEN_MARKER = /\bCARTO\b|cartocdn\.com|API\s+KEY\s+REQUIRED/i;
const PRODUCTION_LOOKING_PUBLIC_TOKEN = /\bpk\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/;
const SECRET_TOKEN = /\bsk\.[A-Za-z0-9_-]+/;

function parseRoot(args) {
  let root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  let release = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--release') {
      release = true;
      continue;
    }
    if (args[index] === '--root' && args[index + 1]) {
      root = path.resolve(args[index + 1]);
      index += 1;
      continue;
    }
    throw new Error('usage');
  }
  return { root, release };
}

function sourceFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(entryPath);
    return entry.isFile() && /\.(?:css|html|ts)$/.test(entry.name) ? [entryPath] : [];
  });
}

function javaScriptFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return javaScriptFiles(entryPath);
    return entry.isFile() && entry.name.endsWith('.js') ? [entryPath] : [];
  });
}

function fail(reason) {
  console.error(`Basemap build verification failed: ${reason}.`);
  process.exitCode = 1;
}

function verify(root, release) {
  const source = sourceFiles(path.join(root, 'src')).map((file) => fs.readFileSync(file, 'utf8')).join('\n');
  const builtFiles = javaScriptFiles(path.join(root, 'dist'));
  const builtJavaScript = builtFiles.map((file) => fs.readFileSync(file, 'utf8')).join('\n');

  if (FORBIDDEN_MARKER.test(source)) return fail('forbidden legacy or missing-key marker in tracked source');
  if (FORBIDDEN_MARKER.test(builtJavaScript)) return fail('forbidden legacy or missing-key marker in built JavaScript');
  if (PRODUCTION_LOOKING_PUBLIC_TOKEN.test(source)) return fail('production-looking public token in tracked source');
  if (SECRET_TOKEN.test(source) || SECRET_TOKEN.test(builtJavaScript)) return fail('secret token found in build inputs or output');
  if (!source.includes(MAPBOX_LIGHT_ENDPOINT)) return fail('Mapbox Light endpoint missing from tracked source');

  const configuredToken = process.env.VITE_MAPBOX_ACCESS_TOKEN?.trim();
  if (release && !configuredToken) return fail('release token is not configured');
  if (configuredToken && !configuredToken.startsWith('pk.')) return fail('configured token is not a public token');
  if ((release || configuredToken) && !builtJavaScript.includes(MAPBOX_LIGHT_ENDPOINT)) {
    return fail('Mapbox Light endpoint missing from built JavaScript');
  }
  if (!release && !configuredToken && !builtJavaScript.includes('Mapbox basemap unavailable')) {
    return fail('tokenless build does not contain the fail-closed basemap fallback');
  }
  if (configuredToken && !builtJavaScript.includes(configuredToken)) {
    return fail('configured token missing from built JavaScript');
  }

  console.log('Basemap build verification passed.');
}

try {
  const { root, release } = parseRoot(process.argv.slice(2));
  verify(root, release);
} catch {
  fail('unable to inspect build artifacts');
}
