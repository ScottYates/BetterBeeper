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
// ---- the failure path -------------------------------------------------------
//
// The failure path is not a corner of this program; it is most of it. An update
// that goes wrong is far more expensive than one that goes right, because the
// app has already closed by the time anybody can find out. On 2026-11-11 the
// 1.28.8 installer wedged part way through, holding an exclusive lock on
// Better Beeper.exe, and the app could not be started again until Windows was
// restarted. Four things were wrong with how that was handled, and all four are
// fixed here:
//
//   1. The installer was killed with Process.Kill(), which stops one process.
//      An NSIS installer spawns children, and they are what keep the app's
//      files open. The whole tree is now put in a job object, so one call
//      stops the installer and everything it started.
//
//   2. The install was attempted even when the app's files were still held.
//      The wait for the files to be free timed out, and the code carried on
//      regardless. An installer that cannot get the files it wants does not
//      fail - it wedges, holding the lock it could not take. The install is
//      now not attempted at all while anything holds the app's files.
//
//   3. The app was only started again when the install had worked. A failed
//      install therefore left the user with no app at all, which is the worst
//      outcome available: the old version is still on disk and still runnable,
//      and nothing was starting it. The app is now started again whatever
//      happened, and the outcome says which version came back.
//
//   4. The result was written after the app was started, so the app could
//      start, look for the result, and find nothing - the failure was never
//      reported to anyone. The result is now written first.
//
// The result codes are in ResultCodes, and the app has its own copy of what
// each one means (src/main/updater.js). The detail that goes with the code is
// the specific reason, so "the installer did not finish within 15 minutes" is
// reported as itself rather than as an exit code nobody can interpret.
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
// String interpolation is C# 6 and is not used either, for the same reason.
//
// If you are here adding a modern feature, expect CS0453 or a syntax error,
// and expect it to be this constraint rather than a broken build.

using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;

namespace BetterBeeper.UpdateHelper
{
    /// <summary>
    /// What happened to the install.
    ///
    /// These are the app's to read, so they are also the app's to name:
    /// src/main/updater.js has a sentence for each one, and the helper only
    /// has to say which of them happened and why.
    ///
    /// They are not the installer's own exit code. That number is kept in the
    /// detail, because "exit code 5" means nothing to the person reading it and
    /// "the installer stopped with an error" means something.
    /// </summary>
    internal static class ResultCodes
    {
        /// <summary>It worked. Nothing to report.</summary>
        public const int Installed = 0;

        /// <summary>The installer ran and failed.</summary>
        public const int InstallerFailed = 1;

        /// <summary>The installer was stopped: it did not finish, or the user stopped it.</summary>
        public const int InstallerStopped = 2;

        /// <summary>Something is holding the app's files, so it cannot be started.</summary>
        public const int FilesHeld = 3;

        /// <summary>The install was fine but the app could not be started again.</summary>
        public const int RelaunchFailed = 4;

        /// <summary>Something went wrong that was not the install.</summary>
        public const int Unexpected = -1;
    }

    internal static class Program
    {
        // Long enough for a 90 MB install on a slow disk, and bounded so a wedged
        // process gives up on its own rather than sitting there forever with no way
        // to dismiss the window. The user can stop it sooner than this: the window
        // has a button for it.
        internal const int InstallTimeoutSeconds = 15 * 60;

        // How long to wait for the app to release its own files. If this expires we
        // do not install anyway - an installer that cannot get the files it wants
        // wedges holding them - so the wait is the difference between an update
        // and a stuck machine.
        internal const int ReleaseTimeoutSeconds = 120;

        // How long to wait for the app's files to come free after the installer has
        // been stopped. The tree has to actually die before the lock it was
        // holding goes with it, and dying is not instant.
        private const int LockSettleSeconds = 15;

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
                // It could not even work out what it was asked to do. It still says
                // so, on a window: a program that starts and exits without a word
                // is indistinguishable from one that was never started, and the
                // user is left looking at an app that closed for no reason. This
                // is the one place the window is the only way to say anything,
                // because the result file needs a path this program does not have.
                WriteResult(null, ResultCodes.Unexpected, ex.Message);

                // The app is started again even here. It starts this program and
                // then exits, so by now it is on its way out, and a helper that
                // gave up quietly would leave the user with no app at all - which
                // is the one thing this whole failure path exists to prevent.
                RelaunchFromArgs(args);

                if (!HasFlag(args, "--no-window")) ShowFatal(ex.Message);
                return 2;
            }

            var state = new ProgressState();
            var work = Task.Run(() => Run(state, options));

            // The check suite drives this program end to end, and a window on the
            // desktop during a test is not allowed. --no-window runs the same
            // work with no form at all.
            if (options.NoWindow)
            {
                work.GetAwaiter().GetResult();
                return state.ExitCode == 0 ? 0 : 1;
            }

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
            var code = ResultCodes.Unexpected;
            var detail = (string)null;

            try
            {
                code = Install(state, options);
                detail = state.Detail;
            }
            catch (Exception ex)
            {
                code = ResultCodes.Unexpected;
                detail = ex.Message;
            }

            // The result is written BEFORE the app is started again, because the
            // app reads it on its way up. Writing it afterwards is a race: the
            // relaunched app can start, look for the file, and find nothing, and
            // then the failure is never reported to anybody. This is what made
            // the 1.28.8 wedge invisible - the result existed, but not yet.
            WriteResult(options, code, detail);

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
            }

            state.ExitCode = code;
            state.Detail = detail;
            state.Ok = code == ResultCodes.Installed;
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

            // And this is the wait that decides whether the install is attempted
            // at all. The old code waited for the files to be free and then
            // installed regardless of the answer, which is how an installer ended
            // up fighting a lock it could not take: it wedged, holding the very
            // file the app needs to start. Not installing is always better than
            // installing into a folder something else is holding.
            if (!ReleaseAppFiles(options.RelaunchPath, options.ReleaseTimeoutSeconds))
            {
                state.Detail = "Something is still holding Better Beeper's files. Restart Windows to use "
                    + "Better Beeper again.";
                return ResultCodes.FilesHeld;
            }

            state.Status = "Installing...";
            var started = DateTime.UtcNow;

            // The job owns the installer and everything the installer starts, so
            // that stopping it means stopping all of it. See Job.
            var job = Job.Create();
            try
            {
                using (var installer = StartInstaller(options.InstallerPath, job))
                {
                    var stopped = WaitForInstaller(installer, state, options.InstallTimeoutSeconds);
                    if (stopped != null)
                    {
                        // The installer did not finish. Stop it, and everything it
                        // started, and then check whether the app's files are free
                        // again - that is what decides whether the app can come
                        // back at all.
                        state.Status = "Stopping the installer...";
                        StopInstaller(job, installer, options.InstallerPath);

                        if (!WaitForFileFree(options.RelaunchPath, LockSettleSeconds))
                        {
                            state.Detail = "Something is still holding Better Beeper's files. Restart Windows to use "
                                + "Better Beeper again.";
                            return ResultCodes.FilesHeld;
                        }

                        state.Detail = stopped;
                        return ResultCodes.InstallerStopped;
                    }

                    var seconds = (int)(DateTime.UtcNow - started).TotalSeconds;
                    state.Status = "Finished in " + seconds + "s. Starting Better Beeper...";

                    if (installer.ExitCode != 0)
                    {
                        state.Detail = "The installer returned exit code " + installer.ExitCode + ".";
                        return ResultCodes.InstallerFailed;
                    }

                    return ResultCodes.Installed;
                }
            }
            finally
            {
                // Closing the job kills anything still in it. On the way out of a
                // successful install that is nothing; on the way out of a failed
                // one it is the installer that would otherwise still be running.
                Job.Close(job);
            }
        }

        private static Process StartInstaller(string path, IntPtr job)
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

            // Put the installer in the job so that stopping the job stops it and
            // its children. If it cannot be assigned - which happens when the
            // helper is itself inside a job that does not allow nesting - the
            // fallback is Process.Kill() plus the sweep in StopInstaller.
            Job.Add(job, installer);

            return installer;
        }

        /// <summary>
        /// Waits for the installer, and says why it was stopped if it was.
        ///
        /// Returns null when the installer finished on its own, and a sentence
        /// describing the stop otherwise. Polling rather than one long wait, so
        /// that the Stop button is noticed while the wait is going on.
        /// </summary>
        private static string WaitForInstaller(Process installer, ProgressState state, int timeoutSeconds)
        {
            var deadline = DateTime.UtcNow.AddSeconds(timeoutSeconds);

            while (true)
            {
                if (installer.WaitForExit(250)) return null;

                if (Volatile.Read(ref state.CancelRequested) != 0)
                {
                    return "You stopped the update before it finished.";
                }

                if (DateTime.UtcNow >= deadline)
                {
                    return "It did not finish within " + DescribeDuration(timeoutSeconds) + ".";
                }
            }
        }

        /// <summary>
        /// Stops the installer and everything it started.
        ///
        /// Three things, in order, because no one of them is enough on its own:
        /// the job (the installer and its children), the process itself (in case
        /// it never made it into the job), and a sweep for anything still
        /// running from the installer's path (in case it started a child before
        /// it was assigned).
        /// </summary>
        private static void StopInstaller(IntPtr job, Process installer, string installerPath)
        {
            Job.TerminateAll(job);

            try { installer.Kill(); } catch { /* already gone, or cannot be killed */ }
            try { installer.WaitForExit(5000); } catch { /* still there */ }

            KillProcessesAtPath(installerPath);
        }

        /// <summary>
        /// Waits for the app's files to be free, and frees them if they are not.
        ///
        /// The leftovers are Electron's renderer and GPU children, which can
        /// outlive the main process and keep the executable open. They are the
        /// app's own processes, so they are stopped rather than waited for.
        ///
        /// The sweep is by exact path, and it is skipped for the shared Electron
        /// runtime: in a development run the executable is electron.exe, and
        /// killing every process running it would close other Electron apps on
        /// the machine.
        /// </summary>
        private static bool ReleaseAppFiles(string exePath, int timeoutSeconds)
        {
            if (WaitForFileFree(exePath, timeoutSeconds)) return true;

            if (IsSharedRuntime(exePath)) return false;

            if (KillProcessesAtPath(exePath) == 0) return false;

            return WaitForFileFree(exePath, timeoutSeconds);
        }

        /// <summary>Is this the shared Electron runtime rather than an installed app?</summary>
        private static bool IsSharedRuntime(string exePath)
        {
            if (string.IsNullOrEmpty(exePath)) return true;

            var name = Path.GetFileName(exePath);
            return string.Equals(name, "electron.exe", StringComparison.OrdinalIgnoreCase);
        }

        /// <summary>
        /// Stops every process running from this exact executable.
        ///
        /// Returns how many were stopped. A process we cannot look at - one that
        /// belongs to another user, or a 32-bit process on a 64-bit machine - is
        /// skipped rather than guessed at.
        /// </summary>
        private static int KillProcessesAtPath(string exePath)
        {
            if (string.IsNullOrEmpty(exePath)) return 0;

            Process[] all;
            try
            {
                all = Process.GetProcesses();
            }
            catch
            {
                return 0;
            }

            var killed = 0;
            foreach (var process in all)
            {
                try
                {
                    var running = process.MainModule.FileName;
                    if (!string.Equals(running, exePath, StringComparison.OrdinalIgnoreCase)) continue;

                    try
                    {
                        process.Kill();
                        killed++;
                    }
                    catch
                    {
                        // It exited between the listing and the kill.
                    }
                }
                catch
                {
                    // No access to this one, or it is already gone.
                }
                finally
                {
                    process.Dispose();
                }
            }

            return killed;
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

        /// <summary>
        /// Blocks until nothing holds the target executable open for writing.
        ///
        /// True when the file is free, false when the wait ran out. The old
        /// version returned nothing and the caller installed regardless, which
        /// is the mistake this return value exists to stop.
        /// </summary>
        private static bool WaitForFileFree(string path, int timeoutSeconds)
        {
            if (string.IsNullOrEmpty(path) || !File.Exists(path)) return true;

            var deadline = DateTime.UtcNow.AddSeconds(timeoutSeconds);
            while (true)
            {
                try
                {
                    using (new FileStream(path, FileMode.Open, FileAccess.ReadWrite, FileShare.None))
                    {
                        return true;
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

                if (DateTime.UtcNow >= deadline) return false;

                Thread.Sleep(250);
            }
        }

        /// <summary>
        /// Starts Better Beeper again, and says why it could not if it could not.
        ///
        /// Called whatever the install did. The path is the installed executable,
        /// which after a failed install is still the old version and still
        /// runnable - which is the whole point of failing back to it.
        /// </summary>
        private static bool TryRelaunch(Options options, out string why)
        {
            why = null;

            var exe = options.RelaunchPath;
            if (string.IsNullOrEmpty(exe))
            {
                why = "Better Beeper could not be started again: there is no path to start.";
                return false;
            }

            if (!File.Exists(exe))
            {
                why = Path.GetFileName(exe) + " is not there. The installer is still at " + options.InstallerPath
                    + " - running it again will finish the update.";
                return false;
            }

            try
            {
                // UseShellExecute so it starts the way a user double-clicking it
                // would - the working directory and environment are the app's, not
                // this helper's.
                Process.Start(new ProcessStartInfo(exe) { UseShellExecute = true });
                return true;
            }
            catch (Exception ex)
            {
                why = ex.Message;
                return false;
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

        /// <summary>Two sentences, one after the other, with a space between.</summary>
        private static string Join(string first, string second)
        {
            if (string.IsNullOrEmpty(first)) return second;
            if (string.IsNullOrEmpty(second)) return first;
            return first + " " + second;
        }

        /// <summary>Is this flag in the arguments? Used before the options are parsed.</summary>
        private static bool HasFlag(string[] args, string flag)
        {
            if (args == null) return false;
            foreach (var arg in args)
            {
                if (string.Equals(arg, flag, StringComparison.Ordinal)) return true;
            }
            return false;
        }

        /// <summary>
        /// Shows a window saying the update could not be started, and waits for it
        /// to be closed.
        ///
        /// No auto-close on this one: it is the only place the reason is shown,
        /// and a message that disappears before it has been read is the same as
        /// no message at all.
        /// </summary>
        private static void ShowFatal(string message)
        {
            var state = new ProgressState();
            state.Fatal = true;
            state.Detail = message;
            state.ExitCode = ResultCodes.Unexpected;
            state.Ok = false;
            Volatile.Write(ref state.Done, true);

            using (var form = new StatusForm(state))
            {
                form.Pump();
            }
        }

        /// <summary>
        /// Starts the app again, picking the path out of the arguments by hand.
        ///
        /// Used on the path where the arguments could not be parsed at all. The
        /// app starts this program and then exits, so it is on its way out by
        /// the time anything here runs, and the one thing that must not happen
        /// is for the user to be left with no app.
        /// </summary>
        private static void RelaunchFromArgs(string[] args)
        {
            var relaunch = ArgumentValue(args, "--relaunch");
            if (string.IsNullOrEmpty(relaunch) || !File.Exists(relaunch)) return;

            try
            {
                Process.Start(new ProcessStartInfo(relaunch) { UseShellExecute = true });
            }
            catch
            {
                // Nothing more can be done about it here, and the window is
                // about to say what happened.
            }
        }

        /// <summary>The value that follows this flag, or null.</summary>
        private static string ArgumentValue(string[] args, string flag)
        {
            if (args == null) return null;

            for (var i = 0; i < args.Length - 1; i++)
            {
                if (string.Equals(args[i], flag, StringComparison.Ordinal)) return args[i + 1];
            }

            return null;
        }

        /// <summary>"90 seconds", "15 minutes" - a length of time a person can read.</summary>
        private static string DescribeDuration(int seconds)
        {
            if (seconds < 60)
            {
                return seconds + (seconds == 1 ? " second" : " seconds");
            }

            var minutes = seconds / 60;
            return minutes + (minutes == 1 ? " minute" : " minutes");
        }
    }

    /// <summary>
    /// A Windows job object, used to own the installer.
    ///
    /// A job is the only thing Windows offers that can stop a whole tree of
    /// processes at once. Process.Kill() stops one process, and an NSIS
    /// installer spawns children - so killing the installer alone left the
    /// children running, holding the app's files open, which is exactly the
    /// state the 1.28.8 update died in.
    ///
    /// The job is created with KILL_ON_JOB_CLOSE, so anything still in it when
    /// the handle is closed is stopped as well. That covers the helper being
    /// killed outright, which would otherwise leave an installer running with
    /// the app's files open.
    ///
    /// If the job cannot be created, or the installer cannot be put in it -
    /// which happens when this program is itself inside a job that does not
    /// allow nesting - every method here is a no-op and the caller falls back
    /// to killing the process and sweeping for it by path.
    /// </summary>
    internal static class Job
    {
        private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;

        // JobObjectExtendedLimitInformation.
        private const int JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9;

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct IO_COUNTERS
        {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            public IO_COUNTERS IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetInformationJobObject(
            IntPtr hJob, int JobObjectInformationClass, IntPtr lpJobObjectInformation, uint cbJobObjectInformationLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool TerminateJobObject(IntPtr hJob, uint uExitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr hObject);

        /// <summary>A job with KILL_ON_JOB_CLOSE, or IntPtr.Zero if there could not be one.</summary>
        public static IntPtr Create()
        {
            var job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) return IntPtr.Zero;

            var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

            var size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            var buffer = Marshal.AllocHGlobal(size);
            try
            {
                Marshal.StructureToPtr(info, buffer, false);
                if (!SetInformationJobObject(job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, buffer, (uint)size))
                {
                    CloseHandle(job);
                    return IntPtr.Zero;
                }
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }

            return job;
        }

        /// <summary>Puts a process in the job. False when it could not be done.</summary>
        public static bool Add(IntPtr job, Process process)
        {
            if (job == IntPtr.Zero || process == null) return false;
            try
            {
                return AssignProcessToJobObject(job, process.Handle);
            }
            catch
            {
                return false;
            }
        }

        /// <summary>Stops every process in the job, and every process they started.</summary>
        public static void TerminateAll(IntPtr job)
        {
            if (job == IntPtr.Zero) return;
            try { TerminateJobObject(job, 1); } catch { /* it is already gone */ }
        }

        /// <summary>
        /// Closes the job, which stops anything still in it.
        ///
        /// Closing is not the same as TerminateAll: the job object itself goes
        /// away, and the processes in it are stopped as a side effect of the
        /// handle going away.
        /// </summary>
        public static void Close(IntPtr job)
        {
            if (job == IntPtr.Zero) return;
            try { CloseHandle(job); } catch { /* it is already gone */ }
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

        /// <summary>
        /// The update could not be started at all.
        ///
        /// The window stays up for this one, with a Close button, because it is
        /// the only place the reason is shown and a message that vanishes before
        /// it has been read says nothing.
        /// </summary>
        public bool Fatal;

        /// <summary>
        /// Set by the window's Stop button.
        ///
        /// An int rather than a bool because Volatile.Read and Volatile.Write
        /// work on ints and bools are not guaranteed to be read and written
        /// atomically by the runtime.
        /// </summary>
        public int CancelRequested;
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

        /// <summary>Run the work with no window. For the check suite.</summary>
        public bool NoWindow { get; private set; }

        /// <summary>How long to let the installer run. Shorter for the check suite.</summary>
        public int InstallTimeoutSeconds { get; private set; }

        /// <summary>How long to wait for the app's files. Shorter for the check suite.</summary>
        public int ReleaseTimeoutSeconds { get; private set; }

        private Options(
            string installer,
            string relaunch,
            string result,
            int? pid,
            bool noWindow,
            int installTimeout,
            int releaseTimeout)
        {
            InstallerPath = installer;
            RelaunchPath = relaunch;
            ResultPath = result;
            ParentPid = pid;
            NoWindow = noWindow;
            InstallTimeoutSeconds = installTimeout;
            ReleaseTimeoutSeconds = releaseTimeout;
        }

        public static Options Parse(string[] args)
        {
            string installer = null;
            string relaunch = null;
            string result = null;
            int? pid = null;
            var noWindow = false;
            var installTimeout = Program.InstallTimeoutSeconds;
            var releaseTimeout = Program.ReleaseTimeoutSeconds;

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

                if (flag == "--no-window")
                {
                    noWindow = true;
                    continue;
                }

                if (flag == "--install-timeout" && i + 1 < args.Length)
                {
                    int parsed;
                    if (int.TryParse(args[++i], out parsed) && parsed > 0) installTimeout = parsed;
                    continue;
                }

                if (flag == "--release-timeout" && i + 1 < args.Length)
                {
                    int parsed;
                    if (int.TryParse(args[++i], out parsed) && parsed > 0) releaseTimeout = parsed;
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

            return new Options(installer, relaunch, result, pid, noWindow, installTimeout, releaseTimeout);
        }
    }
}
