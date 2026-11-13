// Runs a program on a desktop of its own.
//
// The reason this exists is one line: a check must never put a window on the
// screen of the person running it.
//
// There were two ways of running the update helper without showing its window
// on the desktop, and both were tried:
//
//   - moving the window off the screen. A window at (-32000, -32000) is not
//     painted, but Windows still treats it as a real window, and a window
//     that is activated still takes the foreground. A window the user cannot
//     see that has taken their keyboard is worse than a popup.
//
//   - not activating it. That stops the focus going away, but the window is
//     still a window, and the first version of the off-screen mode still put
//     one in the corner of the screen before moving it.
//
// Both of those are a promise about what the code will do. This is a
// guarantee about where the code runs: the program is started on a desktop
// that is not the one the user is looking at, so every window it creates -
// however it places them, however it activates them, whatever it does with
// TopMost - is on a desktop Windows does not draw and cannot make foreground.
//
// The interactive window station (WinSta0) is kept, deliberately. A different
// *station* would be a different session, and the helper's window could not
// even be measured there - but a different *desktop* on the same station is
// the real desktop of the session, just not the visible one. So the window is
// a genuine window, on the genuine station, with a genuine size and position,
// and it is measured the same way it would be measured in a real update.
//
// The trace is how that is observed. The helper writes down what Windows says
// about its own window, and the check reads that back.
//
// The desktop is closed when the program exits. If it cannot be closed because
// something is still on it, that is not fatal - the desktop goes away with the
// session, and a desktop with nothing on it holds no resources worth
// reclaiming.
//
// Usage: PrivateDesktopRunner.exe <desktop-name> <program> [args...]
// Exit code: the program's own exit code, or 90 if the desktop could not be
// made or the program could not be started.
//
// Built by the .NET Framework compiler that ships with Windows, so the source
// stays inside C# 5: no string interpolation, no expression-bodied members.

using System;
using System.Runtime.InteropServices;
using System.Text;

internal static class PrivateDesktopRunner
{
    private const uint GENERIC_ALL = 0x10000000;
    private const int STARTF_USESHOWWINDOW = 0x00000001;
    private const short SW_HIDE = 0;
    private const uint INFINITE = 0xFFFFFFFF;
    private const uint TIMEOUT_MS = 60000;
    private const int EXIT_NO_DESKTOP = 90;
    private const int EXIT_NO_PROCESS = 91;
    private const int EXIT_TIMED_OUT = 92;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public int dwProcessId;
        public int dwThreadId;
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateDesktop(
        string lpszDesktop, string lpszDevice, IntPtr pDevmode, int dwFlags, uint dwDesiredAccess, IntPtr lpsa);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool CloseDesktop(IntPtr hDesktop);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcess(
        string lpApplicationName,
        string lpCommandLine,
        IntPtr lpProcessAttributes,
        IntPtr lpThreadAttributes,
        bool bInheritHandles,
        uint dwCreationFlags,
        IntPtr lpEnvironment,
        string lpCurrentDirectory,
        ref STARTUPINFO lpStartupInfo,
        out PROCESS_INFORMATION lpProcessInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool WaitForSingleObject(IntPtr hObject, uint dwMilliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr hProcess, uint uExitCode);

    public static int Main(string[] args)
    {
        if (args.Length < 2) return EXIT_NO_PROCESS;

        string desktopName = args[0];
        string program = args[1];

        // The desktop of the user is not a private desktop.
        //
        // This is the last line of defence, and it is here because the rule
        // has been broken on purpose more than once: a check that proves the
        // rule works has to break it, and a broken rule that is only broken in
        // the source is harmless - but a broken rule that is broken at run time
        // puts a window on someone's screen. So the runner refuses to start
        // anything on "Default", whatever it is asked to do.
        if (string.Equals(desktopName, "Default", StringComparison.OrdinalIgnoreCase))
        {
            return EXIT_NO_DESKTOP;
        }

        var desktop = CreateDesktop(desktopName, null, IntPtr.Zero, 0, GENERIC_ALL, IntPtr.Zero);
        if (desktop == IntPtr.Zero) return EXIT_NO_DESKTOP;

        int code = EXIT_NO_PROCESS;
        try
        {
            code = Run(program, args, desktopName);
        }
        finally
        {
            // Best effort. A desktop that still has something on it cannot be
            // closed, and that is not a failure of the run.
            try { CloseDesktop(desktop); } catch { }
        }

        return code;
    }

    private static int Run(string program, string[] args, string desktopName)
    {
        var command = new StringBuilder();
        command.Append('"').Append(program).Append('"');
        for (int i = 2; i < args.Length; i++)
        {
            command.Append(' ').Append('"').Append(args[i]).Append('"');
        }

        var startup = new STARTUPINFO();
        startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));

        // The desktop the program runs on. This is the whole point of the
        // program: "WinSta0" is the interactive window station, and the name
        // after it is a desktop of this run's own rather than the one the user
        // is looking at.
        startup.lpDesktop = "WinSta0\\" + desktopName;

        // Hidden from the start. The program does its own showing, and a
        // program that is asked to hide itself cannot flash on the way.
        startup.dwFlags = STARTF_USESHOWWINDOW;
        startup.wShowWindow = SW_HIDE;

        PROCESS_INFORMATION info;
        bool started = CreateProcess(
            program,
            command.ToString(),
            IntPtr.Zero,
            IntPtr.Zero,
            false,
            0,
            IntPtr.Zero,
            null,
            ref startup,
            out info);

        if (!started) return EXIT_NO_PROCESS;

        try
        {
            // The child's process id is written down, so the caller can tell
            // whether the program it started is still running.
            //
            // This matters because a program that is left behind is a program
            // with a window on the desktop, and a check that leaves one behind
            // has put a window on the user's screen without meaning to.
            WriteChildPid(info.dwProcessId);

            WaitForSingleObject(info.hProcess, TIMEOUT_MS);

            uint exitCode = 0;
            GetExitCodeProcess(info.hProcess, out exitCode);
            if ((int)exitCode == 259)
            {
                // STILL_ACTIVE: it is still running, so it is stopped here.
                // A window left running after a check is not a thing to leave
                // behind for the next person.
                TerminateProcess(info.hProcess, 1);
                return EXIT_TIMED_OUT;
            }

            return (int)exitCode;
        }
        finally
        {
            try { CloseHandle(info.hThread); } catch { }
            try { CloseHandle(info.hProcess); } catch { }
        }
    }

    /// <summary>
    /// Writes the child's process id where the caller asked for it.
    ///
    /// The file is named by an environment variable, so the argument list of
    /// the program being run is exactly what the caller asked for - the
    /// program under test must not be able to tell it was launched by a
    /// runner.
    /// </summary>
    private static void WriteChildPid(int pid)
    {
        try
        {
            var path = Environment.GetEnvironmentVariable("BB_PRIVATE_DESKTOP_PID_FILE");
            if (string.IsNullOrEmpty(path)) return;
            System.IO.File.WriteAllText(path, pid.ToString());
        }
        catch (Exception)
        {
            // A pid file that cannot be written is not a reason to fail the
            // run. The caller will notice the process is still there.
        }
    }
}
