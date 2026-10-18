param(
  [string]$PipeDir
)
$ErrorActionPreference = 'SilentlyContinue'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class DshNative {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int value);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("dwmapi.dll")] public static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lp);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public static IntPtr FindLargestWindow(uint pid) {
    IntPtr found = IntPtr.Zero;
    long best = 0;
    EnumWindows((h, l) => {
      uint p;
      GetWindowThreadProcessId(h, out p);
      if (p != pid || !IsWindowVisible(h)) return true;
      RECT r;
      GetWindowRect(h, out r);
      long area = (long)(r.Right - r.Left) * (r.Bottom - r.Top);
      if (area > best) { best = area; found = h; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
public sealed class DshCardForm : System.Windows.Forms.Form {
  protected override bool ShowWithoutActivation { get { return true; } }
  protected override System.Windows.Forms.CreateParams CreateParams {
    get {
      System.Windows.Forms.CreateParams cp = base.CreateParams;
      cp.ClassStyle |= 0x00020000;
      cp.ExStyle |= 0x08000000;
      return cp;
    }
  }
}
"@ -ReferencedAssemblies System.Windows.Forms
try { [DshNative]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null } catch {
  try { [DshNative]::SetProcessDpiAwareness(2) | Out-Null } catch { [DshNative]::SetProcessDPIAware() | Out-Null }
}

$scale = 1.0
try {
  $g0 = [System.Drawing.Graphics]::FromHwnd([IntPtr]::Zero)
  $scale = [Math]::Max(1.0, $g0.DpiX / 96.0)
  $g0.Dispose()
} catch {}
function S([double]$v) { return [int][Math]::Round($v * $scale) }
function Now { return [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }

function Write-Event([hashtable]$payload) {
  try {
    $json = $payload | ConvertTo-Json -Compress
    [Console]::Out.WriteLine($json)
    [Console]::Out.Flush()
  } catch {}
}

$cmdPath = Join-Path $PipeDir 'command.json'
$script:lastSeq = [int64]-1
$script:warmup = $false
$script:visible = $false
$script:closing = $false
$script:paused = $false
$script:hoverClose = $false
$script:pendingVisible = $false
$script:id = ''
$script:sessionId = ''
$script:title = ''
$script:body = ''
$script:variant = 'success'
$script:theme = 'dark'
$script:accentKey = 'green'
$script:durationSec = 6
$script:fontSize = 12
$script:fontFamily = 'Segoe UI'
$script:actionBase = ''
$script:url = ''
$script:targetPid = 0
$script:soundOn = $false
$script:soundType = 'apple'
$script:soundPath = ''
$script:tRecv = 0
$script:tShow = 0
$script:remaining = 0
$script:lastTick = 0

function Get-AccentColor([string]$key) {
  switch ($key) {
    'blue'   { return [System.Drawing.Color]::FromArgb(65, 118, 230) }
    'orange' { return [System.Drawing.Color]::FromArgb(245, 158, 11) }
    'purple' { return [System.Drawing.Color]::FromArgb(139, 92, 246) }
    'red'    { return [System.Drawing.Color]::FromArgb(239, 68, 68) }
    default  { return [System.Drawing.Color]::FromArgb(34, 197, 94) }
  }
}

function Get-ThemePalette([string]$theme) {
  if ($theme -eq 'light') {
    return @{
      bg = [System.Drawing.Color]::FromArgb(255, 255, 255)
      bgTop = [System.Drawing.Color]::FromArgb(255, 255, 255)
      bgBottom = [System.Drawing.Color]::FromArgb(247, 248, 250)
      fg = [System.Drawing.Color]::FromArgb(15, 17, 21)
      sub = [System.Drawing.Color]::FromArgb(97, 102, 107)
      border = [System.Drawing.Color]::FromArgb(229, 230, 235)
      closeFg = [System.Drawing.Color]::FromArgb(129, 133, 140)
      closeHover = [System.Drawing.Color]::FromArgb(241, 243, 245)
    }
  }
  return @{
    bg = [System.Drawing.Color]::FromArgb(35, 35, 36)
    bgTop = [System.Drawing.Color]::FromArgb(42, 42, 44)
    bgBottom = [System.Drawing.Color]::FromArgb(30, 30, 31)
    fg = [System.Drawing.Color]::FromArgb(249, 250, 251)
    sub = [System.Drawing.Color]::FromArgb(173, 178, 184)
    border = [System.Drawing.Color]::FromArgb(58, 58, 60)
    closeFg = [System.Drawing.Color]::FromArgb(129, 133, 140)
    closeHover = [System.Drawing.Color]::FromArgb(52, 52, 54)
  }
}

$form = New-Object DshCardForm
$form.Text = 'dsh-task-notify'
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$form.TopMost = $true
$form.ShowInTaskbar = $false
$form.AutoScaleMode = [System.Windows.Forms.AutoScaleMode]::None
$form.Cursor = [System.Windows.Forms.Cursors]::Hand
$form.Opacity = 0.05
$form.Width = S 380
$form.Height = S 84

try {
  $corner = 2
  [DshNative]::DwmSetWindowAttribute($form.Handle, 33, [ref]$corner, 4) | Out-Null
  $noBorder = -2
  [DshNative]::DwmSetWindowAttribute($form.Handle, 34, [ref]$noBorder, 4) | Out-Null
} catch {}

# 预先创建字体/画刷，避免首次绘制缺省
$script:titleFont = New-Object System.Drawing.Font('Segoe UI', 13, [System.Drawing.FontStyle]::Bold)
$script:bodyFont = New-Object System.Drawing.Font('Segoe UI', 12)
$script:iconFont = New-Object System.Drawing.Font('Segoe UI', 13, [System.Drawing.FontStyle]::Bold)
$script:closeFont = New-Object System.Drawing.Font('Segoe UI', 14)
$palette = Get-ThemePalette 'dark'
$script:bg = $palette.bg
$script:bgTop = $palette.bgTop
$script:bgBottom = $palette.bgBottom
$script:fg = $palette.fg
$script:sub = $palette.sub
$script:border = $palette.border
$script:closeFg = $palette.closeFg
$script:closeHover = $palette.closeHover
$script:accentColor = Get-AccentColor 'green'
$script:bodyLines = @('')
$script:titleRect = New-Object System.Drawing.RectangleF((S 50), (S 11), ($form.Width - (S 106)), (S 24))
$script:closeRect = New-Object System.Drawing.RectangleF(($form.Width - (S 42)), (S 6), (S 32), (S 32))
$script:badgeRect = New-Object System.Drawing.RectangleF((S 16), (S 14), (S 22), (S 22))
$script:bodyX = S 50
$script:bodyY = S 38
$script:lineHeight = S 18

$themeBrush = New-Object System.Drawing.SolidBrush($script:fg)
$subBrush = New-Object System.Drawing.SolidBrush($script:sub)
$accentBrush = New-Object System.Drawing.SolidBrush($script:accentColor)
$closeBrush = New-Object System.Drawing.SolidBrush($script:closeFg)
$iconBrush = New-Object System.Drawing.SolidBrush($script:accentColor)
$badgeBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(32, $script:accentColor))
$borderPen = New-Object System.Drawing.Pen($script:border, 1)
$titleFormat = New-Object System.Drawing.StringFormat
$titleFormat.Trimming = [System.Drawing.StringTrimming]::EllipsisCharacter
$titleFormat.FormatFlags = [System.Drawing.StringFormatFlags]::NoWrap
$centerFormat = New-Object System.Drawing.StringFormat
$centerFormat.Alignment = [System.Drawing.StringAlignment]::Center
$centerFormat.LineAlignment = [System.Drawing.StringAlignment]::Center

function Update-Card($cmd) {
  $script:id = [string]$cmd.id
  $script:tRecv = Now
  $script:sessionId = if ($cmd.sessionId) { [string]$cmd.sessionId } else { '' }
  $script:variant = if ($cmd.variant) { [string]$cmd.variant } else { 'success' }
  $script:theme = if ($cmd.theme -eq 'light') { 'light' } else { 'dark' }
  $script:accentKey = if ($cmd.accent) { [string]$cmd.accent } else { 'green' }
  $script:durationSec = if ($cmd.durationSec) { [int]$cmd.durationSec } else { 6 }
  $script:fontSize = if ($cmd.fontSize) { [int]$cmd.fontSize } else { 12 }
  $script:fontFamily = if ($cmd.fontFamily) { [string]$cmd.fontFamily } else { 'Segoe UI' }
  $script:actionBase = if ($cmd.actionBase) { [string]$cmd.actionBase } else { '' }
  $script:url = if ($cmd.url) { [string]$cmd.url } else { '' }
  $script:targetPid = if ($cmd.targetPid) { [int]$cmd.targetPid } else { 0 }
  $script:soundOn = [bool]$cmd.soundOn
  $script:soundType = if ($cmd.soundType) { [string]$cmd.soundType } else { 'apple' }
  $script:soundPath = if ($cmd.soundPath) { [string]$cmd.soundPath } else { '' }

  $title = if ($cmd.title) { [string]$cmd.title } else { 'DSH 会话' }
  $text = if ($cmd.body) { [string]$cmd.body } else { '' }
  if ($title.Length -gt 30) { $title = $title.Substring(0, 30) + '…' }
  if ($text.Length -gt 120) { $text = $text.Substring(0, 120) + '…' }
  $script:title = $title
  $script:body = $text

  $palette = Get-ThemePalette $script:theme
  $script:bg = $palette.bg
  $script:bgTop = $palette.bgTop
  $script:bgBottom = $palette.bgBottom
  $script:fg = $palette.fg
  $script:sub = $palette.sub
  $script:border = $palette.border
  $script:closeFg = $palette.closeFg
  $script:closeHover = $palette.closeHover
  $script:accentColor = Get-AccentColor $script:accentKey

  try { $script:titleFont.Dispose() } catch {}
  try { $script:bodyFont.Dispose() } catch {}
  try { $script:iconFont.Dispose() } catch {}
  $script:titleFont = New-Object System.Drawing.Font($script:fontFamily, ($script:fontSize + 1), [System.Drawing.FontStyle]::Bold)
  $script:bodyFont = New-Object System.Drawing.Font($script:fontFamily, $script:fontSize)
  $script:iconFont = New-Object System.Drawing.Font('Segoe UI', ($script:fontSize + 1), [System.Drawing.FontStyle]::Bold)

  $measure = [System.Drawing.Graphics]::FromHwnd([IntPtr]::Zero)
  $titleWidth = 0.0
  try { $titleWidth = $measure.MeasureString($script:title, $script:titleFont).Width } catch {}
  $formWidth = S 380
  if ($titleWidth -gt (S 290)) {
    $formWidth = [int][Math]::Min((S 620), [Math]::Max((S 380), ($titleWidth + (S 150))))
  }
  $textMaxWidth = $formWidth - (S 100)
  $bodyLines = New-Object System.Collections.ArrayList
  $line = ''
  $consumed = 0
  $maxLines = 2
  foreach ($ch in $script:body.ToCharArray()) {
    $candidate = $line + $ch
    $w = 0.0
    try { $w = $measure.MeasureString($candidate, $script:bodyFont).Width } catch {}
    if ($w -gt $textMaxWidth -and $line -ne '') {
      [void]$bodyLines.Add($line)
      $line = [string]$ch
      if ($bodyLines.Count -ge $maxLines) { break }
    } else {
      $line = $candidate
    }
    $consumed += 1
  }
  if ($bodyLines.Count -lt $maxLines -and $line -ne '') { [void]$bodyLines.Add($line) }
  if ($bodyLines.Count -eq 0) { [void]$bodyLines.Add('') }
  if ($consumed -lt $script:body.Length -and $bodyLines.Count -gt 0) {
    $bodyLines[$bodyLines.Count - 1] = $bodyLines[$bodyLines.Count - 1] + '…'
  }
  $measure.Dispose()
  $script:bodyLines = $bodyLines

  $formHeight = S 84
  if ($bodyLines.Count -ge 2) { $formHeight = S 96 }
  $form.Width = $formWidth
  $form.Height = $formHeight
  $script:titleRect = New-Object System.Drawing.RectangleF((S 50), (S 11), ($form.Width - (S 106)), (S 24))
  $script:closeRect = New-Object System.Drawing.RectangleF(($form.Width - (S 42)), (S 6), (S 32), (S 32))
  $script:badgeRect = New-Object System.Drawing.RectangleF((S 16), (S 14), (S 22), (S 22))

  # 位置：跟随 DSH 主窗口所在屏幕
  $script:targetHwnd = [IntPtr]::Zero
  $screen = [System.Windows.Forms.Screen]::PrimaryScreen
  if ($script:targetPid -gt 0) {
    try {
      $script:targetHwnd = [DshNative]::FindLargestWindow([uint32]$script:targetPid)
      if ($script:targetHwnd -ne [IntPtr]::Zero) { $screen = [System.Windows.Forms.Screen]::FromHandle($script:targetHwnd) }
    } catch {}
  }
  $area = $screen.WorkingArea
  $position = if ($cmd.position) { [string]$cmd.position } else { 'br' }
  switch ($position) {
    'bl' { $x = $area.Left + (S 16);      $y = $area.Bottom - $form.Height - (S 16) }
    'tr' { $x = $area.Right - $form.Width - (S 16); $y = $area.Top + (S 16) }
    'tl' { $x = $area.Left + (S 16);      $y = $area.Top + (S 16) }
    default { $x = $area.Right - $form.Width - (S 16); $y = $area.Bottom - $form.Height - (S 16) }
  }
  $form.Location = New-Object System.Drawing.Point($x, $y)

  $themeBrush.Color = $script:fg
  $subBrush.Color = $script:sub
  $accentBrush.Color = $script:accentColor
  $closeBrush.Color = $script:closeFg
  $iconBrush.Color = $script:accentColor
  $badgeBrush.Color = [System.Drawing.Color]::FromArgb(32, $script:accentColor)
  $borderPen.Color = $script:border

  if ($script:soundOn) {
    if ($script:soundType -eq 'system') {
      [System.Media.SystemSounds]::Asterisk.Play()
    } elseif ($script:soundPath -ne '') {
      try {
        $player = New-Object System.Media.SoundPlayer $script:soundPath
        $player.Play()
      } catch {}
    }
  }

  $script:closing = $false
  $script:hoverClose = $false
  $script:paused = $false
  $script:remaining = $script:durationSec * 1000
  $script:lastTick = Now
  $script:pendingVisible = $true
  $script:visible = $true
  $form.Opacity = 0.05
  $script:tShow = Now
  $form.Show()
  $form.Invalidate()
  $fade.Start()
  $auto.Start()
  Write-Event @{ type = 'recv'; id = $script:id; tRecv = $script:tRecv }
}

$form.Add_Paint({
  param($sender, $e)
  $g = $e.Graphics
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $rect = New-Object System.Drawing.Rectangle(0, 0, $form.Width, $form.Height)
  $gradient = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, $script:bgTop, $script:bgBottom, 90)
  $g.FillRectangle($gradient, $rect)
  $gradient.Dispose()
  $stripeRect = New-Object System.Drawing.Rectangle(0, 0, (S 3), $form.Height)
  $g.FillRectangle($accentBrush, $stripeRect)
  $g.FillEllipse($badgeBrush, $script:badgeRect)
  $iconText = '✓'
  if ($script:variant -eq 'error') { $iconText = '!' }
  elseif ($script:variant -eq 'wait') { $iconText = '?' }
  $g.DrawString($iconText, $script:iconFont, $iconBrush, $script:badgeRect, $centerFormat)
  $g.DrawString($script:title, $script:titleFont, $themeBrush, $script:titleRect, $titleFormat)
  $y = $script:bodyY
  foreach ($bodyLine in $script:bodyLines) {
    $g.DrawString($bodyLine, $script:bodyFont, $subBrush, (New-Object System.Drawing.PointF($script:bodyX, $y)))
    $y += $script:lineHeight
  }
  if ($script:hoverClose) {
    $g.FillEllipse((New-Object System.Drawing.SolidBrush($script:closeHover)), $script:closeRect)
  }
  $g.DrawString('×', $script:closeFont, $closeBrush, $script:closeRect, $centerFormat)
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $r = S 12
  $d = 2 * $r
  $path.AddArc(0, 0, $d, $d, 180, 90)
  $path.AddArc(($form.ClientSize.Width - $d), 0, $d, $d, 270, 90)
  $path.AddArc(($form.ClientSize.Width - $d), ($form.ClientSize.Height - $d), $d, $d, 0, 90)
  $path.AddArc(0, ($form.ClientSize.Height - $d), $d, $d, 90, 90)
  $path.CloseFigure()
  $g.DrawPath($borderPen, $path)
  $path.Dispose()

  if ($script:pendingVisible -and -not $script:warmup) {
    $script:pendingVisible = $false
    Write-Event @{ type = 'visible'; id = $script:id; tRecv = $script:tRecv; tShow = $script:tShow; tPaint = (Now) }
  }
})

$form.Add_MouseMove({
  param($sender, $e)
  $p = $form.PointToClient([System.Windows.Forms.Cursor]::Position)
  $inside = $script:closeRect.Contains([float]$p.X, [float]$p.Y)
  if ($inside -ne $script:hoverClose) {
    $script:hoverClose = $inside
    $form.Invalidate()
  }
})
$form.Add_MouseLeave({
  $script:hoverClose = $false
  $script:paused = $false
  $form.Invalidate()
})
$form.Add_MouseEnter({ $script:paused = $true })
$form.Add_MouseDown({
  param($sender, $e)
  $p = $form.PointToClient([System.Windows.Forms.Cursor]::Position)
  if ($script:closeRect.Contains([float]$p.X, [float]$p.Y)) {
    Begin-Close
  } else {
    if ($script:actionBase -ne '' -and $script:sessionId -ne '') {
      try {
        $payload = @{ action = 'open'; sessionId = $script:sessionId } | ConvertTo-Json -Compress
        Invoke-WebRequest -Uri ($script:actionBase + '/task-notify/action') -Method Post -ContentType 'application/json' -Body $payload -UseBasicParsing -TimeoutSec 3 | Out-Null
      } catch {}
    }
    if ($script:targetPid -gt 0) {
      try {
        $wsh = New-Object -ComObject WScript.Shell
        $wsh.AppActivate($script:targetPid) | Out-Null
      } catch {}
      if ($script:targetHwnd -ne [IntPtr]::Zero) {
        try {
          [DshNative]::ShowWindow($script:targetHwnd, 9) | Out-Null
          [DshNative]::SetForegroundWindow($script:targetHwnd) | Out-Null
        } catch {}
      }
    }
    Begin-Close
  }
})

function Begin-Close {
  if ($script:closing) { return }
  $script:closing = $true
  try { $fade.Start() } catch {}
}

$auto = New-Object System.Windows.Forms.Timer
$auto.Interval = 100
$auto.Add_Tick({
  if (-not $script:visible -or $script:closing) { return }
  $now = Now
  $inside = $form.Bounds.Contains([System.Windows.Forms.Cursor]::Position)
  if (-not $inside) {
    $script:remaining -= ($now - $script:lastTick)
    if ($script:remaining -le 0) { Begin-Close }
  }
  $script:lastTick = $now
})

$fade = New-Object System.Windows.Forms.Timer
$fade.Interval = 15
$fade.Add_Tick({
  if ($script:closing) {
    $form.Opacity -= 0.16
    if ($form.Opacity -le 0.04) {
      $fade.Stop()
      $form.Hide()
      $script:visible = $false
      $script:closing = $false
      Write-Event @{ type = 'closed'; id = $script:id }
    }
  } else {
    $form.Opacity += 0.16
    if ($form.Opacity -ge 1) { $form.Opacity = 1; $fade.Stop() }
  }
})

$poll = New-Object System.Windows.Forms.Timer
$poll.Interval = 20
$poll.Add_Tick({
  try {
    $raw = [System.IO.File]::ReadAllText($cmdPath)
    if ([string]::IsNullOrWhiteSpace($raw)) { return }
    $cmd = $raw | ConvertFrom-Json
    if ($null -eq $cmd) { return }
    $seq = [int64]$cmd.seq
    if ($seq -le $script:lastSeq) { return }
    $script:lastSeq = $seq
    Update-Card $cmd
  } catch {
    Write-Event @{ type = 'error'; message = [string]$_.Exception.Message }
  }
})

# 预热：离屏显示一次并隐藏，创建句柄/字体/DWM 资源
try {
  $script:warmup = $true
  $form.Location = New-Object System.Drawing.Point(-20000, -20000)
  $form.Show()
  [System.Windows.Forms.Application]::DoEvents()
  $form.Hide()
  $script:warmup = $false
  $form.Opacity = 1
} catch {}

$poll.Start()
Write-Event @{ type = 'ready'; pid = $PID; ts = (Now) }

$context = New-Object System.Windows.Forms.ApplicationContext
[System.Windows.Forms.Application]::Run($context)
