/**
 * check:syntax - every JS file in the project must parse.
 *
 * Why this exists: a comment containing backticks was written inside the
 * template literal that holds a check harness's page script. The backticks
 * closed the string early, the rest was parsed as JavaScript, and the file
 * became a SyntaxError. Under `electron` that is an uncaught exception in the
 * main process, which raises a modal "A JavaScript error occurred" dialog on
 * the developer's desktop - it looks exactly like the app under test crashing,
 * and it is invisible until someone happens to run that check.
 *
 * It is a plain Node check on purpose. It needs no Electron, opens no window,
 * and cannot produce a dialog; `node --check` reports the file and the line.
 *
 * The extension matters. This package.json declares no "type", so `node --check`
 * would read every .js as CommonJS and reject the renderer's `import`. Each file
 * is therefore staged under .mjs or .cjs to match what it actually is.
 *
 * Run with `npm run check:syntax`.
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', 'release', 'dist', '.git', 'docs']);

/**
 * Build output, whatever it is called. A scratch name like release-new/ is how
 * you get around a Windows file lock on a stale artifact, and parsing the
 * vendored Electron sources inside it would be both slow and meaningless.
 */
function isBuildOutput(name) {
  return SKIP_DIRS.has(name) || name.startsWith('release-');
}

/**
 * Pull out a check harness's page script and parse it.
 *
 * The harness is held in a template literal, so it is a *string* to the file
 * parser above: a file can parse perfectly and still be broken inside. Two
 * ways that has actually happened here - a comment with backticks closing the
 * literal early, and a parameter shadowed by a const in the same function.
 * Neither shows up until the harness is evaluated, which under electron means
 * a modal "A JavaScript error occurred" dialog rather than a failed check.
 *
 * The `${...}` interpolations are replaced with a placeholder, since they are
 * deliberately not valid in the extracted text on their own.
 *
 * The marker has to be at the start of a line. A file can contain the marker
 * inside a string - the launcher check writes a deliberately broken harness as
 * a fixture, so the marker text has to appear in it - and a search that
 * matched there would report a file as broken that is perfectly fine.
 */
const HARNESS_DECL = /^[ \t]*const harness = /m;
const HARNESS_OPEN = /^[ \t]*const harness = (?:String\.raw)?`/m;
/** Replace each `${...}` with a literal, respecting nested braces and strings. */
function blankInterpolations(text) {
  let out = '';
  for (let i = 0; i < text.length;) {
    if (text[i] === '$' && text[i + 1] === '{') {
      out += 'null';
      i += 2;
      let depth = 1;
      let quote = null;
      while (i < text.length && depth > 0) {
        const ch = text[i];
        if (quote) {
          if (ch === '\\') i += 1;
          else if (ch === quote) quote = null;
        } else if (ch === '"' || ch === "'" || ch === '`') quote = ch;
        else if (ch === '{') depth += 1;
        else if (ch === '}') depth -= 1;
        i += 1;
      }
      continue;
    }
    out += text[i];
    i += 1;
  }
  return out;
}

function checkHarness(file, source) {
  if (!HARNESS_DECL.test(source)) return null;

  const open = HARNESS_OPEN.exec(source);
  if (!open) return 'harness template has no opening backtick';

  const from = open.index + open[0].length - 1;
  const end = source.indexOf('\n  `;', from);
  if (end < 0) return 'harness template has no closing backtick';

  const text = blankInterpolations(source.slice(from + 1, end + 1));

  try {
    new vm.Script(text);
    return null;
  } catch (err) {
    return `harness page script does not parse: ${err.message}`;
  }
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!isBuildOutput(entry.name)) walk(path.join(dir, entry.name), out);
    } else if (entry.isFile() && /\.(js|mjs|cjs)$/.test(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

/** CommonJS or an ES module, told by the syntax it actually uses. */
function looksLikeEsm(source) {
  return /^\s*(import\s|export\s|import\{|import\()/m.test(source);
}

function main() {
  const files = walk(ROOT);
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-syntax-'));
  const problems = [];
  let harnesses = 0;

  try {
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8');
      const rel = path.relative(ROOT, file);
      const ext = looksLikeEsm(source) ? '.mjs' : '.cjs';
      const staged = path.join(stage, `${rel.replace(/[\\/]/g, '_')}${ext}`);
      fs.writeFileSync(staged, source, 'utf8');

      let bad = null;
      try {
        execFileSync(process.execPath, ['--check', staged], { stdio: ['ignore', 'ignore', 'pipe'] });
      } catch (err) {
        // Node reports "file:line" against the staged copy; map it back.
        const detail = String(err.stderr || err.message)
          .split('\n')
          .filter((line) => /SyntaxError|^\s*\^|Error:/.test(line))
          .slice(0, 3)
          .join(' ')
          .replace(new RegExp(staged.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), rel);
        bad = detail;
      }

      if (!bad) {
        // This file used to be excluded from the harness rule because it
        // mentions the marker itself. The marker is now matched at the start
        // of a line, so this file no longer matches its own rule and can be
        // held to it like every other file.
        const harnessProblem = checkHarness(file, source);
        if (harnessProblem) bad = harnessProblem;
        else if (HARNESS_DECL.test(source)) harnesses += 1;
      }

      if (bad) problems.push(`${rel}  ${bad}`);
    }
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }

  console.log(`files parsed: ${files.length}`);
  console.log(`harnesses parsed: ${harnesses}`);

  if (problems.length === 0) {
    console.log('\nOK  every JS file parses.');
    return;
  }

  console.log(`\n${problems.length} file(s) do not parse:`);
  for (const p of problems) console.log(`  ${p}`);
  process.exit(1);
}

// Run as a script, or be required for its detector. The check that guards the
// detector requires this file, and requiring it must not start a walk of the
// whole repository.
if (require.main === module) main();

module.exports = { checkHarness, blankInterpolations, HARNESS_DECL, HARNESS_OPEN };
