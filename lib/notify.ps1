# dsh-notify popup renderer.
#
# Reads ONE JSON notification payload from stdin and shows it as a topmost
# notification card (and/or a Windows toast). ASCII-only source: every
# user-visible string arrives in the UTF-8 JSON payload, so this file never
# depends on the console code page.
#
# Payload fields:
#   kind                 completed | input | error | aborted | blocked | max-tokens
#   title, body, footer  display strings
#   accent               #RRGGBB accent bar color
#   style                popup | toast | both
#   position             bottom-right | bottom-left | top-right | top-left
#   sound                bool
#   suppressWhenFocused  bool (skip when the DSH window is foreground)
#   durationMs           popup lifetime
#   slot                 stacking slot index
#   toastAppId           optional toast AUMID override
#
# Exit codes: 0 shown or intentionally suppressed, 1 render failure,
# 2 empty/invalid payload.

$ErrorActionPreference = 'Stop'

try {
    [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
    $raw = [Console]::In.ReadToEnd()
    if ([string]::IsNullOrWhiteSpace($raw)) { exit 2 }
    $payload = $raw | ConvertFrom-Json
} catch {
    [Console]::Error.WriteLine("dsh-notify: invalid payload: $($_.Exception.Message)")
    exit 2
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

namespace DshNotify
{
    public static class Native
    {
        [DllImport("user32.dll")]
        private static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
        [DllImport("user32.dll")]
        private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
        [DllImport("user32.dll")]
        private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr extraData);
        [DllImport("user32.dll")]
        private static extern bool IsWindowVisible(IntPtr hWnd);
        [DllImport("user32.dll")]
        private static extern bool IsIconic(IntPtr hWnd);
        [DllImport("user32.dll")]
        private static extern bool ShowWindow(IntPtr hWnd, int command);
        [DllImport("user32.dll")]
        private static extern bool SetForegroundWindow(IntPtr hWnd);
        [DllImport("user32.dll")]
        private static extern void keybd_event(byte virtualKey, byte scan, uint flags, IntPtr extraInfo);
        [DllImport("user32.dll")]
        public static extern bool SetProcessDPIAware();

        private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr extraData);

        private static bool Matches(IntPtr handle, string marker)
        {
            uint pid;
            GetWindowThreadProcessId(handle, out pid);
            try
            {
                Process process = Process.GetProcessById((int)pid);
                if (process.ProcessName.IndexOf(marker, StringComparison.OrdinalIgnoreCase) >= 0) return true;
            }
            catch { }
            StringBuilder title = new StringBuilder(512);
            GetWindowText(handle, title, title.Capacity);
            return title.ToString().IndexOf(marker, StringComparison.OrdinalIgnoreCase) >= 0;
        }

        public static bool IsProcessFocused(string marker)
        {
            IntPtr handle = GetForegroundWindow();
            if (handle == IntPtr.Zero) return false;
            return Matches(handle, marker);
        }

        /** Restore and activate the first visible window whose process or title matches the marker. */
        public static bool FocusMarker(string marker)
        {
            IntPtr found = IntPtr.Zero;
            EnumWindows(delegate (IntPtr handle, IntPtr extra)
            {
                if (!IsWindowVisible(handle)) return true;
                if (!Matches(handle, marker)) return true;
                found = handle;
                return false;
            }, IntPtr.Zero);
            if (found == IntPtr.Zero) return false;
            if (IsIconic(found)) ShowWindow(found, 9); // SW_RESTORE
            // A synthetic Alt tap unlocks SetForegroundWindow for the clicked notification.
            keybd_event(0x12, 0, 0, IntPtr.Zero);
            keybd_event(0x12, 0, 2, IntPtr.Zero);
            return SetForegroundWindow(found);
        }
    }

    public class ToastForm : Form
    {
        private readonly string _title;
        private readonly string _body;
        private readonly string _footer;
        private readonly string _clickUrl;
        private readonly Color _accent;
        private readonly float _scale;
        private readonly Timer _timer;

        public ToastForm(string title, string body, string footer, string accentHex, string clickUrl, float scale, int durationMs, Point location)
        {
            _title = title ?? string.Empty;
            _body = body ?? string.Empty;
            _footer = footer ?? string.Empty;
            _clickUrl = clickUrl ?? string.Empty;
            _accent = ParseColor(accentHex, Color.FromArgb(63, 185, 80));
            _scale = scale <= 0.1f ? 1f : scale;

            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.Manual;
            ShowInTaskbar = false;
            TopMost = true;
            BackColor = Color.FromArgb(23, 27, 34);
            DoubleBuffered = true;
            Cursor = Cursors.Hand;
            SetStyle(ControlStyles.ResizeRedraw | ControlStyles.OptimizedDoubleBuffer | ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint, true);

            Size = new Size(S(460), S(150));
            Location = Clamp(location, Size);
            using (GraphicsPath path = Rounded(new Rectangle(0, 0, Width, Height), S(12)))
            {
                Region = new Region(path);
            }

            _timer = new Timer();
            _timer.Interval = Math.Max(1500, durationMs);
            _timer.Tick += (sender, args) => { _timer.Stop(); Close(); };
            _timer.Start();
        }

        protected override bool ShowWithoutActivation { get { return true; } }

        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams cp = base.CreateParams;
                cp.ExStyle |= 0x08000000; // WS_EX_NOACTIVATE
                return cp;
            }
        }

        private int S(float value) { return (int)Math.Round(value * _scale); }

        private static Point Clamp(Point location, Size size)
        {
            Rectangle area = Screen.FromPoint(location).WorkingArea;
            int x = Math.Min(Math.Max(location.X, area.Left + 8), Math.Max(area.Left + 8, area.Right - size.Width - 8));
            int y = Math.Min(Math.Max(location.Y, area.Top + 8), Math.Max(area.Top + 8, area.Bottom - size.Height - 8));
            return new Point(x, y);
        }

        private static Color ParseColor(string hex, Color fallback)
        {
            try
            {
                string value = (hex ?? string.Empty).TrimStart('#');
                if (value.Length == 6)
                {
                    return Color.FromArgb(255,
                        Convert.ToInt32(value.Substring(0, 2), 16),
                        Convert.ToInt32(value.Substring(2, 2), 16),
                        Convert.ToInt32(value.Substring(4, 2), 16));
                }
            }
            catch { }
            return fallback;
        }

        private static GraphicsPath Rounded(Rectangle rect, int radius)
        {
            int d = Math.Max(2, radius * 2);
            GraphicsPath path = new GraphicsPath();
            path.AddArc(rect.X, rect.Y, d, d, 180, 90);
            path.AddArc(rect.Right - d, rect.Y, d, d, 270, 90);
            path.AddArc(rect.Right - d, rect.Bottom - d, d, d, 0, 90);
            path.AddArc(rect.X, rect.Bottom - d, d, d, 90, 90);
            path.CloseFigure();
            return path;
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;

            using (SolidBrush bg = new SolidBrush(Color.FromArgb(23, 27, 34))) g.FillRectangle(bg, ClientRectangle);
            using (SolidBrush accent = new SolidBrush(_accent)) g.FillRectangle(accent, new Rectangle(0, 0, S(4), Height));

            StringFormat titleFormat = new StringFormat
            {
                Trimming = StringTrimming.EllipsisCharacter,
                FormatFlags = StringFormatFlags.NoWrap
            };
            using (Font font = new Font("Microsoft YaHei UI", 13.5f * _scale, FontStyle.Bold, GraphicsUnit.Point))
            using (SolidBrush brush = new SolidBrush(Color.FromArgb(242, 246, 252)))
            {
                g.DrawString(_title, font, brush, new RectangleF(S(20), S(13), Width - S(74), S(30)), titleFormat);
            }

            StringFormat closeFormat = new StringFormat
            {
                Alignment = StringAlignment.Center,
                LineAlignment = StringAlignment.Center
            };
            using (Font font = new Font("Segoe UI", 11f * _scale, FontStyle.Regular, GraphicsUnit.Point))
            using (SolidBrush brush = new SolidBrush(Color.FromArgb(118, 128, 144)))
            {
                g.DrawString("\u00D7", font, brush, new RectangleF(Width - S(40), S(8), S(30), S(30)), closeFormat);
            }

            StringFormat bodyFormat = new StringFormat
            {
                Trimming = StringTrimming.EllipsisWord,
                FormatFlags = StringFormatFlags.LineLimit
            };
            using (Font font = new Font("Microsoft YaHei UI", 10.5f * _scale, FontStyle.Regular, GraphicsUnit.Point))
            using (SolidBrush brush = new SolidBrush(Color.FromArgb(196, 204, 216)))
            {
                g.DrawString(_body, font, brush, new RectangleF(S(20), S(47), Width - S(40), S(64)), bodyFormat);
            }

            StringFormat footerFormat = new StringFormat
            {
                Trimming = StringTrimming.EllipsisCharacter,
                FormatFlags = StringFormatFlags.NoWrap
            };
            using (Font font = new Font("Microsoft YaHei UI", 8.8f * _scale, FontStyle.Regular, GraphicsUnit.Point))
            using (SolidBrush brush = new SolidBrush(Color.FromArgb(128, 139, 156)))
            {
                g.DrawString(_footer, font, brush, new RectangleF(S(20), Height - S(29), Width - S(40), S(20)), footerFormat);
            }

            using (Pen pen = new Pen(Color.FromArgb(56, 64, 80), 1f))
            using (GraphicsPath border = Rounded(new Rectangle(0, 0, Width - 1, Height - 1), S(12)))
            {
                g.DrawPath(pen, border);
            }
        }

        protected override void OnMouseClick(MouseEventArgs e)
        {
            base.OnMouseClick(e);
            if (!string.IsNullOrEmpty(_clickUrl))
            {
                try
                {
                    Native.FocusMarker("DeepSeek Harness");
                }
                catch { }
                try
                {
                    using (System.Net.WebClient client = new System.Net.WebClient())
                    {
                        client.Headers.Add("User-Agent", "dsh-notify");
                        client.DownloadString(_clickUrl);
                    }
                }
                catch { }
            }
            _timer.Stop();
            Close();
        }
    }
}
'@ -ReferencedAssemblies System.Windows.Forms, System.Drawing

try {
    [void][DshNotify.Native]::SetProcessDPIAware()
} catch { }

$style = ([string]$payload.style).ToLowerInvariant()
if ([string]::IsNullOrWhiteSpace($style)) { $style = 'popup' }

if ([bool]$payload.suppressWhenFocused -and [DshNotify.Native]::IsProcessFocused('DeepSeek Harness')) {
    exit 0
}

if ($style -eq 'toast' -or $style -eq 'both') {
    try {
        [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
        [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
        $aumid = [string]$payload.toastAppId
        if ([string]::IsNullOrWhiteSpace($aumid)) {
            $aumid = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
        }
        $toastTitle = [System.Security.SecurityElement]::Escape([string]$payload.title)
        $toastBody = [System.Security.SecurityElement]::Escape([string]$payload.body)
        $xmlString = "<toast><visual><binding template=`"ToastGeneric`"><text>$toastTitle</text><text>$toastBody</text></binding></visual></toast>"
        $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
        $xml.LoadXml($xmlString)
        $toast = New-Object Windows.UI.Notifications.ToastNotification $xml
        [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($aumid).Show($toast)
    } catch {
        [Console]::Error.WriteLine("dsh-notify: toast failed: $($_.Exception.Message)")
    }
}

if ($style -ne 'toast') {
    if ([bool]$payload.sound) {
        try {
            $kind = [string]$payload.kind
            if ($kind -eq 'error') { [System.Media.SystemSounds]::Hand.Play() }
            elseif ($kind -eq 'input') { [System.Media.SystemSounds]::Exclamation.Play() }
            else { [System.Media.SystemSounds]::Asterisk.Play() }
        } catch { }
    }

    [System.Windows.Forms.Application]::EnableVisualStyles()

    $scale = 1.0
    try {
        $graphics = [System.Drawing.Graphics]::FromHwnd([IntPtr]::Zero)
        $scale = $graphics.DpiX / 96.0
        $graphics.Dispose()
    } catch { }
    if ($scale -le 0.5 -or $scale -gt 4) { $scale = 1.0 }

    $slot = 0
    if ($payload.slot -ne $null) { $slot = [int]$payload.slot }
    $width = [int][Math]::Round(460 * $scale)
    $height = [int][Math]::Round(150 * $scale)
    $margin = [int][Math]::Round(24 * $scale)
    $gap = [int][Math]::Round(10 * $scale)

    $screen = [System.Windows.Forms.Screen]::FromPoint([System.Windows.Forms.Cursor]::Position)
    $area = $screen.WorkingArea
    $position = [string]$payload.position
    $isLeft = $position -like '*left*'
    $isTop = $position -like 'top*'
    if ($isLeft) { $x = $area.Left + $margin } else { $x = $area.Right - $width - $margin }
    if ($isTop) { $y = $area.Top + $margin + ($slot * ($height + $gap)) } else { $y = $area.Bottom - $height - $margin - ($slot * ($height + $gap)) }

    $duration = 7000
    if ($payload.durationMs -ne $null) { $duration = [int]$payload.durationMs }

    $form = New-Object DshNotify.ToastForm(
        [string]$payload.title,
        [string]$payload.body,
        [string]$payload.footer,
        [string]$payload.accent,
        [string]$payload.clickUrl,
        $scale,
        $duration,
        (New-Object System.Drawing.Point($x, $y)))

    $form.Show()
    $deadline = [DateTime]::UtcNow.AddMilliseconds($duration)
    while (-not $form.IsDisposed -and [DateTime]::UtcNow -lt $deadline) {
        [System.Windows.Forms.Application]::DoEvents()
        Start-Sleep -Milliseconds 25
    }
    if (-not $form.IsDisposed) { $form.Close() }
}

exit 0
