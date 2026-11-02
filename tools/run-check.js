/**
 * Runs a check, and never lets it reach the desktop.
 *
 * A check that does not parse is an uncaught exception in Electron's main
 * process, and Electron answers that with an error dialog on the screen: a
 * window that pops up in the middle of the desktop, looking like the app
 * under test crashing, for a mistake in a file nobody was even running.
 *
 * So the file is parsed before it is loaded. A file that does not parse is
 * reported here, in the terminal, and the process ends. Nothing is shown.
 *
 * The same goes for anything the check throws once it is running. Electron
 * shows its dialog when an exception reaches the top of the stack with
 * nobody listening; listening here is what stops it. A check that fails is a
 * check that failed, and it belongs in the output.
 *
 * Usage: electron tools/run-check.js tools/<name>-check.js
 */
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');

// An exception in a check is a failed check, not a crash of the desktop.
process.on('uncaughtException', (err) => {
  console.error(`uncaught: ${err && (err.stack || err.message)}`);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  console.error(`unhandled: ${err && (err.stack || err.message)}`);
  process.exit(1);
});

const target = process.argv[2];
if (!target) {
  console.error('usage: electron tools/run-check.js <check file>');
  process.exit(2);
}

const file = path.resolve(__dirname, '..', target);

let source;
try {
  source = fs.readFileSync(file, 'utf8');
} catch (err) {
  console.error(`cannot read ${target}: ${err.message}`);
  process.exit(2);
}

// Parse it without running it. vm.Script compiles the source and throws on a
// syntax error, which is the one failure that would otherwise become a
// dialog. The checks are CommonJS, so a script is the right shape to parse;
// a file that uses import or export is not one of them.
try {
  new vm.Script(source, { filename: file });
} catch (err) {
  console.error(`${target} does not parse:\n${err && (err.stack || err.message)}`);
  process.exit(1);
}

try {
  require(file);
} catch (err) {
  console.error(`${target} failed to start:\n${err && (err.stack || err.message)}`);
  process.exit(1);
}
