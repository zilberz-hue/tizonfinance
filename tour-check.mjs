// Runs before every build. Stops it when the guided tours fell behind the app:
// a step that points at an element no longer on any screen, a step newer than
// the version, a version without a "what's new" entry, or a tab with no tour.
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('./App.jsx', import.meta.url), 'utf8');
const errors = [], warns = [];
const version = src.match(/const VERSION = '([\d.]+)'/)?.[1];
const cmp = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); return 0; };
const block = (name) => { const i = src.indexOf(`const ${name} = `); if (i < 0) return ''; return src.slice(i, src.indexOf('\n};', i) + 3); };

const tours = block('TOURS');
if (!tours) errors.push('TOURS not found');
const anchors = new Set([...src.matchAll(/data-tour="([a-z0-9-]+)"/g)].map(m => m[1]));
const used = new Set();
let ctx = '', steps = 0;
for (const line of tours.split('\n')) {
  const c = line.match(/^  ([a-z]+): \[/); if (c) ctx = c[1];
  if (!/since: '/.test(line)) continue;
  steps++;
  const t = line.match(/\bt: '([a-z0-9-]+)'/)?.[1];
  const since = line.match(/since: '([\d.]+)'/)?.[1];
  if (t) { used.add(t); if (!anchors.has(t)) errors.push(`${ctx}: step points at data-tour="${t}", which is not on any screen`); }
  if (!since) errors.push(`${ctx}: step without a version (since)`);
  else if (cmp(since, version) > 0) errors.push(`${ctx}: step marked ${since}, newer than VERSION ${version}`);
  if (!/title: '/.test(line) || !/text: '/.test(line)) errors.push(`${ctx}: step without title or text`);
}
const changes = block('CHANGES');
const firstV = changes.match(/v: '([\d.]+)'/)?.[1];
if (firstV !== version) errors.push(`CHANGES has no entry for ${version} (top entry: ${firstV}). Add what changed in this version.`);
const subs = src.match(/const SUBS = \[([\s\S]*?)\]\s*\n\s*\.filter/)?.[1] || '';
for (const k of [...subs.matchAll(/\['([a-z]+)',/g)].map(m => m[1]))
  if (!new RegExp(`^  ${k}: \\[`, 'm').test(tours)) errors.push(`tab "${k}" has no tour`);
for (const a of anchors) if (!used.has(a)) warns.push(`data-tour="${a}" has no step`);

warns.forEach(w => console.warn('tour-check · warning · ' + w));
if (errors.length) { errors.forEach(e => console.error('tour-check · ' + e)); process.exit(1); }
console.log(`tour-check · ${steps} steps, ${anchors.size} anchors, version ${version} · OK`);
