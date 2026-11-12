// The window shown while the install runs.
//
// It exists for one reason: a silent NSIS install takes the whole app away for
// about a minute, with no process and no window, and every part of that is
// correct and all of it reads as a crash. Saying so is the feature.
//
// The bar is deliberately indeterminate and says so in the text. NSIS running
// with /S reports no progress, so a bar that filled up would be inventing a
// number this program does not have. The elapsed seconds are the honest part:
// they go up, which is what tells the user nothing has wedged.
//
// It also has a Stop button, because the failure this program exists to handle
// is an installer that does not finish, and waiting out the full timeout with
// nothing to do about it is the worst way to spend that time. The button asks
// the work to stop; the work stops the installer and its whole tree, checks
// that the app's files are free again, and starts the app back on the old
// version.
//
// The text it ends on has to be true. The old version of this window said
// "Better Beeper will reopen on the old version" whatever had happened, and
// the code only reopened the app when the install had worked - so on a failed
// install it promised something it did not do, and the user was left with no
// app at all. The wording now comes from the result code.
//
// This reads ProgressState on a timer rather than being called into from the
// worker. See the note on ProgressState in Program.cs for why: Invoke would
// deadlock when the work finishes before the message loop starts pumping.

using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace BetterBeeper.UpdateHelper
{
    internal sealed class StatusForm : Form
    {
        private readonly ProgressState _state;
        private readonly Label _status = new Label { AutoSize = false, ForeColor = Color.White };
        private readonly Label _elapsed = new Label { AutoSize = false, ForeColor = Color.FromArgb(150, 156, 166) };
        private readonly Label _warning = new Label { AutoSize = false, ForeColor = Color.FromArgb(224, 108, 117) };
        private readonly ProgressBar _bar = new ProgressBar { Style = ProgressBarStyle.Marquee };
        private readonly Button _stop = new Button { Text = "Stop the update" };
        // Fully qualified: System.Threading is imported for Volatile, and the two
        // frameworks each have a Timer. This one has to be the Forms one, because
        // its Tick runs on the UI thread - a Threading.Timer would fire the repaint
        // on a pool thread and WinForms would ignore it.
        private readonly System.Windows.Forms.Timer _timer = new System.Windows.Forms.Timer { Interval = 500 };
        private readonly DateTime _started = DateTime.UtcNow;

        private string _lastStatus = "";
        private bool _finished;
        private bool _ticked;

        private readonly TraceLog _trace;

        /// <summary>
        /// Park the window off the screen.
        ///
        /// For running the real window path in a check. The window is created,
        /// shown and visible in every sense Windows cares about; it is simply
        /// nowhere the user would see it. Without this, the only way to find out
        /// whether the window works is to put it in front of the user and ask.
        /// </summary>
        private readonly bool _offscreen;

        public StatusForm(ProgressState state, TraceLog trace, bool offscreen)
        {
            _state = state;
            _trace = trace ?? new TraceLog(null);
            _offscreen = offscreen;

            _trace.Write("form-constructed");

            Text = "Better Beeper Update";
            FormBorderStyle = FormBorderStyle.FixedDialog;

            // No X button and no Alt+F4. Closing this window mid-install orphans the
            // install and leaves the app half replaced, so the one action that can
            // break it is not offered. Program.cs bounds the installer instead, so
            // this can never become a window with no way out - and the Stop button
            // is the way out that does not break anything.
            ControlBox = false;
            MaximizeBox = false;
            MinimizeBox = false;
            // Not TopMost. The window is the only thing on screen at this point -
            // the app is gone - so there is nothing to stay above, and a window
            // that insists on being in front is a window someone cannot get out
            // of the way of.
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(470, 250);
            BackColor = Color.FromArgb(24, 26, 30);
            ForeColor = Color.White;
            Font = new Font("Segoe UI", 9F);

            if (_offscreen)
            {
                // Off the screen, and not on the taskbar: a check must not put
                // anything in front of the user.
                //
                // Three things, because one of them is not enough. Setting
                // Location in the constructor does not stick - Windows puts a
                // window at the top left of the screen unless something moves
                // it afterwards, and that is exactly what happened here: a
                // check that was meant to be invisible put a window in the
                // corner of the screen. Moving it once the handle exists works,
                // but something puts it back at the top left afterwards, so it
                // is moved again once it has been shown.
                //
                // The opacity is NOT changed. A transparent window is a window
                // nobody can see, and this mode exists to check that the window
                // is a real, visible one - so it is opaque, and only its
                // position is different. A check that made the window
                // transparent could not tell an invisible window from a
                // visible one, which is the whole thing it is here to catch.
                StartPosition = FormStartPosition.Manual;
                ShowInTaskbar = false;
            }

            var title = new Label
            {
                Text = "Better Beeper is updating",
                AutoSize = false,
                Font = new Font("Segoe UI Semibold", 13F),
                ForeColor = Color.White,
                Location = new Point(24, 20),
                Size = new Size(420, 28),
            };

            _status.Text = _state.Status;
            _status.Location = new Point(24, 58);
            _status.Size = new Size(420, 20);

            _bar.Location = new Point(24, 86);
            _bar.Size = new Size(420, 10);

            _elapsed.Location = new Point(24, 102);
            _elapsed.Size = new Size(420, 18);

            _warning.Text = "Do not close Better Beeper or this window. The app restarts by itself when this is done.";
            _warning.Location = new Point(24, 130);
            _warning.Size = new Size(420, 66);

            _stop.Location = new Point(330, 204);
            _stop.Size = new Size(114, 28);
            _stop.FlatStyle = FlatStyle.Flat;
            _stop.FlatAppearance.BorderColor = Color.FromArgb(70, 74, 82);
            _stop.ForeColor = Color.White;
            _stop.BackColor = Color.FromArgb(40, 44, 52);
            _stop.Click += OnStopClicked;

            Controls.AddRange(new Control[] { title, _status, _bar, _elapsed, _warning, _stop });

            _timer.Tick += OnTick;

            // Draggable by grabbing anything on it.
            //
            // With ControlBox off there is no caption bar, and a borderless window
            // is not movable by the user at all - it would sit dead centre for the
            // whole install, which is exactly the "cannot get out of the way"
            // experience TopMost was causing by a different route.
            //
            // The labels get the handler explicitly: a Label consumes its own
            // MouseDown rather than letting it reach the form, so without this the
            // window would only drag from the few pixels of bare background.
            title.MouseDown += DragFrom;
            _status.MouseDown += DragFrom;
            _elapsed.MouseDown += DragFrom;
            _warning.MouseDown += DragFrom;
        }

        /// <summary>
        /// The Stop button.
        ///
        /// It asks the work to stop; it does not kill anything itself. The work
        /// owns the installer and the job that holds it, and only it knows how to
        /// stop them in the right order - stop the tree, check the files are
        /// free, then start the app back.
        /// </summary>
        private void OnStopClicked(object sender, EventArgs e)
        {
            if (_state.Fatal)
            {
                _finished = true;
                Close();
                return;
            }

            Volatile.Write(ref _state.CancelRequested, 1);
            _stop.Enabled = false;
            _stop.Text = "Stopping...";
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            base.OnMouseDown(e);
            if (e.Button == MouseButtons.Left) BeginDrag();
        }

        private void DragFrom(object sender, MouseEventArgs e)
        {
            if (e.Button == MouseButtons.Left) BeginDrag();
        }

        /// <summary>
        /// Moves the window with the mouse, the way a caption bar would.
        ///
        /// There is no Control.DragMove() - it is a common thing to assume exists,
        /// and it does not, so this is the Win32 pair the framework has always
        /// needed for a borderless form: tell Windows we have captured the mouse,
        /// then send ourselves the same message a title-bar click would send.
        /// Letting the window manager do the moving is what keeps the drag
        /// correct at the screen edges.
        /// </summary>
        private void BeginDrag()
        {
            if (ReleaseCapture())
            {
                SendMessage(Handle, WM_NCLBUTTONDOWN, (IntPtr)HTCAPTION, IntPtr.Zero);
            }
        }

        private const int WM_NCLBUTTONDOWN = 0x00A1;
        private const int HTCAPTION = 2;

        [DllImport("user32.dll")]
        private static extern bool ReleaseCapture();

        [DllImport("user32.dll")]
        private static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

        /// <summary>
        /// Moves the window off the screen before it is ever shown.
        ///
        /// OnHandleCreated runs when the window exists but before it is visible,
        /// so this is the last moment at which the window can be placed where
        /// the user will not see it. Setting Location in the constructor does
        /// not work: the window still comes up at the top left of the screen.
        /// </summary>
        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);

            if (_offscreen)
            {
                SetBounds(-32000, -32000, Width, Height);
                _trace.Write("offscreen handle-created bounds=" + Bounds.X + "," + Bounds.Y + "," + Bounds.Width + "," + Bounds.Height);
            }
        }

        /// <summary>
        /// Moves the window off the screen once it has been shown.
        ///
        /// Something puts the window back at the top left of the screen after
        /// the handle exists, so it is moved again here. The opacity is zero by
        /// this time, so there is nothing to see even in between.
        /// </summary>
        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);

            if (_offscreen)
            {
                SetBounds(-32000, -32000, Width, Height);
                _trace.Write("offscreen shown bounds=" + Bounds.X + "," + Bounds.Y + "," + Bounds.Width + "," + Bounds.Height);
                return;
            }

            // The window comes to the front.
            //
            // The helper is started while the app is still on screen, so its
            // window can open behind the app that is about to close - and the
            // app closing is the moment the user is looking for something. A
            // window that is up but behind is the same as no window, from
            // where the user is sitting.
            //
            // Not TopMost. The window is the only thing on screen at this
            // point, so there is nothing to stay above, and a window that
            // insists on being in front is a window someone cannot get out of
            // the way of.
            try
            {
                Activate();
            }
            catch (Exception)
            {
                // A window that cannot take the focus is still a window.
            }
        }

        /// <summary>Shows the window and pumps messages until the work is finished and the linger is over.</summary>
        public void Pump()
        {
            _timer.Start();
            _trace.Write("pump-enter");
            Application.Run(this);
            _trace.Write("pump-exit");
        }

        /// <summary>
        /// The name of the desktop this window is on.
        ///
        /// "Default" is the desktop the user is looking at. A window on any
        /// other desktop is created and painted and nobody sees it, which is a
        /// completely different failure from a window that was never created -
        /// and the two need different fixes.
        /// </summary>
        private static string CurrentDesktopName()
        {
            try
            {
                var desktop = GetThreadDesktop(GetCurrentThreadId());
                if (desktop == IntPtr.Zero) return "unknown";

                var buffer = new StringBuilder(256);
                uint needed;
                if (!GetUserObjectInformation(desktop, UOI_NAME, buffer, (uint)buffer.Capacity * 2, out needed))
                {
                    return "unknown";
                }

                return buffer.ToString();
            }
            catch (Exception)
            {
                return "unknown";
            }
        }

        private const int UOI_NAME = 2;

        [DllImport("user32.dll")]
        private static extern IntPtr GetThreadDesktop(uint dwThreadId);

        [DllImport("kernel32.dll")]
        private static extern uint GetCurrentThreadId();

        [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern bool GetUserObjectInformation(
            IntPtr hObj, int nIndex, StringBuilder pvInfo, uint nLength, out uint lpnLengthNeeded);

        /// <summary>
        /// One line describing the window, as Windows sees it.
        ///
        /// This is the fact the whole trace exists for: a window that is not
        /// visible is not a window, however well it was built.
        ///
        /// The facts that matter are all here: whether the window is visible,
        /// whether it has a handle, where it is, which desktop and which window
        /// station it is on, whether the desktop manager has cloaked it, and
        /// whether it is transparent. A window that is cloaked is on a desktop
        /// nobody is looking at, and a window that is transparent is not there
        /// at all - and both of those are "Visible" as far as the form is
        /// concerned, which is why they have to be asked about separately.
        /// </summary>
        private string Describe()
        {
            var visible = false;
            var handle = IntPtr.Zero;
            var bounds = "";

            try
            {
                visible = Visible;
                handle = Handle;
                var rect = DesktopBounds;
                bounds = rect.X + "," + rect.Y + "," + rect.Width + "," + rect.Height;
            }
            catch (Exception)
            {
                // A form that cannot even say where it is has not been shown.
            }

            return "visible=" + visible
                + " handle=" + (handle == IntPtr.Zero ? "none" : "yes")
                + " bounds=" + bounds
                + " desktop=" + CurrentDesktopName()
                + " station=" + CurrentStationName()
                + " cloaked=" + IsCloaked()
                + " transparent=" + IsTransparent()
                + " foreground=" + IsForeground()
                + " screens=" + ScreenCount();
        }

        /// <summary>
        /// The name of the window station this process is on.
        ///
        /// "WinSta0" is the interactive one - the one the user's desktop is
        /// drawn on. A process on any other station has windows that are
        /// created and painted and that nobody will ever see, and the desktop
        /// name alone cannot tell the two apart: every window station has a
        /// desktop called "Default".
        /// </summary>
        private static string CurrentStationName()
        {
            try
            {
                var station = GetProcessWindowStation();
                if (station == IntPtr.Zero) return "unknown";

                var buffer = new StringBuilder(256);
                uint needed;
                if (!GetUserObjectInformation(station, UOI_NAME, buffer, (uint)buffer.Capacity * 2, out needed))
                {
                    return "unknown";
                }

                return buffer.ToString();
            }
            catch (Exception)
            {
                return "unknown";
            }
        }

        [DllImport("user32.dll")]
        private static extern IntPtr GetProcessWindowStation();

        /// <summary>
        /// Has the desktop manager cloaked this window?
        ///
        /// A cloaked window is one the desktop manager is not showing: it is on
        /// a virtual desktop that is not the one being looked at. It is
        /// "visible" as far as Windows is concerned and nobody sees it.
        /// </summary>
        private string IsCloaked()
        {
            try
            {
                int cloaked;
                var hr = DwmGetWindowAttribute(Handle, DWMWA_CLOAKED, out cloaked, sizeof(int));
                if (hr != 0) return "unknown";
                return cloaked != 0 ? "yes" : "no";
            }
            catch (Exception)
            {
                return "unknown";
            }
        }

        private const int DWMWA_CLOAKED = 14;

        [DllImport("dwmapi.dll")]
        private static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out int value, int size);

        /// <summary>
        /// Is this window transparent?
        ///
        /// A window is transparent if it is layered and its alpha is below
        /// full. A window that is not layered is opaque by definition. This is
        /// the difference between a window that is there and a window that
        /// cannot be seen, and the form's own Visible property cannot tell
        /// them apart.
        /// </summary>
        private string IsTransparent()
        {
            try
            {
                var exStyle = GetWindowLong(Handle, GWL_EXSTYLE);
                if ((exStyle & WS_EX_LAYERED) == 0) return "no";

                uint key;
                byte alpha;
                uint flags;
                if (!GetLayeredWindowAttributes(Handle, out key, out alpha, out flags)) return "unknown";
                return alpha == 255 ? "no" : "yes";
            }
            catch (Exception)
            {
                return "unknown";
            }
        }

        private const int GWL_EXSTYLE = -20;
        private const int WS_EX_LAYERED = 0x00080000;

        [DllImport("user32.dll", SetLastError = true)]
        private static extern int GetWindowLong(IntPtr hwnd, int index);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool GetLayeredWindowAttributes(IntPtr hwnd, out uint key, out byte alpha, out uint flags);

        /// <summary>Is this window the one in the foreground right now?</summary>
        private string IsForeground()
        {
            try
            {
                return GetForegroundWindow() == Handle ? "yes" : "no";
            }
            catch (Exception)
            {
                return "unknown";
            }
        }

        [DllImport("user32.dll")]
        private static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool SetForegroundWindow(IntPtr hwnd);

        private static string ScreenCount()
        {
            try
            {
                var screens = Screen.AllScreens;
                var parts = new string[screens.Length];
                for (var i = 0; i < screens.Length; i++)
                {
                    parts[i] = screens[i].Bounds.X + "," + screens[i].Bounds.Y + ","
                        + screens[i].Bounds.Width + "," + screens[i].Bounds.Height;
                }
                return string.Join(";", parts);
            }
            catch (Exception)
            {
                return "unknown";
            }
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            // Belt and braces with ControlBox: if anything asks to close this form
            // before the install finished, refuse. The only legitimate close is the
            // one Finish() makes.
            if (!_finished && e.CloseReason != CloseReason.WindowsShutDown)
            {
                e.Cancel = true;
                return;
            }
            base.OnFormClosing(e);
        }

        /// <summary>
        /// Brings the window to the front and keeps it there.
        ///
        /// Called when the app has gone. That is the moment the user is
        /// looking for something, and it is the first moment at which this
        /// window can be sure of being seen: while the app was still on
        /// screen it was activated, but Windows does not always let a window
        /// that is not the foreground one come to the front.
        ///
        /// TopMost is on for as long as the install runs, because a window
        /// behind whatever the user was working in is the same as no window
        /// at all. It comes off again when the work is done.
        ///
        /// The window can still be dragged out of the way, which is what the
        /// mouse handling above is for.
        /// </summary>
        public void ComeToFront()
        {
            try
            {
                TopMost = true;
                Show();
                Activate();
                SetForegroundWindow(Handle);
                _trace.Write("brought-to-front foreground=" + IsForeground() + " topmost=yes");
            }
            catch (Exception ex)
            {
                // A window that cannot take the focus is still a window.
                _trace.Write("bring-to-front-failed " + ex.Message);
            }
        }

        private void OnTick(object sender, EventArgs e)
        {
            if (!_ticked)
            {
                _ticked = true;
                _trace.Write("tick " + Describe());
            }

            // The app has gone: put the window in front, so it is the thing
            // the user finds rather than something behind their other windows.
            if (Volatile.Read(ref _state.BringToFront) == 1)
            {
                Volatile.Write(ref _state.BringToFront, 0);
                ComeToFront();
            }

            var status = _state.Status;
            if (status != _lastStatus)
            {
                _status.Text = status;
                _lastStatus = status;
            }

            if (Volatile.Read(ref _state.Done))
            {
                Finish();
                return;
            }

            _elapsed.Text = "Working for " + (int)(DateTime.UtcNow - _started).TotalSeconds + "s...";
        }

        private void Finish()
        {
            _timer.Stop();
            _bar.Style = ProgressBarStyle.Blocks;
            _bar.Value = _bar.Maximum;
            _elapsed.Text = "";
            _stop.Enabled = false;
            _stop.Visible = false;

            // The install is over, so the window stops insisting on being in
            // front. It is about to close, but it lingers for a moment and
            // there is no reason for it to be in the way of anything.
            try
            {
                TopMost = false;
            }
            catch (Exception)
            {
                // A window that cannot give up the top is still a window.
            }

            // The update could not be started at all. There is no install to
            // report on, and the window is the only place the reason exists, so
            // it stays up with a Close button rather than closing itself.
            if (_state.Fatal)
            {
                _status.Text = "The update could not be started.";
                _warning.Text = _state.Detail ?? "";
                _stop.Text = "Close";
                _stop.Enabled = true;
                _stop.Visible = true;
                _finished = true;
                return;
            }

            // The wording comes from the result code, so it says what happened
            // rather than what usually happens. The old text claimed the app
            // would reopen on the old version on every failure, including the
            // ones where it did not reopen at all.
            switch (_state.ExitCode)
            {
                case ResultCodes.Installed:
                    _status.Text = "The update is installed. Better Beeper is starting now.";
                    _warning.ForeColor = Color.FromArgb(126, 211, 133);
                    _warning.Text = "";
                    break;

                case ResultCodes.FilesHeld:
                    _status.Text = "Windows is still holding Better Beeper's files.";
                    _warning.Text = "Restart Windows to use Better Beeper again.";
                    break;

                case ResultCodes.RelaunchFailed:
                    _status.Text = "Better Beeper could not be started again.";
                    _warning.Text = "Open it by hand once the files are free.";
                    break;

                default:
                    _status.Text = "The update did not install. Better Beeper is reopening on the old version.";
                    break;
            }

            if (!string.IsNullOrEmpty(_state.Detail))
            {
                _warning.Text = string.IsNullOrEmpty(_warning.Text)
                    ? _state.Detail
                    : _warning.Text + " " + _state.Detail;
            }

            _finished = true;

            // Linger before closing. The install has just replaced the binary, so
            // there is a moment where the user was told the app is starting and
            // nothing has appeared yet.
            var linger = new System.Windows.Forms.Timer { Interval = 2500 };
            linger.Tick += delegate
            {
                linger.Stop();
                Close();
            };
            linger.Start();
        }
    }
}
