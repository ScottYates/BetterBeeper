/**
 * Red proof for the update failure path.
 *
 * Every rule the failure path is built on is broken in turn, and the check it
 * was written for has to notice. A check that stays green while the rule it
 * is about is removed is worse than no check, because it reads as coverage.
 *
 * The rules here are about the 1.28.8 wedge, and each one has been a real
 * behaviour rather than a line of source:
 *
 *   - the whole installer tree is stopped, not just the installer
 *   - the app is started again even when the install failed
 *   - the result is written before the app is started again
 *   - the install is not attempted while the app's files are held
 *   - the files being held is reported as the reason
 *   - the reason is written down, and shown
 *   - the window says what happened, not what usually happens
 *
 * The baseline is asserted, not assumed. A harness that prints a baseline and
 * moves on is trusting it, and a mutation can then be reported as caught
 * against a case that was already failing - a false catch, and a proof that
 * looked green for the wrong reason. So the baseline has to be N/N with the
 * same N on both sides, and every named case has to be PASS in it, or this
 * refuses to run.
 *
 * Every file is restored in a finally, verified by content hash.
 *
 * Run with: node tools/update-failure-redproof.js
 */
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const FILES = {
  helper: path.join(ROOT, 'tools', 'update-helper', 'Program.cs'),
  form: path.join(ROOT, 'tools', 'update-helper', 'StatusForm.cs'),
  updater: path.join(ROOT, 'src', 'main', 'updater.js'),
  renderer: path.join(ROOT, 'src', 'renderer', 'js', 'updates.js'),
};

const hash = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

function applyEdit(original, from, to) {
  for (const pattern of [from, from.replace(/\n/g, '\r\n')]) {
    if (pattern !== from && !original.includes('\r\n')) continue;
    const count = original.split(pattern).length - 1;
    if (count === 1) return { ok: true, text: original.replace(pattern, to) };
    if (count > 1) return { ok: false, why: 'pattern appears ' + count + ' times' };
  }
  return { ok: false, why: 'pattern not found' };
}

/**
 * Applies one or more edits in order.
 *
 * More than one edit is needed where a rule has more than one way of being
 * true. The job object, for instance, stops the installer's tree in two
 * places: it is terminated explicitly, and it is killed when the job handle
 * closes. Taking either one away leaves the tree stopped, so taking the rule
 * away needs both.
 */
function applyEdits(original, edits) {
  let text = original;
  for (const edit of edits) {
    const result = applyEdit(text, edit.from, edit.to);
    if (!result.ok) return { ok: false, why: edit.why || result.why };
    text = result.text;
  }
  return { ok: true, text };
}

const MUTATIONS = [
  {
    // The job stops the installer's tree in two places: it is terminated
    // explicitly, and it is killed when the job handle closes. Taking either
    // one away leaves the tree stopped - so taking the rule away needs both.
    what: 'the installer tree is not stopped, only the installer',
    file: 'helper',
    edits: [
      { from: '            Job.TerminateAll(job);\n', to: '' },
      {
        from: '            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;',
        to: '            info.BasicLimitInformation.LimitFlags = 0;',
      },
    ],
    expect: 'the whole installer tree is stopped, not just the installer',
  },
  {
    what: 'the app is only started again when the install worked',
    file: 'helper',
    from: '            string why;\n            if (!TryRelaunch(options, out why))',
    to: '            string why;\n            if (code == ResultCodes.Installed && !TryRelaunch(options, out why))',
    expect: 'a failed install still starts the app again',
  },
  {
    what: 'the result is written after the app is started again',
    file: 'helper',
    from: `            WriteResult(options, code, detail);

            // The app is started again whatever happened. A failed update that
            // leaves the user with no app at all is the worst outcome there is,
            // and it was the one this produced: the old version is still on disk
            // and still runnable, and nothing was starting it.
            string why;
            if (!TryRelaunch(options, out why))
            {
                detail = Join(detail, why);

                // The app could not be started. That is more urgent than how the
                // install went, unless the reason it could not be started is that
                // something is holding its files - then that is the reason, and
                // it is the one the user has to act on.
                code = code == ResultCodes.FilesHeld ? ResultCodes.FilesHeld : ResultCodes.RelaunchFailed;

                // Safe to write again: the app only reads this on startup, and it
                // did not start.
                WriteResult(options, code, detail);
            }`,
    to: `            // The app is started again whatever happened. A failed update that
            // leaves the user with no app at all is the worst outcome there is,
            // and it was the one this produced: the old version is still on disk
            // and still runnable, and nothing was starting it.
            string why;
            if (!TryRelaunch(options, out why))
            {
                detail = Join(detail, why);

                // The app could not be started. That is more urgent than how the
                // install went, unless the reason it could not be started is that
                // something is holding its files - then that is the reason, and
                // it is the one the user has to act on.
                code = code == ResultCodes.FilesHeld ? ResultCodes.FilesHeld : ResultCodes.RelaunchFailed;
            }

            WriteResult(options, code, detail);`,
    expect: 'the result is written before the app is started again',
  },
  {
    what: 'the install is attempted even while the app files are held',
    file: 'helper',
    from: '            if (!ReleaseAppFiles(options.RelaunchPath, options.ReleaseTimeoutSeconds))',
    to: '            if (false && !ReleaseAppFiles(options.RelaunchPath, options.ReleaseTimeoutSeconds))',
    expect: "the install is not attempted while the app's files are held",
  },
  {
    what: 'the files being held is reported as an ordinary failure',
    file: 'helper',
    from: `                state.Detail = "Something is still holding Better Beeper's files. Restart Windows to use "
                    + "Better Beeper again.";
                return ResultCodes.FilesHeld;`,
    to: `                state.Detail = "Something is still holding Better Beeper's files. Restart Windows to use "
                    + "Better Beeper again.";
                return ResultCodes.InstallerFailed;`,
    expect: "the app's files being held is reported as the reason",
  },
  {
    what: 'the outcome is never recorded',
    file: 'helper',
    from: `            // the 1.28.8 wedge invisible - the result existed, but not yet.
            WriteResult(options, code, detail);`,
    to: `            // the 1.28.8 wedge invisible - the result existed, but not yet.`,
    expect: 'the reason an installer was stopped is written down',
  },
  {
    what: 'the reason is dropped and only the code is recorded',
    file: 'helper',
    from: `                var text = error == null
                    ? code.ToString()
                    : code + "\\t" + error.Replace("\\t", " ").Replace("\\r", " ").Replace("\\n", " ");`,
    to: '                var text = code.ToString();',
    expect: 'an installer that fails is reported with its exit code',
  },
  {
    what: 'an app that cannot be started again is not reported',
    file: 'helper',
    from: '                code = code == ResultCodes.FilesHeld ? ResultCodes.FilesHeld : ResultCodes.RelaunchFailed;',
    to: '                code = code;',
    expect: 'an app that cannot be started again is reported',
  },
  {
    what: 'the update cannot be stopped before the installer finishes',
    file: 'helper',
    from: `                if (Volatile.Read(ref state.CancelRequested) != 0)
                {
                    return "You stopped the update before it finished.";
                }

`,
    to: '',
    expect: 'the update can be stopped before the installer finishes',
  },
  {
    what: 'the app throws the reason away again',
    file: 'updater',
    from: "    const detail = tab === -1 ? '' : raw.slice(tab + 1).trim();",
    to: "    const detail = '';",
    expect: 'the install result keeps the reason the helper wrote',
  },
  {
    what: 'the outcomes stop having names',
    file: 'updater',
    from: 'function describeInstallOutcome(code) {\n  const known = INSTALL_OUTCOMES[code];',
    to: "function describeInstallOutcome(code) {\n  const known = 'The update did not install.';",
    expect: 'the install result says which outcome it was',
  },
  {
    what: 'the renderer shows a number again',
    file: 'renderer',
    from: `  const what = last.message || 'The last update did not install.';
  const why = last.detail ? \` \${last.detail}\` : '';
  toast(\`\${what}\${why} Still on \${info.current}.\`, 'error', 10000);`,
    to: `  toast(
    \`The last update did not install (installer exit \${last.code ?? 'unknown'}). Still on \${info.current}.\`,
    'error',
    8000,
  );`,
    expect: 'the renderer shows the reason, not just a number',
  },
  {
    what: 'the app is not started again when the helper cannot parse its arguments',
    file: 'helper',
    from: '                RelaunchFromArgs(args);\n',
    to: '',
    expect: 'the app is started again even when the helper could not parse its arguments',
  },
  {
    what: 'the outcome is only reported as a side effect of the update check',
    file: 'renderer',
    from: '  const info = await call(() => api.updateStatus(), { context: \'update status\', fallback: null });',
    to: '  const info = await call(() => api.updateCheck(), { context: \'update check\', fallback: null });',
    expect: 'a failed install is reported even when automatic updates are off',
  },
  {
    what: 'the window says one thing for every outcome',
    file: 'form',
    from: '            switch (_state.ExitCode)',
    to: '            switch (0)',
    expect: 'the status window says what happened, not what usually happens',
  },
];

function runCheck() {
  try {
    const out = execFileSync('npm', ['run', 'check:updatefailure', '--silent'], { windowsHide: true,
      cwd: ROOT, encoding: 'utf8', timeout: 600000, shell: true,
    });
    return { code: 0, out };
  } catch (err) {
    return {
      code: typeof err.status === 'number' ? err.status : 1,
      out: String(err.stdout || '') + String(err.stderr || ''),
    };
  }
}

/** The "N/M checks passed" line. */
function countOf(out) {
  const m = out.match(/(\d+)\/(\d+) checks passed/);
  return m ? { passed: Number(m[1]), total: Number(m[2]) } : null;
}

/** The verdict of one named case: 'PASS', 'FAIL', or null if it never printed. */
function verdictFor(out, name) {
  for (const line of out.split(/\r?\n/)) {
    const clean = line.replace(/\x1b\[[0-9;]*m/g, '').trim();
    if (!clean.startsWith('PASS') && !clean.startsWith('FAIL')) continue;
    const rest = clean.slice(5).trim();
    const detail = rest.indexOf('  [');
    const printed = detail === -1 ? rest : rest.slice(0, detail);
    if (printed === name) return clean.startsWith('FAIL') ? 'FAIL' : 'PASS';
  }
  return null;
}

// ---------------------------------------------------------------------------
// The baseline, asserted
// ---------------------------------------------------------------------------

const before = {};
for (const [k, p] of Object.entries(FILES)) before[k] = hash(p);

const baseline = runCheck();
const baselineCount = countOf(baseline.out);

if (!baselineCount) {
  console.log('the check suite did not report a count - it died before printing one');
  process.exit(1);
}

if (baselineCount.passed !== baselineCount.total) {
  console.log(`the baseline is not green: ${baselineCount.passed}/${baselineCount.total}`);
  console.log(baseline.out.split(/\r?\n/).filter((l) => l.trim().startsWith('FAIL')).join('\n'));
  process.exit(1);
}

// Every named case a mutation is about has to be PASS in the baseline. A
// mutation that "caught" a case that was already failing is a false catch.
const named = [...new Set(MUTATIONS.map((m) => m.expect))];
const notGreen = named.filter((name) => verdictFor(baseline.out, name) !== 'PASS');
if (notGreen.length) {
  console.log('these named cases are not green in the baseline, so a mutation could not be caught by them:');
  for (const name of notGreen) console.log(`  - ${name}`);
  process.exit(1);
}

console.log(`baseline: ${baselineCount.passed}/${baselineCount.total} checks passed, ${named.length} named cases green\n`);

let caught = 0;
const holes = [];

for (const m of MUTATIONS) {
  const target = FILES[m.file];
  const original = fs.readFileSync(target, 'utf8');
  let applied = false;
  try {
    const edit = applyEdits(original, m.edits || [{ from: m.from, to: m.to }]);
    if (!edit.ok) {
      holes.push(`${m.what} -- ${edit.why}`);
      console.log(`SKIP  ${m.what}\n      ${edit.why}`);
      continue;
    }
    fs.writeFileSync(target, edit.text, 'utf8');
    applied = true;

    const { out } = runCheck();
    const verdict = verdictFor(out, m.expect);
    const after = countOf(out);

    if (!after) {
      holes.push(`${m.what} -- the suite did not report a count`);
      console.log(`HOLE  ${m.what}\n      the suite died before printing a count`);
    } else if (after.total !== baselineCount.total) {
      holes.push(`${m.what} -- the suite reported ${after.total} cases, not ${baselineCount.total}`);
      console.log(`HOLE  ${m.what}\n      the suite lost cases: ${after.total} instead of ${baselineCount.total}`);
    } else if (verdict === null) {
      holes.push(`${m.what} -- "${m.expect}" never printed`);
      console.log(`HOLE  ${m.what}\n      the named check never printed`);
    } else if (verdict === 'FAIL') {
      caught++;
      console.log(`RED   ${m.what}\n      "${m.expect}" failed as it should`);
    } else {
      holes.push(`${m.what} -- "${m.expect}" stayed green`);
      console.log(`HOLE  ${m.what}\n      "${m.expect}" stayed green`);
    }
  } finally {
    if (applied) fs.writeFileSync(target, original, 'utf8');
    const now = hash(target);
    if (now !== before[m.file]) {
      console.log(`\nRESTORE FAILED for ${path.basename(target)}`);
      process.exit(1);
    }
  }
}

console.log(`\n${caught}/${MUTATIONS.length} mutations caught by the check they were written for`);
if (holes.length) {
  console.log('\nHoles (the rule is not actually load-bearing):');
  for (const h of holes) console.log(`  - ${h}`);
  process.exit(1);
}
process.exit(0);
