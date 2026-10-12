/**
 * Dev check: settings survive a save, and the assistant's API key does not.
 *
 * The assistant is gone, but settings.json written by an older build still
 * carries an `apiKeyEnc` blob in it - and, on builds where safeStorage was
 * unavailable, a plaintext `apiKey` beside it. Nothing reads either any more,
 * so it is easy to leave them there and call it harmless.
 *
 * Two things have to stay true, and they pull in opposite directions:
 *
 *   1. A save must take the retired keys with it. The secrets especially: a
 *      plaintext key sitting in a JSON file is a real liability, and it has no
 *      reader, so there is nothing to weigh it against.
 *
 *   2. A save must NOT take every key it does not recognise with it. Settings
 *      are forward-compatible by construction - the app writes the whole file,
 *      so an older build that rewrote it from DEFAULTS alone would silently
 *      destroy settings written by a newer one. Stripping "unknown" keys is
 *      therefore the wrong repair, and it is the obvious one to reach for.
 *
 * The retired keys are removed by name (RETIRED in settings.js), not by
 * omission from DEFAULTS. These checks pin both halves, so neither can be
 * "fixed" by breaking the other.
 *
 * Run with `npm run check:settings`.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { SettingsStore, DEFAULTS } = require('../src/main/settings.js');

const results = [];
const add = (name, ok, detail) => results.push({ name, ok, detail });

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-settings-'));
  return dir;
}

/** The file as bytes, which is the only thing that decides what survived. */
function onDisk(store) {
  return JSON.parse(fs.readFileSync(store.file, 'utf8'));
}

function main() {
  // --- a store written by an older build -----------------------------------
  {
    const dir = scratch();
    const file = path.join(dir, 'settings.json');
    fs.writeFileSync(file, JSON.stringify({
      theme: 'dark',
      textScale: 1.25,
      apiKeyEnc: 'BASE64-SECRET',
      apiKey: 'sk-plaintext-leftover',
      model: 'gpt-4o-mini',
      provider: 'openai',
    }, null, 2), 'utf8');

    const store = new SettingsStore(dir);
    const read = store.read();

    add('read() never hands the key back', read.apiKey === undefined && read.apiKeyEnc === undefined,
      'read() exposed an api key');
    add('read() never hands back hasApiKey', read.hasApiKey === undefined,
      'read() still reports hasApiKey');
    add('read() keeps the settings that are still used', read.theme === 'dark' && read.textScale === 1.25,
      `got theme=${read.theme} textScale=${read.textScale}`);

    // Saving anything must take the secret with it. If write() is rebuilt from
    // read() this is the assertion that fails, because payload never has the
    // key in it and a delete on an absent property is a no-op.
    store.write({ theme: 'light' });

    const after = onDisk(store);
    add('saving a setting takes the encrypted key off disk', after.apiKeyEnc === undefined,
      `apiKeyEnc survived the save: ${String(after.apiKeyEnc)}`);
    add('saving a setting takes the plaintext key off disk', after.apiKey === undefined,
      `apiKey survived the save: ${String(after.apiKey)}`);
    add('the save itself landed', after.theme === 'light',
      `theme is ${String(after.theme)}`);
    add('the assistant-only keys go too', after.model === undefined && after.provider === undefined,
      `model=${String(after.model)} provider=${String(after.provider)}`);

    // --- forward compatibility --------------------------------------------
    const dir2 = scratch();
    const file2 = path.join(dir2, 'settings.json');
    fs.writeFileSync(file2, JSON.stringify({
      theme: 'dark',
      someSettingFromANewerBuild: { nested: true },
    }, null, 2), 'utf8');
    const store2 = new SettingsStore(dir2);
    store2.write({ sendOnEnter: false });
    const after2 = onDisk(store2);
    add('a key this version does not know about survives a save',
      after2.someSettingFromANewerBuild && after2.someSettingFromANewerBuild.nested === true,
      `got ${JSON.stringify(after2.someSettingFromANewerBuild)}`);
    add('the patch is applied alongside it', after2.sendOnEnter === false && after2.theme === 'dark',
      `sendOnEnter=${String(after2.sendOnEnter)} theme=${String(after2.theme)}`);
  }

  // --- a fresh store ------------------------------------------------------
  {
    const dir = scratch();
    const store = new SettingsStore(dir);
    const fresh = store.read();
    const missing = Object.keys(DEFAULTS).filter((k) => !(k in fresh));
    add('a store with no file reads as the defaults', missing.length === 0,
      `missing ${missing.join(', ')}`);

    const bad = path.join(scratch(), 'settings.json');
    fs.writeFileSync(bad, 'this is not json');
    add('a corrupt file reads as the defaults rather than throwing',
      new SettingsStore(path.dirname(bad)).read().theme === DEFAULTS.theme, 'threw or drifted');

    const round = new SettingsStore(dir);
    round.write({ theme: 'dark', textScale: 1.1 });
    const back = round.read();
    add('a normal setting round-trips', back.theme === 'dark' && back.textScale === 1.1,
      `theme=${String(back.theme)} textScale=${String(back.textScale)}`);
  }

  let failed = 0;
  for (const r of results) {
    if (!r.ok) failed++;
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok || !r.detail ? '' : `  [${r.detail}]`}`);
  }
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

main();
