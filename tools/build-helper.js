/**
 * Build the update handoff helper.
 *
 * Uses the .NET Framework compiler that ships inside Windows, so the build
 * needs nothing installed. This replaced `dotnet build`, which needed the SDK -
 * several hundred megabytes of build tooling - to produce the same 13 KB
 * program.
 *
 * The two are not alternatives in what they emit. `<TargetFramework>net48</TargetFramework>`
 * is what makes the helper small, because it links against the .NET Framework
 * that is already on the machine rather than bundling a runtime of its own.
 * The SDK never contributed a byte to the output; it was only ever a way of
 * asking for it. Building with csc.exe instead changes nothing about the size.
 *
 * What it does change is the language the sources may use. The compiler in
 * `Framework64/v4.0.30319` is C# 5, so nullable reference annotations, `when`
 * guards and `is not` are all rejected. See the note at the top of Program.cs.
 *
 * UpdateHelper.csproj is still the description of the program - OutputType,
 * target framework, the assembly name below - and check:update reads it. It is
 * no longer what builds it.
 *
 * Run with `npm run build:helper`.
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'tools', 'update-helper');
const OUT_DIR = path.join(ROOT, 'build', 'update-helper');
// Matches AssemblyName in the csproj, and HELPER_EXE in src/main/updater.js.
const EXE = path.join(OUT_DIR, 'BetterBeeper.UpdateHelper.exe');
const SOURCES = ['Program.cs', 'StatusForm.cs'].map((name) => path.join(SRC, name));

/**
 * The references the helper actually uses: the console and core libraries, and
 * the two WinForms assemblies StatusForm.cs is built on. Resolved from the
 * framework directory by csc itself, so these are file names rather than paths.
 */
const REFERENCES = [
  'System.dll',
  'System.Core.dll',
  'System.Drawing.dll',
  'System.Windows.Forms.dll',
  'System.Xml.dll',
];

/**
 * The compiler that ships with Windows.
 *
 * Framework64 first, then the 32-bit directory, which is what an x86 process
 * sees. Returns null rather than throwing so the caller can explain, and the
 * message below is the useful one.
 */
function findCompiler() {
  const windir = process.env.WINDIR || 'C:\\Windows';
  const candidates = [
    path.join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(windir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

/** True when the built exe is newer than every source file. */
function upToDate() {
  if (!fs.existsSync(EXE)) return false;
  const built = fs.statSync(EXE).mtimeMs;
  return SOURCES.every((source) => fs.statSync(source).mtimeMs <= built);
}

function main() {
  const compiler = findCompiler();
  if (!compiler) {
    console.error(
      '\nthe .NET Framework compiler was not found.\n'
      + '  Expected csc.exe under %WINDIR%\\Microsoft.NET\\Framework64\\v4.0.30319.\n'
      + '  It ships with Windows and is what builds this helper; without it there is\n'
      + '  nothing to install as a fallback, so this is a broken machine rather than\n'
      + '  a missing tool.\n',
    );
    process.exit(1);
  }

  // tools/release.js and tools/dist.js both want this to run before packaging,
  // and dist:scratch runs it through npm, so building twice in a row should not
  // rebuild. --force overrides.
  if (!process.argv.includes('--force') && upToDate()) {
    console.log('update helper: already built and newer than its sources');
    return;
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const args = [
    '/nologo',
    // The whole point of this program. WinExe links against the GUI subsystem,
    // so Windows never allocates a console to flash, hide or mis-quote.
    '/target:winexe',
    '/optimize+',
    `/out:${EXE}`,
    ...REFERENCES.map((reference) => `/reference:${reference}`),
    ...SOURCES,
  ];

  console.log('update helper: compiling with the .NET Framework compiler');
  execFileSync(compiler, args, { stdio: 'inherit' });

  if (!fs.existsSync(EXE)) {
    console.error(`\nthe compiler reported success but produced no ${path.basename(EXE)}\n`);
    process.exit(1);
  }
  const kb = (fs.statSync(EXE).size / 1024).toFixed(1);
  console.log(`update helper: ${path.relative(ROOT, EXE)} (${kb} KB)`);
}

main();