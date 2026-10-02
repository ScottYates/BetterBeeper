/**
 * check:ascii - keep documentation ASCII-only.
 *
 * Markdown must be pure ASCII end to end. Source files are different: the UI
 * legitimately shows emoji, arrows and check marks, and the dev tools print
 * them too. What must stay ASCII is *prose the reader reads*: markdown, and
 * every comment in src/ and tools/.
 *
 * Comments are found with a small block-comment state machine rather than a real
 * parser, which is enough here because the codebase does not put comment-looking
 * text inside template literals. A line that genuinely needs a symbol can opt out
 * with a trailing `ascii-ok` marker.
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

const DOC_EXT = new Set(['.md']);
const CODE_EXT = new Set(['.js', '.mjs', '.cjs', '.css', '.html', '.yml', '.yaml']);
const SKIP_DIRS = new Set(['node_modules', 'release', 'dist', '.git', 'docs']);

const OPT_OUT = 'ascii-ok';
const NON_ASCII = /[^\x00-\x7F]/;

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), out);
    } else if (entry.isFile()) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

/** Describe a non-ASCII character well enough to go and find it. */
function describe(text) {
  return [...text]
    .filter((c) => NON_ASCII.test(c))
    .map((c) => {
      const cp = c.codePointAt(0);
      return `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
    })
    .join(' ');
}

function checkMarkdown(files, problems) {
  let checked = 0;
  for (const file of files) {
    if (!DOC_EXT.has(path.extname(file))) continue;
    checked += 1;
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      if (!NON_ASCII.test(line) || line.includes(OPT_OUT)) return;
      problems.push(`${path.relative(ROOT, file)}:${i + 1}  ${describe(line)}  ${line.trim().slice(0, 60)}`);
    });
  }
  return checked;
}

function checkComments(files, problems) {
  let checked = 0;
  let comments = 0;
  for (const file of files) {
    if (!CODE_EXT.has(path.extname(file))) continue;
    checked += 1;
    const rel = path.relative(ROOT, file);
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    let inBlock = false;
    lines.forEach((line, i) => {
      const trimmed = line.trim();
      let isComment = false;
      if (inBlock) {
        isComment = true;
        if (trimmed.includes('*/')) inBlock = false;
      } else if (trimmed.startsWith('//')) {
        isComment = true;
      } else if (trimmed.startsWith('/*')) {
        isComment = true;
        if (!trimmed.includes('*/')) inBlock = true;
      } else if (trimmed.startsWith('*')) {
        // Continuation of a block comment, or a css/html doc block.
        isComment = true;
      }
      if (!isComment || !NON_ASCII.test(line) || line.includes(OPT_OUT)) return;
      comments += 1;
      problems.push(`${rel}:${i + 1}  ${describe(line)}  ${trimmed.slice(0, 60)}`);
    });
  }
  return { checked, comments };
}

function main() {
  const files = walk(ROOT);
  const problems = [];

  const docs = checkMarkdown(files, problems);
  const code = checkComments(files, problems);

  console.log(`markdown files : ${docs} (must be pure ASCII)`);
  console.log(`code files     : ${code.checked} (comments must be ASCII)`);

  if (problems.length === 0) {
    console.log('\nOK  no non-ASCII characters in documentation or comments.');
    return;
  }

  console.log(`\n${problems.length} problem(s):`);
  for (const p of problems) console.log(`  ${p}`);
  console.log('\nUI strings and dev-tool output may still use symbols; those are not checked.');
  process.exit(1);
}

main();
