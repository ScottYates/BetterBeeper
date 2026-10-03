/**
 * Dev check: the preload surface, the IPC handlers, and the renderer agree.
 *
 * There are three hand-maintained lists of the same API, and nothing in the
 * language stops them from drifting:
 *
 *   src/preload/preload.js   the contextBridge surface
 *   src/main/ipc.js          ipcMain.handle for each channel
 *   src/renderer/js/api.js   the renderer's own mirror of the surface
 *
 * Adding an upload for pasted images updated the preload and forgot the mirror,
 * and the result was a paste that did nothing at all with a toast saying
 * "api.assets.uploadBytes is not a function". Every other check passed,
 * because the broken part was a missing line rather than wrong behaviour.
 *
 * This parses the three files and asserts they describe the same API.
 *
 * Run with `npm run check:api`.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PRELOAD = path.join(ROOT, 'src', 'preload', 'preload.js');
const IPC = path.join(ROOT, 'src', 'main', 'ipc.js');
const API = path.join(ROOT, 'src', 'renderer', 'js', 'api.js');
const RENDERER = path.join(ROOT, 'src', 'renderer', 'js');

const read = (file) => fs.readFileSync(file, 'utf8');

/**
 * Pull the contextBridge surface out of the preload: a group is a line that
 * ends in "{", and its members are the lines indented one step further that
 * declare a name followed by a colon.
 */
function parsePreload(source) {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((l) => l.includes("exposeInMainWorld('beeper'"));
  if (start === -1) throw new Error('preload does not expose "beeper"');

  const surface = new Map(); // "group.method" -> ipc channel
  let group = null;
  let groupIndent = 0;

  for (const line of lines.slice(start + 1)) {
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    const text = line.trim();

    if (/^\}/.test(text) && indent <= groupIndent && group) {
      group = null;
      continue;
    }

    const groupMatch = text.match(/^([A-Za-z_$][\w$]*):\s*\{$/);
    if (groupMatch) {
      group = groupMatch[1];
      groupIndent = indent;
      continue;
    }

    if (!group) continue;
    const methodMatch = text.match(/^([A-Za-z_$][\w$]*):\s*\(/);
    if (!methodMatch) continue;

    // Two kinds of member: invoke() is a request/response channel that needs
    // an ipcMain.handle, and on() is a push the main process emits. Only the
    // first has a handler to match.
    const request = text.match(/invoke\(\s*'([^']+)'/);
    const push = text.match(/\bon\(\s*'([^']+)'/);
    if (request) surface.set(`${group}.${methodMatch[1]}`, { channel: request[1], push: false });
    else if (push) surface.set(`${group}.${methodMatch[1]}`, { channel: push[1], push: true });
  }

  return surface;
}

/** Every channel ipc.js registers a handler for. */
function parseIpcChannels(source) {
  const channels = new Set();
  for (const m of source.matchAll(/ipcMain\.handle\(\s*'([^']+)'/g)) {
    channels.add(m[1]);
  }
  return channels;
}

/** Every window.beeper.<group>.<method> the renderer reaches for. */
function parseRendererUsage(dir) {
  const used = new Set();
  const files = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) files.push(full);
    }
  };
  walk(dir);

  for (const file of files) {
    const source = read(file);
    for (const m of source.matchAll(/window\.beeper\.([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)/g)) {
      used.add({ key: `${m[1]}.${m[2]}`, file: path.relative(ROOT, file) });
    }
  }
  return used;
}

/**
 * The renderer's own bridge object in src/renderer/js/api.js.
 *
 * This is the list that was forgotten when image paste was added: the preload
 * grew a method, api.js did not, and thread.js called the gap. Nothing in
 * JavaScript complains about a missing property until the moment it is used.
 *
 * The object deliberately mixes nested groups ("assets.upload") with flattened
 * ones ("authStatus"), so callers are matched against whichever shape they use.
 */
function parseApiMirror(source) {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((l) => l.includes('export const api = {'));
  if (start === -1) throw new Error('api.js has no "export const api"');

  const groups = new Set();
  const members = new Set();
  const flats = new Set();
  let group = null;
  let groupIndent = 0;

  for (const line of lines.slice(start + 1)) {
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    const text = line.trim();

    if (/^\}/.test(text) && indent <= groupIndent && group) {
      group = null;
      continue;
    }
    const groupMatch = text.match(/^([A-Za-z_$][\w$]*):\s*\{$/);
    if (groupMatch) {
      group = groupMatch[1];
      groups.add(group);
      groupIndent = indent;
      continue;
    }
    const memberMatch = text.match(/^([A-Za-z_$][\w$]*):\s*[(A-Za-z_$]/);
    if (!memberMatch) continue;
    if (group) members.add(`${group}.${memberMatch[1]}`);
    else flats.add(memberMatch[1]);
  }

  return { groups, members, flats };
}

/** Every api.<a>.<b> the renderer reaches for, with the file it came from. */
function parseApiUsage(dir) {
  const used = new Map();
  const files = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js') && entry.name !== 'api.js') files.push(full);
    }
  };
  walk(dir);

  for (const file of files) {
    const source = read(file);
    // The lookbehind keeps "https://api.openai.com/v1" in a string literal
    // from reading as a call into the bridge object.
    for (const m of source.matchAll(/(?<![A-Za-z0-9_.'":$/\\-])\bapi\.([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)/g)) {
      used.set(`${m[1]}.${m[2]}`, path.relative(ROOT, file));
    }
  }
  return used;
}

function main() {
  const preload = parsePreload(read(PRELOAD));
  const channels = parseIpcChannels(read(IPC));
  const used = parseRendererUsage(RENDERER);

  const results = [];
  const add = (name, ok, detail) => results.push({ name, ok, detail });

  for (const [key, { channel, push }] of preload) {
    if (push) continue;
    add(`${key} has an IPC handler (${channel})`, channels.has(channel),
      `no ipcMain.handle('${channel}') in src/main/ipc.js`);
  }

  const seen = new Set();
  for (const { key, file } of used) {
    if (seen.has(key)) continue;
    seen.add(key);
    add(`the renderer can reach window.beeper.${key}`, preload.has(key),
      `called from ${file} but missing from the preload surface`);
  }

  // Every api.<group>.<method> the renderer calls has to exist in api.js. This
  // is the assertion the missing mirror entry would have failed.
  const { groups, members, flats } = parseApiMirror(read(API));
  for (const [key, file] of parseApiUsage(RENDERER)) {
    const [head] = key.split('.');
    const defined = groups.has(head) ? members.has(key) : flats.has(head);
    add(`api.${key} is defined`, defined, `called from ${file} but not in api.js`);
  }

  let failed = 0;
  for (const r of results) {
    if (!r.ok) failed++;
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok || !r.detail ? '' : `  [${r.detail}]`}`);
  }
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  console.log(`preload surface: ${preload.size} methods, ${channels.size} IPC handlers, ${seen.size} renderer entry points`);
  process.exit(failed ? 1 : 0);
}

main();
