// After Vite builds the SPA into dist/manage, copy widget + edge files into dist/.
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildVersion } from './version.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');

mkdirSync(dist, { recursive: true });

// Stamp the widget build version (source keeps the __FF_BUILD_VERSION__ sentinel so
// git stays clean). The embed URL's ?v=<version> must match this.
const version = buildVersion();
const widgetSrc = readFileSync(join(root, 'widget', 'widget.js'), 'utf8');
writeFileSync(join(dist, 'widget.js'), widgetSrc.split('__FF_BUILD_VERSION__').join(version));

cpSync(join(root, 'static', '_routes.json'), join(dist, '_routes.json'));
cpSync(join(root, 'static', '_redirects'), join(dist, '_redirects'));
cpSync(join(root, 'static', '_headers'), join(dist, '_headers'));
cpSync(join(root, 'static', 'dental-implants-super-preview.html'), join(dist, 'dental-implants-super-preview.html'));
console.log('after-build: dist ready (widget.js v' + version + ' + edge config + SPA)');
