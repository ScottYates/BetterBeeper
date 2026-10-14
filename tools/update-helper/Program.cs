// The update handoff: everything that has to happen once Better Beeper has gone.
//
// The app cannot do this itself. A silent NSIS install replaces the whole
// install folder, so the executable running the install is the executable being
// overwritten. The work is therefore split across the process boundary, and this
// program is the other side of it:
//
//   1. put a window up straight away, so the app vanishing is not a mystery
//   2. wait for Better Beeper to actually be gone, not merely asked to leave
//   3. run the installer silently and wait for it
//   4. record how it went, for the next launch to report
//   5. start Better Beeper again
//
// It is a WinExe, so it has no console at all and no window can flash. There is
// deliberately no batch fallback: a fallback that needs cmd.exe is the thing
// being removed, and a silent fallback is worse than none.
//
// The work is blocking and slow, so it runs on a worker while the UI thread
// pumps messages. The two halves meet at ProgressState, which the window reads
// on a timer rather than through Invoke - see StatusForm.cs for why.
//
// Usings are explicit because this targets net48, which predates them.
//
// Built by the .NET Framework compiler that ships with Windows, so the sources
// stay inside C# 5. That rules out two things this file used to carry, both
// removed for the reason already stated on Options below: a feature that buys
// nothing at runtime is not worth needing a newer compiler for.
//
//   - Nullable reference annotations (`string`). Compile-time only; they are
//     erased before any IL exists. The C# 5 compiler does not merely ignore
//     them, it rejects them - it parses `string` as `Nullable<string>`, which
//     needs a value type, and fails with CS0453.
//   - `case ... when` guards in the switch below, which are C# 7.
//
// If you are here adding a modern feature, expect CS0453 or a syntax error,
// and expect it to be this constraint rather than a broken build.

using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
using System.Threading.Tasks;

namespace BetterBeeper.UpdateHelper
{
    internal static class Program
    {
        // Long enough for a 90 MB install on a slow disk, and bounded so a wedged
        // process gives up on its own rather than sitting there forever with no way
        // to dismiss the window.
        private const int InstallTimeoutSeconds = 15 * 60;

        // How long to wait for the app to release its own files. If this expires we
        // try anyway: a failed install is reported to the user on the next launch,
        // which beats this window never closing.
        private const int ReleaseTimeoutSeconds = 120;

        [STAThread]
        private static int Main(string[] args)
        {
            Options options;
            try
            {
                options = Options.Parse(args);
            }
            catch (Exception ex)
            {
                // Nothing to show it on - the form may not even be constructible.
                // Still recorded, because the next launch is the only other chance
                // to say what went wrong.
                WriteResult(null, -1, ex.Message);
                return 2;
            }

            var state = new ProgressState();
            var work = Task.Run(() => Run(state, options));

            using (var form = new StatusForm(state))
            {
                form.Pump();
            }

            // The form only closes once the work is done, so this returns promptly.
            work.GetAwaiter().GetResult();
            return state.ExitCode == 0 ? 0 : 1;
        }

        private static void Run(ProgressState state, Options options)
        {
            try
            {
                state.ExitCode = Install(state, options);
                state.Ok = state.ExitCode == 0;
            }
            catch (Exception ex)
            {
                state.ExitCode = -1;
                state.Ok = false;
                state.Detail = ex.Message;
            }

            // Relaunch before the window goes: the install has just replaced the
            // binary, so there is a moment where the user was told it was starting
            // and nothing has happened yet. The window's linger covers that.
            if (state.Ok && options.RelaunchPath != null)
            {
                StartRelaunch(options.RelaunchPath);
            }

            WriteResult(options, state.ExitCode, state.Detail);
            Volatile.Write(ref state.Done, true);
        }

        private static int Install(ProgressState state, Options options)
        {
            if (!File.Exists(options.InstallerPath))
            {
                throw new FileNotFoundException(
                    "The installer is no longer where it was saved.", options.InstallerPath);
            }

            state.Status = "Waiting for Better Beeper to close...";

            // Two waits, because they answer different questions. The process id
            // going away only means the main process left; Electron runs renderer
            // and GPU children that can hold the executable open for a moment
            // afterwards. The exclusive open is the one that matters - it is what
            // the installer is about to ask for, and asking for it early turns a
            // silent partial install into a clean one.
            WaitForProcessExit(options.ParentPid);
            WaitForFileFree(options.RelaunchPath);

            state.Status = "Installing...";
            var started = DateTime.UtcNow;

            // Kill() rather than Kill(entireProcessTree: true): the overload is
            // .NET Core 3.0 and later, and this is 4.8.
            using (var installer = StartInstaller(options.InstallerPath))
            {
                if (!installer.WaitForExit(InstallTimeoutSeconds * 1000))
                {
                    try { installer.Kill(); } catch { /* already gone */ }
                    throw new TimeoutException(
                        "The installer did not finish within " + (InstallTimeoutSeconds / 60) + " minutes.");
                }

                var seconds = (int)(DateTime.UtcNow - started).TotalSeconds;
                state.Status = "Finished in " + seconds + "s. Starting Better Beeper...";
                return installer.ExitCode;
            }
        }

        private static Process StartInstaller(string path)
        {
            var installer = Process.Start(new ProcessStartInfo
            {
                FileName = path,
                Arguments = "/S",
                UseShellExecute = false,
                CreateNoWindow = true,
            });

            if (installer == null)
            {
                throw new InvalidOperationException("The installer could not be started.");
            }

            return installer;
        }

        private static void WaitForProcessExit(int? pid, int timeoutSeconds = 30)
        {
            if (pid == null || pid <= 0) return;
            try
            {
                using (var parent = Process.GetProcessById(pid.Value))
                {
                    parent.WaitForExit(timeoutSeconds * 1000);
                }
            }
            catch (ArgumentException)
            {
                // Already gone, which is the state we were waiting for.
            }
        }

        /// <summary>Blocks until nothing holds the target executable open for writing.</summary>
        private static void WaitForFileFree(string path, int timeoutSeconds = ReleaseTimeoutSeconds)
        {
            if (string.IsNullOrEmpty(path) || !File.Exists(path)) return;

            var deadline = DateTime.UtcNow.AddSeconds(timeoutSeconds);
            while (DateTime.UtcNow < deadline)
            {
                try
                {
                    using (new FileStream(path, FileMode.Open, FileAccess.ReadWrite, FileShare.None))
                    {
                        return;
                    }
                }
                catch (IOException)
                {
                    // Still held: Electron children are still shutting down.
                }
                catch (UnauthorizedAccessException)
                {
                    // Held by something we are not permitted to introspect.
                }

                Thread.Sleep(250);
            }
        }

        private static void StartRelaunch(string exe)
        {
            try
            {
                // UseShellExecute so it starts the way a user double-clicking it
                // would - the working directory and environment are the app's, not
                // this helper's.
                Process.Start(new ProcessStartInfo(exe) { UseShellExecute = true });
            }
            catch (Exception ex)
            {
                // Reported as a non-zero result, which the next launch shows. A
                // successful install that could not relaunch must not be silent.
                throw new InvalidOperationException("Better Beeper could not be started again.", ex);
            }
        }

        /// <summary>Writes the outcome where the next launch will look for it.</summary>
        private static void WriteResult(Options options, int code, string error)
        {
            if (options == null || options.ResultPath == null) return;
            try
            {
                var text = error == null
                    ? code.ToString()
                    : code + "\t" + error.Replace("\t", " ").Replace("\r", " ").Replace("\n", " ");
                File.WriteAllText(options.ResultPath, text);
            }
            catch (Exception)
            {
                // A missing result file reads as "nothing went wrong", which is the
                // safe direction: the install itself is what matters.
            }
        }
    }

    /// <summary>
    /// Shared between the worker and the window.
    ///
    /// Fields are written with Volatile and read on the window's timer rather than
    /// marshalled with Invoke. The alternative has a real failure mode: the work can
    /// finish before Application.Run has started pumping, and an Invoke at that
    /// moment waits for a loop that has not begun. A timer reading a field cannot
    /// get into that state at all, and the values here are one line of status text.
    /// </summary>
    internal sealed class ProgressState
    {
        public string Status = "Starting...";
        public string Detail;
        public int ExitCode;
        public bool Ok;
        public bool Done;
    }

    /// <summary>
    /// Command line, parsed strictly: a wrong argument must not silently mean "none".
    ///
    /// A class rather than a record, because records need an IsExternalInit that
    /// .NET Framework 4.8 does not ship and that exists only to satisfy the
    /// compiler for a syntax feature worth nothing at runtime.
    /// </summary>
    internal sealed class Options
    {
        public string InstallerPath { get; private set; }
        public string RelaunchPath { get; private set; }
        public string ResultPath { get; private set; }
        public int? ParentPid { get; private set; }

        private Options(string installer, string relaunch, string result, int? pid)
        {
            InstallerPath = installer;
            RelaunchPath = relaunch;
            ResultPath = result;
            ParentPid = pid;
        }

        public static Options Parse(string[] args)
        {
            string installer = null;
            string relaunch = null;
            string result = null;
            int? pid = null;

            for (var i = 0; i < args.Length; i++)
            {
                // An if-chain rather than `case ... when`: that guard syntax is C# 7
                // and the shipped compiler is C# 5. Each branch checks its own
                // bounds before consuming the value, which is what the guard did.
                var flag = args[i];

                if (flag == "--installer" && i + 1 < args.Length)
                {
                    installer = args[++i];
                    continue;
                }

                if (flag == "--relaunch" && i + 1 < args.Length)
                {
                    relaunch = args[++i];
                    continue;
                }

                if (flag == "--result" && i + 1 < args.Length)
                {
                    result = args[++i];
                    continue;
                }

                if (flag == "--pid" && i + 1 < args.Length)
                {
                    // ++i happens in the argument, so it is consumed whether or
                    // not the text parses. That is the behaviour to keep: a
                    // malformed pid must not leave the next argument to be read
                    // again as a flag.
                    int parsed;
                    if (int.TryParse(args[++i], out parsed)) pid = parsed;
                    continue;
                }
            }

            // `installer == null` rather than only IsNullOrWhiteSpace: the
            // [NotNullWhen(false)] annotation that would let the compiler narrow the
            // type came with .NET Core 3.0, and this is 4.8. Both tests are wanted
            // anyway - an empty path is no more usable than a missing one.
            if (installer == null || string.IsNullOrWhiteSpace(installer))
            {
                throw new ArgumentException("--installer is required.");
            }

            return new Options(installer, relaunch, result, pid);
        }
    }
}