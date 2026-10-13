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
// This reads ProgressState on a timer rather than being called into from the
// worker. See the note on ProgressState in Program.cs for why: Invoke would
// deadlock when the work finishes before the message loop starts pumping.

using System;
using System.Drawing;
using System.Runtime.InteropServices;
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
        // Fully qualified: System.Threading is imported for Volatile, and the two
        // frameworks each have a Timer. This one has to be the Forms one, because
        // its Tick runs on the UI thread - a Threading.Timer would fire the repaint
        // on a pool thread and WinForms would ignore it.
        private readonly System.Windows.Forms.Timer _timer = new System.Windows.Forms.Timer { Interval = 500 };
        private readonly DateTime _started = DateTime.UtcNow;

        private string _lastStatus = "";
        private bool _finished;

        public StatusForm(ProgressState state)
        {
            _state = state;

            Text = "Better Beeper Update";
            FormBorderStyle = FormBorderStyle.FixedDialog;

            // No X button and no Alt+F4. Closing this window mid-install orphans the
            // install and leaves the app half replaced, so the one action that can
            // break it is not offered. Program.cs bounds the installer instead, so
            // this can never become a window with no way out.
            ControlBox = false;
            MaximizeBox = false;
            MinimizeBox = false;
            // Not TopMost. The window is the only thing on screen at this point -
            // the app is gone - so there is nothing to stay above, and a window
            // that insists on being in front is a window someone cannot get out
            // of the way of.
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(470, 200);
            BackColor = Color.FromArgb(24, 26, 30);
            ForeColor = Color.White;
            Font = new Font("Segoe UI", 9F);

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

            _warning.Text = "Do not close Better Beeper or this window. The app restarts by itself.";
            _warning.Location = new Point(24, 130);
            _warning.Size = new Size(420, 44);

            Controls.AddRange(new Control[] { title, _status, _bar, _elapsed, _warning });

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

        /// <summary>Shows the window and pumps messages until the work is finished and the linger is over.</summary>
        public void Pump()
        {
            _timer.Start();
            Application.Run(this);
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

        private void OnTick(object sender, EventArgs e)
        {
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

            if (Volatile.Read(ref _state.Ok))
            {
                _status.Text = "Install finished. Better Beeper is starting now.";
            }
            else
            {
                // Kept up rather than vanishing: a failure nobody sees is the worst
                // outcome, and the next launch cannot show this one.
                _status.Text = "The update did not finish. Better Beeper will reopen on the old version.";
                if (!string.IsNullOrEmpty(_state.Detail)) _warning.Text = _state.Detail;
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