'use strict';

/**
 * Real desktop control: screen capture via Electron desktopCapturer, mouse and
 * keyboard via Win32 SendInput (user32). Input runs through one long-lived
 * hidden PowerShell helper that talks JSON lines, so actions cost milliseconds
 * instead of a PowerShell + Add-Type startup each time.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { checkPath } = require('./guardrails.cjs');
const platform = require('./platform.cjs');

const MAX_TEXT_CHARS = 2000;
const MAX_SHOTS = 40;
const MAX_UIA_NODES = 1200;
const MAX_RECORD_MS = 10 * 60 * 1000;
const CORE_PROCESSES = new Set([
  'system',
  'idle',
  'csrss',
  'wininit',
  'winlogon',
  'services',
  'lsass',
  'smss',
  'svchost',
  'dwm',
  'fontdrvhost',
  'registry',
  'memory compression',
]);

let dataDir = null;
let scriptPath = null;
let lastCpuTimes = null;
let gpuCache = { at: 0, info: null, probing: false };

function init(opts) {
  dataDir = opts && opts.dataDir ? opts.dataDir : null;
  if (process.platform === 'win32') {
    // Load the persistent UIA host while the app is idle so the first real
    // desktop action does not pay PowerShell + assembly startup.
    const timer = setTimeout(() => {
      ensureUiaHost().catch(() => {});
    }, 1500);
    if (timer.unref) timer.unref();
  }
}

function baseDir() {
  if (dataDir) return dataDir;
  try {
    return require('electron').app.getPath('userData');
  } catch {
    return process.cwd();
  }
}

function electronApi() {
  try {
    const electron = require('electron');
    if (electron && electron.screen && electron.desktopCapturer) return electron;
  } catch {
    /* plain Node — no Electron APIs */
  }
  return null;
}

const PS_SCRIPT = `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading;

public static class OrvInput
{
    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT
    {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT
    {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct HARDWAREINPUT
    {
        public uint uMsg;
        public ushort wParamL;
        public ushort wParamH;
    }

    [StructLayout(LayoutKind.Explicit)]
    public struct INPUTUNION
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
        [FieldOffset(0)] public HARDWAREINPUT hi;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT
    {
        public uint type;
        public INPUTUNION u;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    [DllImport("user32.dll")]
    private static extern bool SetCursorPos(int x, int y);

    [DllImport("user32.dll")]
    private static extern int GetSystemMetrics(int index);

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }

    [DllImport("user32.dll")]
    private static extern bool GetCursorPos(out POINT p);

    public static string CursorPos()
    {
        POINT p;
        GetCursorPos(out p);
        return p.X + "," + p.Y;
    }

    private const uint INPUT_MOUSE = 0;
    private const uint INPUT_KEYBOARD = 1;
    private const uint KEYEVENTF_KEYUP = 0x0002;
    private const uint KEYEVENTF_UNICODE = 0x0004;
    private const uint MOUSEEVENTF_MOVE = 0x0001;
    private const uint MOUSEEVENTF_ABSOLUTE = 0x8000;
    private const uint MOUSEEVENTF_VIRTUALDESK = 0x4000;
    private const uint MOUSEEVENTF_WHEEL = 0x0800;

    public static string VirtualScreen()
    {
        return GetSystemMetrics(76) + "," + GetSystemMetrics(77) + "," + GetSystemMetrics(78) + "x" + GetSystemMetrics(79);
    }

    public static bool Move(int x, int y) { return SetCursorPos(x, y); }

    public static void Click(int x, int y, int button, int count)
    {
        uint down = 0x0002;
        uint up = 0x0004;
        if (button == 1) { down = 0x0008; up = 0x0010; }
        if (button == 2) { down = 0x0020; up = 0x0040; }

        int vx = GetSystemMetrics(76);
        int vy = GetSystemMetrics(77);
        int vw = GetSystemMetrics(78);
        int vh = GetSystemMetrics(79);
        if (vw <= 1) vw = 2;
        if (vh <= 1) vh = 2;

        uint move = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
        int nx = (int)Math.Round((x - vx) * 65535.0 / (vw - 1));
        int ny = (int)Math.Round((y - vy) * 65535.0 / (vh - 1));

        for (int i = 0; i < count; i++)
        {
            INPUT[] pair = new INPUT[2];
            pair[0].type = INPUT_MOUSE;
            pair[0].u.mi.dx = nx;
            pair[0].u.mi.dy = ny;
            pair[0].u.mi.dwFlags = move | down;
            pair[1].type = INPUT_MOUSE;
            pair[1].u.mi.dx = nx;
            pair[1].u.mi.dy = ny;
            pair[1].u.mi.dwFlags = move | up;
            if (SendInput(2, pair, Marshal.SizeOf(typeof(INPUT))) != 2)
            {
                throw new Exception("Windows blocked the click (SendInput error " + Marshal.GetLastWin32Error() + ").");
            }
            if (i < count - 1) Thread.Sleep(120);
        }
    }

    private static void SendAbs(int nx, int ny, uint flags)
    {
        INPUT[] a = new INPUT[1];
        a[0].type = INPUT_MOUSE;
        a[0].u.mi.dx = nx;
        a[0].u.mi.dy = ny;
        a[0].u.mi.dwFlags = flags;
        SendInput(1, a, Marshal.SizeOf(typeof(INPUT)));
    }

    public static void Button(int button, bool down)
    {
        uint flag;
        if (button == 1) flag = down ? 0x0008u : 0x0010u;
        else if (button == 2) flag = down ? 0x0020u : 0x0040u;
        else flag = down ? 0x0002u : 0x0004u;
        INPUT[] a = new INPUT[1];
        a[0].type = INPUT_MOUSE;
        a[0].u.mi.dwFlags = flag;
        if (SendInput(1, a, Marshal.SizeOf(typeof(INPUT))) != 1)
        {
            throw new Exception("Windows blocked the mouse button (SendInput error " + Marshal.GetLastWin32Error() + ").");
        }
    }

    public static void Wheel(int delta)
    {
        INPUT[] a = new INPUT[1];
        a[0].type = INPUT_MOUSE;
        a[0].u.mi.mouseData = (uint)delta;
        a[0].u.mi.dwFlags = MOUSEEVENTF_WHEEL;
        if (SendInput(1, a, Marshal.SizeOf(typeof(INPUT))) != 1)
        {
            throw new Exception("Windows blocked the wheel (SendInput error " + Marshal.GetLastWin32Error() + ").");
        }
    }

    public static void Drag(int x1, int y1, int x2, int y2, int button, int steps, int ms)
    {
        if (!Move(x1, y1)) throw new Exception("Could not move the cursor to the drag start.");
        Thread.Sleep(80);

        uint down = 0x0002;
        uint up = 0x0004;
        if (button == 1) { down = 0x0008; up = 0x0010; }
        if (button == 2) { down = 0x0020; up = 0x0040; }

        int vx = GetSystemMetrics(76);
        int vy = GetSystemMetrics(77);
        int vw = GetSystemMetrics(78);
        int vh = GetSystemMetrics(79);
        if (vw <= 1) vw = 2;
        if (vh <= 1) vh = 2;
        uint move = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;

        if (steps < 4) steps = 4;
        if (steps > 120) steps = 120;
        if (ms < 100) ms = 100;
        if (ms > 5000) ms = 5000;

        int nx = (int)Math.Round((x1 - vx) * 65535.0 / (vw - 1));
        int ny = (int)Math.Round((y1 - vy) * 65535.0 / (vh - 1));
        SendAbs(nx, ny, move | down);
        Thread.Sleep(60);

        for (int i = 1; i <= steps; i++)
        {
            int px = x1 + (int)((long)(x2 - x1) * i / steps);
            int py = y1 + (int)((long)(y2 - y1) * i / steps);
            nx = (int)Math.Round((px - vx) * 65535.0 / (vw - 1));
            ny = (int)Math.Round((py - vy) * 65535.0 / (vh - 1));
            SendAbs(nx, ny, move);
            Thread.Sleep(Math.Max(2, ms / steps));
        }
        SendAbs(nx, ny, move | up);
    }

    private static bool UnicodeChar(ushort code, bool keyUp)
    {
        INPUT[] a = new INPUT[1];
        a[0].type = INPUT_KEYBOARD;
        a[0].u.ki.wVk = 0;
        a[0].u.ki.wScan = code;
        a[0].u.ki.dwFlags = KEYEVENTF_UNICODE | (keyUp ? KEYEVENTF_KEYUP : 0);
        return SendInput(1, a, Marshal.SizeOf(typeof(INPUT))) == 1;
    }

    public static void KeyDown(ushort vk)
    {
        INPUT[] a = new INPUT[1];
        a[0].type = INPUT_KEYBOARD;
        a[0].u.ki.wVk = vk;
        a[0].u.ki.wScan = 0;
        a[0].u.ki.dwFlags = 0;
        if (SendInput(1, a, Marshal.SizeOf(typeof(INPUT))) != 1)
        {
            throw new Exception("Windows blocked key input (SendInput error " + Marshal.GetLastWin32Error() + ").");
        }
    }

    public static void KeyUp(ushort vk)
    {
        INPUT[] a = new INPUT[1];
        a[0].type = INPUT_KEYBOARD;
        a[0].u.ki.wVk = vk;
        a[0].u.ki.wScan = 0;
        a[0].u.ki.dwFlags = KEYEVENTF_KEYUP;
        if (SendInput(1, a, Marshal.SizeOf(typeof(INPUT))) != 1)
        {
            throw new Exception("Windows blocked key input (SendInput error " + Marshal.GetLastWin32Error() + ").");
        }
    }

    public static void TypeText(string text)
    {
        int n = 0;
        foreach (char c in text)
        {
            if (c == '\\r') continue;
            if (c == '\\n') { KeyDown(0x0D); KeyUp(0x0D); n++; continue; }
            if (c == '\\t') { KeyDown(0x09); KeyUp(0x09); n++; continue; }
            bool ok = UnicodeChar((ushort)c, false);
            ok = UnicodeChar((ushort)c, true) && ok;
            if (!ok) throw new Exception("Windows blocked keyboard input (SendInput error " + Marshal.GetLastWin32Error() + ").");
            n++;
            if (n % 25 == 0) Thread.Sleep(5);
        }
    }
}

public class OrvWinInfo
{
    public long hwnd { get; set; }
    public uint pid { get; set; }
    public string title { get; set; }
    public string cls { get; set; }
    public string state { get; set; }
    public int x { get; set; }
    public int y { get; set; }
    public int w { get; set; }
    public int h { get; set; }
    public bool foreground { get; set; }
}

public static class OrvWin
{
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    private delegate bool EnumProc(IntPtr h, IntPtr extra);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumProc cb, IntPtr extra);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int max);
    [DllImport("user32.dll")]
    private static extern int GetWindowTextLength(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr h, System.Text.StringBuilder s, int max);
    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")]
    private static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")]
    private static extern bool IsZoomed(IntPtr h);
    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")]
    private static extern bool PostMessage(IntPtr h, uint msg, IntPtr wp, IntPtr lp);
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    public static OrvWinInfo[] List()
    {
        var list = new System.Collections.Generic.List<OrvWinInfo>();
        IntPtr fg = GetForegroundWindow();
        EnumWindows(delegate(IntPtr h, IntPtr extra)
        {
            if (!IsWindowVisible(h)) return true;
            int len = GetWindowTextLength(h);
            if (len <= 0) return true;
            var sb = new System.Text.StringBuilder(len + 2);
            GetWindowText(h, sb, sb.Capacity);
            string title = sb.ToString();
            if (title.Trim().Length == 0) return true;

            var cls = new System.Text.StringBuilder(256);
            GetClassName(h, cls, cls.Capacity);
            uint pid = 0;
            GetWindowThreadProcessId(h, out pid);
            RECT r;
            GetWindowRect(h, out r);

            list.Add(new OrvWinInfo
            {
                hwnd = h.ToInt64(),
                pid = pid,
                title = title,
                cls = cls.ToString(),
                state = IsIconic(h) ? "minimized" : (IsZoomed(h) ? "maximized" : "normal"),
                x = r.Left,
                y = r.Top,
                w = r.Right - r.Left,
                h = r.Bottom - r.Top,
                foreground = h == fg
            });
            return true;
        }, IntPtr.Zero);
        return list.ToArray();
    }

    public static OrvWinInfo Find(long hwnd)
    {
        IntPtr h = new IntPtr(hwnd);
        if (!IsWindow(h)) return null;
        var sb = new System.Text.StringBuilder(1024);
        GetWindowText(h, sb, sb.Capacity);
        var cls = new System.Text.StringBuilder(256);
        GetClassName(h, cls, cls.Capacity);
        uint pid = 0;
        GetWindowThreadProcessId(h, out pid);
        RECT r;
        GetWindowRect(h, out r);
        return new OrvWinInfo
        {
            hwnd = hwnd,
            pid = pid,
            title = sb.ToString(),
            cls = cls.ToString(),
            state = IsIconic(h) ? "minimized" : (IsZoomed(h) ? "maximized" : "normal"),
            x = r.Left,
            y = r.Top,
            w = r.Right - r.Left,
            h = r.Bottom - r.Top,
            foreground = h == GetForegroundWindow()
        };
    }

    public static string Act(long hwnd, string op)
    {
        IntPtr h = new IntPtr(hwnd);
        if (!IsWindow(h)) throw new Exception("That window no longer exists.");
        switch (op)
        {
            case "focus":
                if (IsIconic(h)) ShowWindow(h, 9);
                if (!SetForegroundWindow(h))
                {
                    ShowWindow(h, 6);
                    ShowWindow(h, 9);
                    SetForegroundWindow(h);
                }
                return "focused";
            case "minimize":
                ShowWindow(h, 6);
                return "minimized";
            case "maximize":
                ShowWindow(h, 3);
                return "maximized";
            case "restore":
                ShowWindow(h, 9);
                return "restored";
            case "close":
                PostMessage(h, 0x0010, IntPtr.Zero, IntPtr.Zero);
                return "close requested";
            default:
                throw new Exception("Unknown window action: " + op);
        }
    }
}

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
public class OrvMmDeviceEnumerator { }

[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface OrvIMMDeviceEnumerator
{
    int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
    int GetDefaultAudioEndpoint(int dataFlow, int role, out OrvIMMDevice device);
    int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out OrvIMMDevice device);
    int RegisterEndpointNotificationCallback(IntPtr client);
    int UnregisterEndpointNotificationCallback(IntPtr client);
}

[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface OrvIMMDevice
{
    int Activate(ref Guid iid, uint clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
    int OpenPropertyStore(uint access, out IntPtr store);
    int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    int GetState(out uint state);
}

[ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface OrvIAudioEndpointVolume
{
    int RegisterControlChangeNotify(IntPtr notify);
    int UnregisterControlChangeNotify(IntPtr notify);
    int GetChannelCount(out uint count);
    int SetMasterVolumeLevel(float level, Guid ctx);
    int SetMasterVolumeLevelScalar(float level, Guid ctx);
    int GetMasterVolumeLevel(out float level);
    int GetMasterVolumeLevelScalar(out float level);
    int SetChannelVolumeLevel(uint channel, float level, Guid ctx);
    int SetChannelVolumeLevelScalar(uint channel, float level, Guid ctx);
    int GetChannelVolumeLevel(uint channel, out float level);
    int GetChannelVolumeLevelScalar(uint channel, out float level);
    int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, Guid ctx);
    int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
}

public static class OrvAudio
{
    private static OrvIAudioEndpointVolume Endpoint()
    {
        var enumerator = (OrvIMMDeviceEnumerator)(new OrvMmDeviceEnumerator());
        OrvIMMDevice device;
        Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(0, 1, out device));
        Guid iid = typeof(OrvIAudioEndpointVolume).GUID;
        object iface;
        Marshal.ThrowExceptionForHR(device.Activate(ref iid, 23, IntPtr.Zero, out iface));
        return (OrvIAudioEndpointVolume)iface;
    }

    public static int Volume()
    {
        var ep = Endpoint();
        float v;
        Marshal.ThrowExceptionForHR(ep.GetMasterVolumeLevelScalar(out v));
        return (int)Math.Round(v * 100);
    }

    public static bool Muted()
    {
        var ep = Endpoint();
        bool m;
        Marshal.ThrowExceptionForHR(ep.GetMute(out m));
        return m;
    }

    public static void SetVolume(int percent)
    {
        var ep = Endpoint();
        Marshal.ThrowExceptionForHR(ep.SetMasterVolumeLevelScalar(percent / 100f, Guid.Empty));
    }

    public static void SetMute(bool mute)
    {
        var ep = Endpoint();
        Marshal.ThrowExceptionForHR(ep.SetMute(mute, Guid.Empty));
    }
}
'@

function To-JsonB64($obj) {
  if ($null -eq $obj) { $obj = @() }
  # -InputObject keeps single-item arrays as JSON arrays; piping would unwrap them.
  $json = ConvertTo-Json -InputObject $obj -Compress -Depth 8
  if ($null -eq $json) { $json = 'null' }
  return 'J:' + [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($json))
}

[Console]::Out.WriteLine('R:READY')
[Console]::Out.Flush()

while ($null -ne ($line = [Console]::In.ReadLine())) {
  $line = $line.Trim()
  if ($line -eq '') { continue }
  $msg = ''
  try {
    $cmd = $line | ConvertFrom-Json
    switch ($cmd.action) {
      'move' {
        if (-not [OrvInput]::Move([int]$cmd.x, [int]$cmd.y)) { throw 'SetCursorPos failed.' }
        $msg = 'moved to ' + $cmd.x + ',' + $cmd.y
      }
      'click' {
        [OrvInput]::Click([int]$cmd.x, [int]$cmd.y, [int]$cmd.button, [int]$cmd.count)
        $msg = 'clicked ' + $cmd.x + ',' + $cmd.y + ' x' + $cmd.count
      }
      'type' {
        $text = [System.IO.File]::ReadAllText([string]$cmd.file, [System.Text.Encoding]::UTF8)
        [OrvInput]::TypeText($text)
        $msg = 'typed ' + $text.Length + ' chars'
      }
      'key' {
        $codes = @()
        foreach ($v in $cmd.vks) { $codes += [uint16]$v }
        if ($codes.Count -eq 0) { throw 'No key codes given.' }
        foreach ($c in $codes) { [OrvInput]::KeyDown($c) }
        Start-Sleep -Milliseconds 25
        for ($i = $codes.Count - 1; $i -ge 0; $i--) { [OrvInput]::KeyUp($codes[$i]) }
        $msg = 'pressed ' + ($codes -join '+')
      }
      'cursor' {
        $msg = 'cursor=' + [OrvInput]::CursorPos() + ' virtual=' + ([OrvInput]::VirtualScreen())
      }
      'scroll' {
        if ($null -ne $cmd.x -and $null -ne $cmd.y) {
          [OrvInput]::Move([int]$cmd.x, [int]$cmd.y) | Out-Null
          Start-Sleep -Milliseconds 40
        }
        [OrvInput]::Wheel([int]$cmd.delta)
        $msg = 'scrolled ' + $cmd.delta
      }
      'drag' {
        [OrvInput]::Drag([int]$cmd.x1, [int]$cmd.y1, [int]$cmd.x2, [int]$cmd.y2, [int]$cmd.button, [int]$cmd.steps, [int]$cmd.ms)
        $msg = 'dragged ' + $cmd.x1 + ',' + $cmd.y1 + ' to ' + $cmd.x2 + ',' + $cmd.y2
      }
      'down' {
        [OrvInput]::Button([int]$cmd.button, $true)
        $msg = 'button down'
      }
      'up' {
        [OrvInput]::Button([int]$cmd.button, $false)
        $msg = 'button up'
      }
      'volume' {
        try {
          if ($null -ne $cmd.level) { [OrvAudio]::SetVolume([int]$cmd.level) }
          if ($null -ne $cmd.mute) { [OrvAudio]::SetMute([bool]$cmd.mute) }
          $msg = To-JsonB64 ([pscustomobject]@{ supported = $true; level = [OrvAudio]::Volume(); mute = [OrvAudio]::Muted() })
        } catch {
          $inner = $_.Exception.InnerException
          if ($null -eq $inner) { $inner = $_.Exception }
          $msg = To-JsonB64 ([pscustomobject]@{ supported = $false; reason = [string]$inner.Message })
        }
      }
      'brightness' {
        try {
          $mon = @(Get-CimInstance -Namespace 'root/WMI' -ClassName 'WmiMonitorBrightness' -ErrorAction Stop)
          if ($mon.Count -eq 0) { throw 'Windows reports no brightness-adjustable display.' }
          $cur = [int]$mon[0].CurrentBrightness
          if ($null -ne $cmd.level) {
            $methods = @(Get-CimInstance -Namespace 'root/WMI' -ClassName 'WmiMonitorBrightnessMethods' -ErrorAction Stop)
            if ($methods.Count -eq 0) { throw 'This display cannot be dimmed through Windows.' }
            $level = [int]$cmd.level
            if ($level -lt 0) { $level = 0 }
            if ($level -gt 100) { $level = 100 }
            ($methods[0] | Invoke-CimMethod -MethodName WmiSetBrightness -Arguments @{ Timeout = [uint32]1; Brightness = [byte]$level }) | Out-Null
            $cur = $level
          }
          $msg = To-JsonB64 ([pscustomobject]@{ supported = $true; level = $cur })
        } catch {
          $inner = $_.Exception.InnerException
          if ($null -eq $inner) { $inner = $_.Exception }
          $msg = To-JsonB64 ([pscustomobject]@{ supported = $false; reason = [string]$inner.Message })
        }
      }
      'system' {
        $battery = $null
        try {
          $b = @(Get-CimInstance -ClassName 'Win32_Battery' -ErrorAction Stop)
          if ($b.Count -gt 0) {
            $status = 0
            if ($null -ne $b[0].BatteryStatus) { $status = [int]$b[0].BatteryStatus }
            $percent = $null
            if ($null -ne $b[0].EstimatedChargeRemaining) { $percent = [int]$b[0].EstimatedChargeRemaining }
            $battery = [ordered]@{ percent = $percent; status = $status; charging = ($status -eq 2); present = $true }
          }
        } catch { }
        $msg = To-JsonB64 ([pscustomobject]@{ battery = $battery })
      }
      'windows' {
        $wins = @([OrvWin]::List())
        $msg = To-JsonB64 $wins
      }
      'win' {
        $w = [OrvWin]::Find([long]$cmd.handle)
        if ($null -eq $w) { throw 'Window not found.' }
        $result = [OrvWin]::Act([long]$cmd.handle, [string]$cmd.op)
        $msg = To-JsonB64 ([pscustomobject]@{ ok = $true; hwnd = $w.hwnd; title = $w.title; state = $w.state; action = $cmd.op; result = $result })
      }
      'procs' {
        $limit = 80
        if ($cmd.limit) { $limit = [int]$cmd.limit }
        $name = ''
        if ($cmd.filter) { $name = [string]$cmd.filter }
        $procs = Get-Process
        if ($name -ne '') {
          $procs = $procs | Where-Object { $_.ProcessName -like ('*' + $name + '*') -or $_.MainWindowTitle -like ('*' + $name + '*') }
        }
        $list = @($procs | Sort-Object -Property WorkingSet64 -Descending | Select-Object -First $limit | ForEach-Object {
          $cpu = 0
          if ($null -ne $_.CPU) { $cpu = [math]::Round($_.CPU, 1) }
          $started = ''
          try { if ($_.StartTime) { $started = $_.StartTime.ToString('o') } } catch { }
          [pscustomobject]@{
            pid = $_.Id
            name = $_.ProcessName
            cpu = $cpu
            memMB = [math]::Round($_.WorkingSet64 / 1MB, 1)
            title = $_.MainWindowTitle
            started = $started
          }
        })
        $msg = To-JsonB64 $list
      }
      'kill' {
        $p = Get-Process -Id ([int]$cmd.pid) -ErrorAction Stop
        $bad = @('system', 'idle', 'csrss', 'wininit', 'winlogon', 'services', 'lsass', 'smss', 'svchost', 'dwm', 'fontdrvhost', 'registry', 'memory compression')
        if ($bad -contains $p.ProcessName.ToLower()) { throw ('Refusing to stop core Windows process ' + $p.ProcessName + '.') }
        if ($p.Id -le 4) { throw 'Refusing to stop a core system process.' }
        Stop-Process -Id $p.Id -Force
        $msg = To-JsonB64 ([pscustomobject]@{ ok = $true; pid = $p.Id; name = $p.ProcessName })
      }
      default { throw ('Unknown action: ' + $cmd.action) }
    }
    [Console]::Out.WriteLine('R:OK ' + $msg)
  } catch {
    $m = $_.Exception.Message -replace "\`r?\`n", ' '
    [Console]::Out.WriteLine('R:ERR ' + $m)
  }
  [Console]::Out.Flush()
}
`;

function ensureScript() {
  if (scriptPath && fs.existsSync(scriptPath)) return scriptPath;
  const tag = require('node:crypto').createHash('sha1').update(PS_SCRIPT).digest('hex').slice(0, 10);
  scriptPath = path.join(os.tmpdir(), `orvex-input-${tag}.ps1`);
  if (!fs.existsSync(scriptPath)) fs.writeFileSync(scriptPath, PS_SCRIPT, 'utf8');
  return scriptPath;
}

let helper = null;
let helperReady = null;
let pending = null;
let queue = Promise.resolve();
let stdoutBuf = '';

function startHelper() {
  if (helper && helperReady) return helperReady;
  helperReady = new Promise((resolve, reject) => {
    const proc = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', ensureScript()],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    helper = proc;
    stdoutBuf = '';
    let ready = false;
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      stdoutBuf += chunk;
      let idx;
      while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, idx).replace(/\r$/, '');
        stdoutBuf = stdoutBuf.slice(idx + 1);
        if (line === 'R:READY') {
          ready = true;
          resolve(proc);
          continue;
        }
        if (line.startsWith('R:') && pending) {
          const p = pending;
          pending = null;
          clearTimeout(p.timer);
          p.resolve(line.slice(2));
        }
      }
    });
    proc.stderr.on('data', () => {});
    proc.on('error', (err) => {
      if (!ready) reject(err);
    });
    proc.on('exit', () => {
      helper = null;
      helperReady = null;
      if (pending) {
        const p = pending;
        pending = null;
        clearTimeout(p.timer);
        p.resolve('ERR the input helper stopped');
      }
      if (!ready) reject(new Error('The keyboard/mouse helper could not start on this machine.'));
    });
  }).catch((err) => {
    helperReady = null;
    helper = null;
    throw err;
  });
  return helperReady;
}

function send(cmd, timeout = 20000) {
  const run = async () => {
    await startHelper();
    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (pending) {
          pending = null;
          try {
            helper.kill();
          } catch {
            /* already gone */
          }
        }
        resolve(`ERR input action timed out after ${timeout} ms`);
      }, timeout);
      pending = { timer, resolve };
      try {
        helper.stdin.write(JSON.stringify(cmd) + '\n');
      } catch (err) {
        clearTimeout(timer);
        pending = null;
        resolve(`ERR ${err && err.message ? err.message : err}`);
      }
    });
  };
  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return p;
}

async function input(cmd, timeout) {
  if (process.platform !== 'win32') return platform.input(cmd, timeout);
  const raw = await send(cmd, timeout);
  if (raw.startsWith('OK')) return { ok: true, output: raw.slice(2).trim() };
  return { ok: false, error: raw.replace(/^ERR\s*/, '') || 'Input action failed.' };
}

async function inputJson(cmd, timeout) {
  if (process.platform !== 'win32') return platform.inputJson(cmd, timeout);
  const r = await input(cmd, timeout);
  if (!r.ok) return r;
  const out = r.output || '';
  if (!out.startsWith('J:')) return { ok: false, error: `Unexpected helper reply: ${out.slice(0, 200)}` };
  try {
    return { ok: true, data: JSON.parse(Buffer.from(out.slice(2), 'base64').toString('utf8')) };
  } catch (err) {
    return { ok: false, error: `Could not read the helper reply: ${err && err.message ? err.message : String(err)}` };
  }
}

/** Older cached helpers serialise a one-item list as a bare object. */
const asArray = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);

function releaseButtons() {
  if (!helper || !helper.stdin.writable) return;
  try {
    for (const button of [0, 1, 2]) helper.stdin.write(`${JSON.stringify({ action: 'up', button })}\n`);
  } catch {
    /* helper already gone */
  }
}

function shutdown() {
  stopRecordingOnQuit();
  releaseButtons();
  if (uiaHost) {
    const proc = uiaHost;
    uiaHost = null;
    uiaHostReady = null;
    try {
      proc.stdin.end();
      proc.kill();
    } catch {
      /* already gone */
    }
  }
  if (!helper) return;
  const proc = helper;
  helper = null;
  helperReady = null;
  try {
    const finish = () => {
      try {
        proc.stdin.end();
        proc.kill();
      } catch {
        /* already gone */
      }
    };
    const timer = setTimeout(finish, 80);
    if (timer.unref) timer.unref();
  } catch {
    /* already gone */
  }
}

function stopRecordingOnQuit() {
  if (!recorder) return;
  const r = recorder;
  recorder = null;
  try {
    r.win.destroy();
  } catch {
    /* already gone */
  }
  try {
    if (r.stream) r.stream.end();
  } catch {
    /* already gone */
  }
}

/** Physical screen rects (screenshot pixels), used to reject wild coordinates. */
function displayRects(electron) {
  try {
    return electron.screen.getAllDisplays().map((d) => {
      const sf = d.scaleFactor || 1;
      const b = d.bounds;
      return {
        left: Math.round(b.x * sf),
        top: Math.round(b.y * sf),
        right: Math.round((b.x + b.width) * sf),
        bottom: Math.round((b.y + b.height) * sf),
      };
    });
  } catch {
    return [];
  }
}

function parsePoint(args, electron) {
  const x = Math.round(Number(args.x));
  const y = Math.round(Number(args.y));
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { error: 'x and y must be numbers (screen pixels).' };
  if (x < -32768 || x > 32767 || y < -32768 || y > 32767) return { error: `Coordinates ${x},${y} are outside any real screen.` };
  if (electron) {
    const rects = displayRects(electron);
    if (rects.length && !rects.some((r) => x >= r.left - 1 && x <= r.right + 1 && y >= r.top - 1 && y <= r.bottom + 1)) {
      const sizes = rects.map((r) => `${r.right - r.left}x${r.bottom - r.top}`).join(', ');
      return { error: `Point ${x},${y} is off-screen. Display sizes in pixels: ${sizes}. Take a fresh screen_capture and use its pixels.` };
    }
  }
  return { x, y };
}

const BUTTONS = { left: 0, right: 1, middle: 2 };

function displayOrigin(display) {
  const sf = display.scaleFactor || 1;
  return { x: Math.round(display.bounds.x * sf), y: Math.round(display.bounds.y * sf) };
}

async function captureDisplayFile(electron, display) {
  const sf = display.scaleFactor || 1;
  let sources;
  try {
    sources = await electron.desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: Math.round(display.bounds.width * sf), height: Math.round(display.bounds.height * sf) },
    });
  } catch (err) {
    return { error: `Screen capture failed: ${err && err.message ? err.message : String(err)}` };
  }
  const source = sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
  if (!source || !source.thumbnail || source.thumbnail.isEmpty()) {
    return { error: 'The screen capture came back empty — try again.' };
  }
  const dir = path.join(baseDir(), 'screenshots');
  await fsp.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `screen-${stamp}-${display.id}.png`);
  await fsp.writeFile(file, source.thumbnail.toPNG());
  const size = source.thumbnail.getSize();
  return { file, width: size.width, height: size.height };
}

async function pruneShots(dir) {
  try {
    const files = (await fsp.readdir(dir)).filter((f) => f.startsWith('screen-') && f.endsWith('.png')).sort();
    while (files.length > MAX_SHOTS) {
      const old = files.shift();
      fsp.rm(path.join(dir, old), { force: true }).catch(() => {});
    }
  } catch {
    /* cleanup is best-effort */
  }
}

function pickDisplay(electron, wanted) {
  const displays = electron.screen.getAllDisplays();
  if (!displays.length) return { error: 'No display was detected.' };
  if (wanted == null || wanted === '') {
    return { display: electron.screen.getPrimaryDisplay() || displays[0], displays };
  }
  const key = String(wanted).trim().toLowerCase();
  const named = key === 'primary' ? electron.screen.getPrimaryDisplay() : null;
  if (named) return { display: named, displays };
  const byId = displays.find((d) => String(d.id) === key);
  if (byId) return { display: byId, displays };
  if (/^\d+$/.test(key)) {
    const byIndex = displays[Number(key) - 1] || displays[Number(key)];
    if (byIndex) return { display: byIndex, displays };
  }
  return {
    error: `No display matches "${wanted}". Known displays: ${displays.map((d, i) => `#${i + 1} id ${d.id}`).join(', ')}.`,
  };
}

async function screenCapture(args = {}) {
  const electron = electronApi();
  if (!electron) return { ok: false, error: 'Screen capture runs inside the ORVEX desktop app only.' };
  const picked = pickDisplay(electron, args.display);
  if (picked.error) return { ok: false, error: picked.error };
  const { displays } = picked;

  if (args.all) {
    const shots = [];
    for (const display of displays) {
      const shot = await captureDisplayFile(electron, display);
      if (shot.error) return { ok: false, error: shot.error };
      const origin = displayOrigin(display);
      shots.push({ ...shot, display, origin });
    }
    const dir = path.join(baseDir(), 'screenshots');
    await pruneShots(dir);
    const lines = [
      `Captured ${shots.length} display${shots.length === 1 ? '' : 's'}:`,
      ...shots.map(
        (s) =>
          `  display id ${s.display.id}: ${s.width}x${s.height} px, origin ${s.origin.x},${s.origin.y} — ${s.file}`,
      ),
      'Click coordinates are virtual-screen pixels: add the display origin to the pixel you read in that image.',
    ];
    const cursor = electron.screen.getCursorScreenPoint();
    const under =
      shots.find((s) => cursor.x >= s.origin.x && cursor.x <= s.origin.x + s.width && cursor.y >= s.origin.y && cursor.y <= s.origin.y + s.height) ||
      shots[0];
    return {
      ok: true,
      output: lines.join('\n'),
      image: under.file,
      files: shots.map((s) => ({ file: s.file, width: s.width, height: s.height, display: s.display.id, origin: s.origin })),
      displays: displays.length,
    };
  }

  const target = picked.display;
  const shot = await captureDisplayFile(electron, target);
  if (shot.error) return { ok: false, error: shot.error };
  const origin = displayOrigin(target);
  let file = shot.file;
  let width = shot.width;
  let height = shot.height;
  let offset = { x: 0, y: 0 };

  if (args.region && typeof args.region === 'object') {
    const r = args.region;
    const x = Math.max(0, Math.round(Number(r.x) || 0));
    const y = Math.max(0, Math.round(Number(r.y) || 0));
    const w = Math.min(width - x, Math.round(Number(r.width) || 0));
    const h = Math.min(height - y, Math.round(Number(r.height) || 0));
    if (w <= 0 || h <= 0) {
      return { ok: false, error: `Region ${JSON.stringify(r)} is outside the ${width}x${height} display image.` };
    }
    try {
      const image = electron.nativeImage.createFromPath(file);
      const cropped = image.crop({ x, y, width: w, height: h });
      const cropFile = file.replace(/\.png$/, `-r${x}-${y}-${w}x${h}.png`);
      await fsp.writeFile(cropFile, cropped.toPNG());
      file = cropFile;
      width = w;
      height = h;
      offset = { x, y };
    } catch (err) {
      return { ok: false, error: `Could not crop the screenshot: ${err && err.message ? err.message : String(err)}` };
    }
  }

  await pruneShots(path.join(baseDir(), 'screenshots'));
  const lines = [
    `Screenshot saved: ${file}`,
    `Image is ${width}x${height} screen pixels — use exactly these coordinates with mouse_click.`,
  ];
  if (offset.x || offset.y || origin.x || origin.y) {
    lines.push(
      `This is display id ${target.id}; its origin in the virtual screen is ${origin.x},${origin.y}.` +
        (offset.x || offset.y ? ` The crop starts at ${offset.x},${offset.y} inside that display.` : '') +
        ` For mouse_click add ${origin.x + offset.x},${origin.y + offset.y} to the pixel you read here.`,
    );
  }
  if (displays.length > 1) {
    lines.push(
      `Displays: ${displays
        .map((d, i) => `#${i + 1} id ${d.id} ${Math.round(d.bounds.width * (d.scaleFactor || 1))}x${Math.round(d.bounds.height * (d.scaleFactor || 1))}${d.id === target.id ? ' (captured)' : ''}`)
        .join(', ')}`,
    );
  }

  return {
    ok: true,
    output: lines.join('\n'),
    image: file,
    file,
    width,
    height,
    display: target.id,
    origin,
    offset,
  };
}

async function screenInfo() {
  const electron = electronApi();
  if (!electron) return { ok: false, error: 'Screen info runs inside the ORVEX desktop app only.' };
  const displays = electron.screen.getAllDisplays();
  if (!displays.length) return { ok: false, error: 'No display was detected.' };
  const primary = electron.screen.getPrimaryDisplay();
  const cursor = electron.screen.getCursorScreenPoint();
  const rects = displays.map((d) => {
    const o = displayOrigin(d);
    return { ...o, w: Math.round(d.bounds.width * (d.scaleFactor || 1)), h: Math.round(d.bounds.height * (d.scaleFactor || 1)) };
  });
  const left = Math.min(...rects.map((r) => r.x));
  const top = Math.min(...rects.map((r) => r.y));
  const right = Math.max(...rects.map((r) => r.x + r.w));
  const bottom = Math.max(...rects.map((r) => r.y + r.h));
  const primaryIndex = Math.max(0, displays.findIndex((d) => d.id === primary.id));
  const pr = rects[primaryIndex];
  const lines = [
    `Primary: id ${primary.id} — ${pr.w}x${pr.h} px at ${pr.x},${pr.y} (scale ${Math.round((primary.scaleFactor || 1) * 100)}%)`,
    ...displays.map((d, i) => {
      const r = rects[i];
      return `Display #${i + 1}: id ${d.id} — ${r.w}x${r.h} px at ${r.x},${r.y} (scale ${Math.round((d.scaleFactor || 1) * 100)}%)${d.id === primary.id ? ' primary' : ''}`;
    }),
    `Virtual desktop: ${left},${top} — ${right - left}x${bottom - top}`,
    `Cursor now: ${cursor.x},${cursor.y}`,
    'screen_capture uses virtual-screen pixel coordinates when you add each display origin.',
  ];
  return {
    ok: true,
    output: lines.join('\n'),
    bounds: { x: left, y: top, w: right - left, h: bottom - top },
    displays: rects.map((r, i) => ({ id: displays[i].id, ...r, primary: i === primaryIndex })),
    cursor,
  };
}

async function mouseMove(args = {}) {
  const p = parsePoint(args, electronApi());
  if (p.error) return { ok: false, error: p.error };
  return input({ action: 'move', x: p.x, y: p.y }, 15000);
}

async function mouseClick(args = {}) {
  const p = parsePoint(args, electronApi());
  if (p.error) return { ok: false, error: p.error };
  const button = BUTTONS[String(args.button || 'left').toLowerCase()];
  if (button === undefined) return { ok: false, error: 'button must be left, right or middle.' };
  const count = Math.min(Math.max(Math.round(Number(args.count) || 1), 1), 3);
  return input({ action: 'click', x: p.x, y: p.y, button, count }, 15000);
}

async function keyType(args = {}) {
  const text = String(args.text ?? '');
  if (!text) return { ok: false, error: 'Nothing to type.' };
  if (text.length > MAX_TEXT_CHARS) return { ok: false, error: `Text is too long (${text.length} chars, ${MAX_TEXT_CHARS} max). Split it up.` };
  if (process.platform !== 'win32') return platform.typeText(text);
  const file = path.join(os.tmpdir(), `orvex-type-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
  await fsp.writeFile(file, text, 'utf8');
  try {
    const r = await input({ action: 'type', file }, 60000);
    if (!r.ok) return r;
    return { ok: true, output: `${r.output} into the focused window. Screenshot to check the result.` };
  } finally {
    fsp.rm(file, { force: true }).catch(() => {});
  }
}

const VK_NAMES = {
  ENTER: 0x0d,
  RETURN: 0x0d,
  TAB: 0x09,
  ESC: 0x1b,
  ESCAPE: 0x1b,
  SPACE: 0x20,
  BACKSPACE: 0x08,
  BKSP: 0x08,
  DELETE: 0x2e,
  DEL: 0x2e,
  INSERT: 0x2d,
  INS: 0x2d,
  HOME: 0x24,
  END: 0x23,
  PAGEUP: 0x21,
  PAGEDOWN: 0x22,
  UP: 0x26,
  DOWN: 0x28,
  LEFT: 0x25,
  RIGHT: 0x27,
  CTRL: 0x11,
  CONTROL: 0x11,
  SHIFT: 0x10,
  ALT: 0x12,
  WIN: 0x5b,
  META: 0x5b,
  CAPS: 0x14,
  PRINTSCREEN: 0x2c,
  PRTSC: 0x2c,
  MEDIAPLAY: 0xb3,
  PLAYPAUSE: 0xb3,
  MEDIAPLAYPAUSE: 0xb3,
  MEDIANEXT: 0xb0,
  NEXTTRACK: 0xb0,
  MEDIAPREV: 0xb1,
  PREVTRACK: 0xb1,
  MEDIASTOP: 0xb2,
  STOPMEDIA: 0xb2,
  VOLUMEUP: 0xaf,
  VOLUMEDOWN: 0xae,
  VOLUMEMUTE: 0xad,
  MUTE: 0xad,
  BROWSERBACK: 0xa6,
  BROWSERFORWARD: 0xa7,
  BROWSERREFRESH: 0xa8,
  BROWSERSTOP: 0xa9,
  BROWSERHOME: 0xac,
  LAUNCHMEDIA: 0xb5,
  LAUNCHMAIL: 0xb4,
  SLEEP: 0x5f,
};

function vkFor(part) {
  const key = part.trim().toUpperCase();
  if (!key) return null;
  if (VK_NAMES[key] !== undefined) return VK_NAMES[key];
  if (/^[A-Z]$/.test(key)) return key.charCodeAt(0);
  if (/^[0-9]$/.test(key)) return key.charCodeAt(0);
  const fn = /^F([1-9]|1[0-9]|2[0-4])$/.exec(key);
  if (fn) return 0x70 + Number(fn[1]) - 1;
  return null;
}

async function keyPress(args = {}) {
  const raw = String(args.keys || args.key || '').trim();
  if (!raw) return { ok: false, error: 'Give keys like "CTRL+S" or "ENTER".' };
  const parts = raw.split('+').map((p) => p.trim()).filter(Boolean);
  if (!parts.length || parts.length > 4) return { ok: false, error: `Could not read "${raw}". Use e.g. CTRL+S, ALT+TAB, ENTER.` };
  if (process.platform !== 'win32') return platform.pressKeys(parts);
  const vks = [];
  for (const part of parts) {
    const vk = vkFor(part);
    if (vk === null) return { ok: false, error: `Unknown key "${part}".` };
    vks.push(vk);
  }
  const r = await input({ action: 'key', vks }, 15000);
  if (!r.ok) return r;
  return { ok: true, output: `${r.output} on the focused window.` };
}

async function mouseScroll(args = {}) {
  const electron = electronApi();
  let point = null;
  if (args.x != null || args.y != null) {
    const p = parsePoint(args, electron);
    if (p.error) return { ok: false, error: p.error };
    point = p;
  }
  const clicks = Math.max(-40, Math.min(40, Math.round(Number(args.amount ?? args.clicks ?? 3))));
  if (!clicks) return { ok: false, error: 'amount must be a non-zero number of wheel clicks.' };
  const cmd = { action: 'scroll', delta: clicks * 120 };
  if (point) {
    cmd.x = point.x;
    cmd.y = point.y;
  }
  const r = await input(cmd, 15000);
  if (!r.ok) return r;
  return { ok: true, output: `Scrolled ${clicks > 0 ? 'up' : 'down'} ${Math.abs(clicks)} click(s)${point ? ` at ${point.x},${point.y}` : ''}.` };
}

async function mouseDrag(args = {}) {
  const electron = electronApi();
  const from = parsePoint({ x: args.fromX ?? args.x1, y: args.fromY ?? args.y1 }, electron);
  if (from.error) return { ok: false, error: `Drag start: ${from.error}` };
  const to = parsePoint({ x: args.toX ?? args.x2, y: args.toY ?? args.y2 }, electron);
  if (to.error) return { ok: false, error: `Drag end: ${to.error}` };
  const button = BUTTONS[String(args.button || 'left').toLowerCase()];
  if (button === undefined) return { ok: false, error: 'button must be left, right or middle.' };
  const ms = Math.max(100, Math.min(5000, Math.round(Number(args.durationMs) || 500)));
  const steps = Math.max(8, Math.min(120, Math.round(ms / 16)));
  const r = await input({ action: 'drag', x1: from.x, y1: from.y, x2: to.x, y2: to.y, button, steps, ms }, ms + 20000);
  if (!r.ok) return r;
  return { ok: true, output: `Dragged from ${from.x},${from.y} to ${to.x},${to.y} in ${ms} ms.` };
}

async function mouseDown(args = {}) {
  const button = BUTTONS[String(args.button || 'left').toLowerCase()];
  if (button === undefined) return { ok: false, error: 'button must be left, right or middle.' };
  const r = await input({ action: 'down', button }, 15000);
  if (!r.ok) return r;
  return { ok: true, output: `${String(args.button || 'left')} button held down. Call mouse_up (or mouse_drag) to release it.` };
}

async function mouseUp(args = {}) {
  const button = BUTTONS[String(args.button || 'left').toLowerCase()];
  if (button === undefined) return { ok: false, error: 'button must be left, right or middle.' };
  const r = await input({ action: 'up', button }, 15000);
  if (!r.ok) return r;
  return { ok: true, output: `${String(args.button || 'left')} button released.` };
}

async function waitFor(args = {}) {
  const ms = Math.round(Number(args.ms ?? args.seconds * 1000));
  if (!Number.isFinite(ms) || ms < 0) return { ok: false, error: 'Give ms (milliseconds) or seconds.' };
  const capped = Math.min(ms, 60000);
  await new Promise((r) => setTimeout(r, capped));
  return { ok: true, output: `Waited ${capped} ms.` };
}

async function windowList(args = {}) {
  const r = await inputJson({ action: 'windows' }, 20000);
  if (!r.ok) return r;
  const all = asArray(r.data);
  const needle = String(args.filter || '').toLowerCase().trim();
  let wins = all.filter((w) => w && w.title);
  if (needle) {
    wins = wins.filter((w) => String(w.title).toLowerCase().includes(needle) || String(w.cls).toLowerCase().includes(needle));
  }
  const limit = Math.min(Math.max(Math.round(Number(args.limit) || 60), 1), 300);
  wins = wins.filter((w) => !args.visibleOnly || w.state !== 'minimized').slice(0, limit);
  if (!wins.length) {
    return { ok: true, output: needle ? `No open window matches "${args.filter}".` : 'No visible windows were found.', windows: [] };
  }
  const idLabel = process.platform === 'win32' ? 'hwnd' : 'window id';
  const lines = wins.map(
    (w) =>
      `${w.foreground ? '▶ ' : '  '}${idLabel} ${w.hwnd} — pid ${w.pid} [${w.state}] ${w.w}x${w.h} at ${w.x},${w.y} — "${w.title}" (${w.cls})`,
  );
  return {
    ok: true,
    output: `${wins.length} window${wins.length === 1 ? '' : 's'}${needle ? ` matching "${args.filter}"` : ''}:\n${lines.join('\n')}`,
    windows: wins.map((w) => ({ ...w })),
  };
}

async function resolveWindow(ref) {
  const raw = ref == null ? '' : String(ref).trim();
  if (!raw) return { error: 'Give a window title, hwnd or pid.' };
  const r = await inputJson({ action: 'windows' }, 20000);
  if (!r.ok) return { error: r.error };
  const wins = asArray(r.data).filter((w) => w && w.title);
  const lower = raw.toLowerCase();
  let hit = null;
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    hit = wins.find((w) => w.hwnd === n) || wins.find((w) => w.pid === n && w.foreground) || wins.find((w) => w.pid === n) || null;
  }
  if (!hit) hit = wins.find((w) => String(w.title).toLowerCase() === lower) || null;
  if (!hit) hit = wins.find((w) => String(w.title).toLowerCase().includes(lower)) || null;
  if (!hit) return { error: `No window matches "${raw}". Run window_list to see open windows.` };
  return { window: hit, windows: wins };
}

async function windowAction(args = {}) {
  const op = String(args.action || '').toLowerCase();
  const allowed = ['focus', 'minimize', 'maximize', 'restore', 'close'];
  if (!allowed.includes(op)) return { ok: false, error: `action must be one of ${allowed.join(', ')}.` };
  const resolved = await resolveWindow(args.handle ?? args.title ?? args.window);
  if (resolved.error) return { ok: false, error: resolved.error };
  const win = resolved.window;
  const r = await inputJson({ action: 'win', handle: win.hwnd, op }, 20000);
  if (!r.ok) return r;
  const data = r.data || {};
  return { ok: true, output: `Window "${win.title}" (${process.platform === 'win32' ? 'hwnd' : 'id'} ${win.hwnd}, pid ${win.pid}): ${data.result || op}${op === 'close' ? ' — the app may ask to save first.' : ''}.` };
}

async function processList(args = {}) {
  const limit = Math.min(Math.max(Math.round(Number(args.limit) || 40), 1), 200);
  const needle = String(args.filter || '').toLowerCase().trim();
  const r = await inputJson({ action: 'procs', limit: 300, filter: needle }, 25000);
  if (!r.ok) return r;
  let list = asArray(r.data);
  if (needle) {
    list = list.filter(
      (p) => String(p.name).toLowerCase().includes(needle) || String(p.title || '').toLowerCase().includes(needle),
    );
  }
  const sort = String(args.sort || 'memory').toLowerCase();
  list.sort((a, b) => {
    if (sort === 'cpu') return (b.cpu || 0) - (a.cpu || 0);
    if (sort === 'name') return String(a.name).localeCompare(String(b.name));
    if (sort === 'pid') return (a.pid || 0) - (b.pid || 0);
    return (b.memMB || 0) - (a.memMB || 0);
  });
  list = list.slice(0, limit);
  if (!list.length) return { ok: true, output: needle ? `No process matches "${args.filter}".` : 'No processes were returned.', processes: [] };
  const lines = list.map(
    (p) => `${p.name} (pid ${p.pid}) — ${p.memMB} MB, CPU ${p.cpu}s${p.title ? ` — "${p.title}"` : ''}`,
  );
  return {
    ok: true,
    output: `${list.length} process${list.length === 1 ? '' : 'es'} sorted by ${sort}:\n${lines.join('\n')}`,
    processes: list.map((p) => ({ ...p })),
    sort,
  };
}

async function processKill(args = {}) {
  let pid = Math.round(Number(args.pid));
  if (!Number.isFinite(pid) || pid <= 0) {
    const raw = String(args.name || args.process || '').trim();
    if (!raw) return { ok: false, error: 'Give a pid or a process name from process_list.' };
    const listed = await inputJson({ action: 'procs', limit: 200, filter: raw }, 25000);
    if (!listed.ok) return listed;
    const list = asArray(listed.data);
    const matches = list.filter((p) => String(p.name).toLowerCase() === raw.toLowerCase() || String(p.title || '').toLowerCase() === raw.toLowerCase());
    if (!matches.length) return { ok: false, error: `No running process named "${raw}". Run process_list first.` };
    if (matches.length > 1) {
      return {
        ok: false,
        error: `"${raw}" matches ${matches.length} processes: ${matches.map((p) => `pid ${p.pid}`).join(', ')}. Pass a pid.`,
      };
    }
    pid = matches[0].pid;
  }
  if (pid <= 4) return { ok: false, error: 'Refusing to stop a core system process.' };
  const listed = await inputJson({ action: 'procs', limit: 400 }, 25000);
  const entry = listed.ok ? asArray(listed.data).find((p) => p.pid === pid) : null;
  if (entry && CORE_PROCESSES.has(String(entry.name).toLowerCase())) {
    return { ok: false, error: `Refusing to stop ${entry.name} — it is a core Windows process.` };
  }
  if (process.pid === pid) return { ok: false, error: 'Refusing to stop the ORVEX process itself.' };
  const r = await inputJson({ action: 'kill', pid }, 20000);
  if (!r.ok) return r;
  return { ok: true, output: `Stopped ${r.data?.name || 'process'} (pid ${pid}).` };
}

function clipboardApi() {
  const electron = electronApi();
  if (!electron || !electron.clipboard) return null;
  return electron.clipboard;
}

async function clipboardRead() {
  const clip = clipboardApi();
  if (!clip) return { ok: false, error: 'Clipboard access runs inside the ORVEX desktop app only.' };
  const formats = clip.availableFormats();
  const text = clip.readText();
  if (text && text.trim()) {
    return {
      ok: true,
      output: `Clipboard text (${text.length} chars, formats: ${formats.join(', ') || 'text'}):\n${text.slice(0, 12000)}${text.length > 12000 ? '\n…[truncated]' : ''}`,
      kind: 'text',
      text,
      formats,
      file: null,
    };
  }
  const image = clip.readImage();
  if (image && !image.isEmpty()) {
    const dir = path.join(baseDir(), 'screenshots');
    await fsp.mkdir(dir, { recursive: true });
    const file = path.join(dir, `clipboard-${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
    await fsp.writeFile(file, image.toPNG());
    return {
      ok: true,
      output: `Clipboard holds an image (${image.getSize().width}x${image.getSize().height}); saved to ${file}.`,
      image: file,
      file,
      kind: 'image',
      text: '',
      formats,
      width: image.getSize().width,
      height: image.getSize().height,
    };
  }
  return {
    ok: true,
    output: `Clipboard is empty of text and images. Formats present: ${formats.join(', ') || 'none'}.`,
    kind: 'empty',
    text: '',
    formats,
    file: null,
  };
}

async function clipboardWrite(args = {}) {
  const clip = clipboardApi();
  if (!clip) return { ok: false, error: 'Clipboard access runs inside the ORVEX desktop app only.' };
  if (args.imagePath) {
    const target = path.resolve(String(args.imagePath));
    const blocked = checkPath(target, 'read');
    if (blocked) return { ok: false, error: blocked };
    if (!fs.existsSync(target)) return { ok: false, error: `Image not found: ${target}` };
    const image = electronApi().nativeImage.createFromPath(target);
    if (!image || image.isEmpty()) return { ok: false, error: 'That file is not a readable image.' };
    clip.writeImage(image);
    return { ok: true, output: `Copied the image (${image.getSize().width}x${image.getSize().height}) to the clipboard.` };
  }
  const text = String(args.text ?? '');
  if (!text) return { ok: false, error: 'Nothing to copy — give text or imagePath.' };
  if (text.length > 1000000) return { ok: false, error: 'Text is too large for the clipboard (1M chars max).' };
  clip.writeText(text);
  return { ok: true, output: `Copied ${text.length} chars to the clipboard.` };
}

function formatUptime(sec) {
  const total = Math.max(0, Math.round(Number(sec) || 0));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const mins = Math.floor((total % 3600) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function localAddresses() {
  const out = [];
  try {
    for (const [name, rows] of Object.entries(os.networkInterfaces())) {
      for (const row of rows || []) {
        if (!row || (row.family !== 'IPv4' && row.family !== 4) || row.internal) continue;
        out.push({ name, address: row.address });
      }
    }
  } catch {
    /* adapters can disappear mid-read */
  }
  return out;
}

async function systemStatus() {
  const cpus = os.cpus();
  const total = os.totalmem();
  const free = os.freemem();
  const electron = electronApi();
  let displayCount = 0;
  try {
    if (electron) displayCount = electron.screen.getAllDisplays().length;
  } catch {
    /* no display server */
  }
  const status = {
    hostname: os.hostname(),
    user: (() => {
      try {
        return os.userInfo().username;
      } catch {
        return '';
      }
    })(),
    platform: process.platform,
    arch: process.arch,
    release: os.release(),
    uptimeSec: Math.round(os.uptime()),
    cpu: cpus.length ? String(cpus[0].model || '').trim() : '',
    cores: cpus.length,
    memory: { total, free, used: total - free },
    load: os.loadavg(),
    node: process.versions.node,
    electron: process.versions.electron || null,
    displays: displayCount,
    addresses: localAddresses(),
    battery: null,
    volume: null,
    muted: false,
    brightness: null,
  };

  if (process.platform === 'win32') {
    const [sys, vol, bright] = await Promise.all([
      inputJson({ action: 'system' }, 30000),
      inputJson({ action: 'volume' }, 30000),
      inputJson({ action: 'brightness' }, 40000),
    ]);
    if (sys.ok && sys.data) status.battery = sys.data.battery || null;
    if (vol.ok && vol.data && vol.data.supported) {
      status.volume = vol.data.level;
      status.muted = !!vol.data.mute;
    }
    if (bright.ok && bright.data && bright.data.supported) status.brightness = bright.data.level;
  }

  const bits = [
    `${status.hostname} — ${status.platform} ${status.release} (${status.arch})`,
    `${status.cpu || 'CPU'} • ${status.cores} threads`,
    `RAM ${prettySize(status.memory.used)} used of ${prettySize(status.memory.total)}`,
    `Up ${formatUptime(status.uptimeSec)}`,
  ];
  if (status.battery && status.battery.present) {
    bits.push(`Battery ${status.battery.percent == null ? '?' : `${status.battery.percent}%`}${status.battery.charging ? ' (charging)' : ' (on battery)'}`);
  } else {
    bits.push('No battery — desktop power');
  }
  if (status.volume != null) bits.push(`Volume ${status.volume}%${status.muted ? ' (muted)' : ''}`);
  if (status.brightness != null) bits.push(`Brightness ${status.brightness}%`);
  return { ok: true, output: bits.join('\n'), ...status };
}

/* ------------------------------------------------------------ live metrics */

function cpuTimes() {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    const t = cpu.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

/** Blocking read kept tiny: Electron's async CPU sampling needs a short delta. */
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function cpuPercent() {
  const first = cpuTimes();
  if (!lastCpuTimes || first.total <= lastCpuTimes.total) {
    lastCpuTimes = first;
    await wait(200);
  }
  const current = cpuTimes();
  const totalDelta = current.total - lastCpuTimes.total;
  const idleDelta = current.idle - lastCpuTimes.idle;
  lastCpuTimes = current;
  if (totalDelta <= 0) return null;
  return Math.max(0, Math.min(100, ((totalDelta - idleDelta) / totalDelta) * 100));
}

async function diskUsage() {
  const mount = process.platform === 'win32' ? `${process.env.SystemDrive || 'C:'}\\` : '/';
  try {
    const stats = await fsp.statfs(mount);
    const total = Number(stats.blocks) * Number(stats.bsize);
    const free = Number(stats.bavail) * Number(stats.bsize);
    if (!total) return null;
    const used = total - free;
    return { mount, total, free, used, percent: Math.round((used / total) * 100) };
  } catch {
    return null;
  }
}

/**
 * GPU utilisation is only readable when the vendor exposes it. nvidia-smi is
 * probed in the background and cached; anything else reports unavailable —
 * no invented number.
 */
function gpuInfo() {
  const now = Date.now();
  if (gpuCache.info && now - gpuCache.at < 15000) return gpuCache.info;
  if (!gpuCache.probing) {
    gpuCache.probing = true;
    execFile(
      'nvidia-smi',
      ['--query-gpu=name,utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'],
      { timeout: 2500, windowsHide: true },
      (err, stdout) => {
        gpuCache.probing = false;
        gpuCache.at = Date.now();
        const line = String(stdout || '').trim().split(/\r?\n/).filter(Boolean)[0];
        if (err || !line) {
          gpuCache.info = { available: false, reason: 'This machine does not expose GPU utilisation (no nvidia-smi).' };
          return;
        }
        const [name, percent, usedMb, totalMb] = line.split(',').map((v) => v.trim());
        const value = Number(percent);
        if (!Number.isFinite(value)) {
          gpuCache.info = { available: false, reason: 'The GPU driver did not report utilisation.' };
          return;
        }
        gpuCache.info = {
          available: true,
          name,
          percent: value,
          memoryUsed: Number(usedMb) || null,
          memoryTotal: Number(totalMb) || null,
        };
      },
    );
  }
  return gpuCache.info || { available: false, pending: true, reason: 'GPU utilisation is being sampled.' };
}

function round1(n) {
  return Math.round(Number(n) * 10) / 10;
}

/**
 * Live hardware metrics for the dashboard. CPU is a real delta between two
 * os.cpus() samples; RAM and disk come from the OS; GPU is honest about being
 * unavailable when the driver exposes nothing.
 */
async function systemMetrics() {
  const [cpu, disk] = await Promise.all([cpuPercent(), diskUsage()]);
  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;
  const cpus = os.cpus();
  return {
    ok: true,
    at: Date.now(),
    cpuPercent: cpu == null ? null : round1(cpu),
    cores: cpus.length,
    cpuModel: cpus.length ? String(cpus[0].model || '').trim() : '',
    memory: {
      total,
      free,
      used,
      percent: total ? round1((used / total) * 100) : null,
    },
    disk: disk ? { ...disk, percent: disk.percent } : null,
    gpu: gpuInfo(),
    uptimeSec: Math.round(os.uptime()),
    load: os.loadavg().map(round1),
  };
}

async function systemVolume(args = {}) {
  const cmd = { action: 'volume' };
  if (args.level != null && args.level !== '') {
    const level = Math.round(Number(args.level));
    if (!Number.isFinite(level) || level < 0 || level > 100) return { ok: false, error: 'level must be a number from 0 to 100.' };
    cmd.level = level;
  }
  if (args.mute != null) {
    if (typeof args.mute === 'boolean') cmd.mute = args.mute;
    else if (String(args.mute).toLowerCase() === 'true' || String(args.mute) === '1') cmd.mute = true;
    else cmd.mute = false;
  }
  const r = await inputJson(cmd, 40000);
  if (!r.ok) return r;
  const d = r.data || {};
  if (d.supported === false) {
    return {
      ok: true,
      supported: false,
      volume: null,
      muted: false,
      output: `Volume control is not available: ${d.reason || 'no active audio output device'}.`,
    };
  }
  return {
    ok: true,
    supported: true,
    volume: Number(d.level),
    muted: !!d.mute,
    output: `Volume ${d.level}%${d.mute ? ' (muted)' : ''}.`,
  };
}

async function systemBrightness(args = {}) {
  const cmd = { action: 'brightness' };
  if (args.level != null && args.level !== '') {
    const level = Math.round(Number(args.level));
    if (!Number.isFinite(level) || level < 0 || level > 100) return { ok: false, error: 'level must be a number from 0 to 100.' };
    cmd.level = level;
  }
  const r = await inputJson(cmd, 45000);
  if (!r.ok) return r;
  const d = r.data || {};
  if (d.supported === false) {
    return {
      ok: true,
      supported: false,
      level: null,
      output: `Brightness control is not available on this display: ${d.reason || 'the display cannot be dimmed'}.`,
    };
  }
  return { ok: true, supported: true, level: Number(d.level), output: `Brightness ${d.level}%.` };
}

const UIA_SCRIPT = `param(
  [Parameter(Mandatory=$true)][string]$Mode,
  [long]$Handle = 0,
  [int]$Depth = 4,
  [int]$Max = 300,
  [string]$Path = '',
  [string]$Action = '',
  [string]$Value = '',
  [switch]$Force,
  [string]$Match = '',
  [string]$Type = '',
  [string]$Want = 'exists',
  [int]$Timeout = 5000,
  [int]$Interval = 250,
  [switch]$NoPixels
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class UiaClick {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  public static void Click(int x, int y) {
    SetCursorPos(x, y);
    System.Threading.Thread.Sleep(60);
    mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero);
    System.Threading.Thread.Sleep(30);
    mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);
  }
}
'@

function Out-Json($obj) {
  $json = $obj | ConvertTo-Json -Compress -Depth 60
  if ($null -eq $json) { $json = 'null' }
  return 'J:' + [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($json))
}

function To-Int($v) {
  $d = [double]$v
  if ([double]::IsNaN($d)) { return 0 }
  if ($d -gt 2147483647) { return 2147483647 }
  if ($d -lt -2147483648) { return -2147483648 }
  return [int]$d
}

function Get-Root($handle) {
  if ($handle -gt 0) { return [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$handle) }
  return [System.Windows.Automation.AutomationElement]::RootElement
}

$root = Get-Root $Handle
if ($null -eq $root) { throw 'That window is not available to UI Automation.' }
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker

function Has($state, $key) { return ($null -ne $state) -and $state.Contains($key) }

function Resolve-Element($base, $pathStr) {
  $el = $base
  if ($pathStr -eq '') { return $el }
  $parts = @($pathStr.Split('/') | Where-Object { $_ -ne '' })
  if ($parts.Count -gt 0 -and $parts[0] -eq '0') { $parts = @($parts | Select-Object -Skip 1) }
  foreach ($part in $parts) {
    $child = $walker.GetFirstChild($el)
    $n = 0
    $found = $null
    while ($null -ne $child) {
      if ($n -eq [int]$part) { $found = $child; break }
      $child = $walker.GetNextSibling($child)
      $n = $n + 1
    }
    if ($null -eq $found) { throw ('Path element ' + $part + ' was not found. The window changed - re-read ui_tree.') }
    $el = $found
  }
  return $el
}

function Get-RectInfo($el) {
  $r = $el.Current.BoundingRectangle
  return [ordered]@{ x = (To-Int $r.X); y = (To-Int $r.Y); w = (To-Int $r.Width); h = (To-Int $r.Height) }
}

function Get-State($element) {
  $c = $element.Current
  $state = [ordered]@{
    name = [string]$c.Name
    type = $c.ControlType.ProgrammaticName.Split('.')[-1]
    enabled = [bool]$c.IsEnabled
    offscreen = [bool]$c.IsOffscreen
  }
  try {
    $p = $element.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
    $state.toggle = [string]$p.Current.ToggleState
  } catch { }
  try {
    $p = $element.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
    $state.expanded = [string]$p.Current.ExpandCollapseState
  } catch { }
  try {
    $p = $element.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
    $state.selected = [bool]$p.Current.IsSelected
  } catch { }
  try {
    $p = $element.GetCurrentPattern([System.Windows.Automation.RangeValuePattern]::Pattern)
    $state.range = [double]$p.Current.Value
  } catch { }
  # Password boxes must never put their contents back into the transcript.
  if (-not $c.IsPassword) {
    try {
      $p = $element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
      $state.value = [string]$p.Current.Value
    } catch { }
  }
  return $state
}

function Test-Verified($name, $before, $after, $wanted) {
  if ($null -eq $after) { return $false }
  if ($name -eq 'set_value') {
    if ((Has $after 'value')) { return ([string]$after.value -eq [string]$wanted) }
  } elseif ($name -eq 'toggle') {
    if ((Has $before 'toggle') -and (Has $after 'toggle')) { return ($before.toggle -ne $after.toggle) }
  } elseif ($name -eq 'expand') {
    if ((Has $after 'expanded')) { return ($after.expanded -eq 'Expanded') }
  } elseif ($name -eq 'collapse') {
    if ((Has $after 'expanded')) { return ($after.expanded -eq 'Collapsed') }
  } elseif ($name -eq 'select') {
    if ((Has $before 'selected') -and (Has $after 'selected')) { return ($after.selected -eq $true) }
  }
  return $null
}

function As-Json($state) {
  if ($null -eq $state) { return $null }
  return ($state | ConvertTo-Json -Compress -Depth 4)
}

# Pre-flight: refuse an element that cannot receive the action right now.
function Get-ActionProblem($el, $action) {
  $c = $el.Current
  if (-not $c.IsEnabled) { return 'The element is disabled right now, so it would ignore the action. Enable it first or use a different control.' }
  $r = $c.BoundingRectangle
  $bad = [double]::IsNaN($r.Width) -or [double]::IsInfinity($r.Width) -or [double]::IsNaN($r.Height) -or [double]::IsInfinity($r.Height) -or $r.Width -lt 1 -or $r.Height -lt 1
  if ($bad -and ($action -eq 'click' -or $action -eq 'focus')) { return 'The element has no usable on-screen area.' }
  if ($c.IsOffscreen -and ($action -eq 'click' -or $action -eq 'focus')) { return 'The element is off-screen, so a real click or focus cannot reach it. Scroll it into view first, then retry.' }
  return $null
}

# An element that is still animating produces stale rects; wait for two equal reads.
function Wait-Stable($el) {
  $prev = ''
  foreach ($delay in 20, 40, 60, 80) {
    $r = $el.Current.BoundingRectangle
    $sig = ((To-Int $r.X), (To-Int $r.Y), (To-Int $r.Width), (To-Int $r.Height), [bool]$el.Current.IsEnabled) -join ','
    if ($prev -ne '' -and $sig -eq $prev) { return $true }
    $prev = $sig
    Start-Sleep -Milliseconds $delay
  }
  return $false
}

function Do-Action($el, $action, $value) {
  switch ($action) {
    'invoke' {
      $p = $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
      $p.Invoke()
      return 'invoked'
    }
    'toggle' {
      $p = $el.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
      $p.Toggle()
      return 'toggled'
    }
    'select' {
      $p = $el.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
      $p.Select()
      return 'selected'
    }
    'expand' {
      $p = $el.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
      $p.Expand()
      return 'expanded'
    }
    'collapse' {
      $p = $el.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
      $p.Collapse()
      return 'collapsed'
    }
    'focus' {
      $el.SetFocus()
      return 'focused'
    }
    'set_value' {
      $p = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
      $p.SetValue($value)
      return 'value set'
    }
    'scroll' {
      $p = $el.GetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern)
      $dir = $value.ToLower()
      if ($dir -eq 'down') { $p.Scroll([System.Windows.Automation.ScrollAmount]::NoAmount, [System.Windows.Automation.ScrollAmount]::LargeIncrement) }
      elseif ($dir -eq 'up') { $p.Scroll([System.Windows.Automation.ScrollAmount]::NoAmount, [System.Windows.Automation.ScrollAmount]::LargeDecrement) }
      elseif ($dir -eq 'right') { $p.Scroll([System.Windows.Automation.ScrollAmount]::LargeIncrement, [System.Windows.Automation.ScrollAmount]::NoAmount) }
      elseif ($dir -eq 'left') { $p.Scroll([System.Windows.Automation.ScrollAmount]::LargeDecrement, [System.Windows.Automation.ScrollAmount]::NoAmount) }
      else { $p.SetScrollPercent([System.Windows.Automation.ScrollPattern]::NoScroll, [System.Windows.Automation.ScrollPattern]::NoScroll) }
      return 'scrolled'
    }
    'click' {
      $r = $el.Current.BoundingRectangle
      if ([double]::IsInfinity([double]$r.Width) -or [double]::IsNaN([double]$r.Width) -or $r.Width -lt 1 -or $r.Height -lt 1) {
        throw 'That element has no clickable area on screen.'
      }
      [UiaClick]::Click((To-Int ($r.X + $r.Width / 2)), (To-Int ($r.Y + $r.Height / 2)))
      return 'clicked'
    }
    default { throw ('Unknown UI action: ' + $action) }
  }
}

# Pixel sampling catches custom-drawn controls whose state UI Automation cannot read.
function Get-Samples($el) {
  if ($NoPixels) { return $null }
  try {
    $r = $el.Current.BoundingRectangle
    $w = To-Int $r.Width
    $h = To-Int $r.Height
    if ($w -lt 2 -or $h -lt 2) { return $null }
    if ($w -gt 3000) { $w = 3000 }
    if ($h -gt 3000) { $h = 3000 }
    if (-not ('System.Drawing.Bitmap' -as [type])) { Add-Type -AssemblyName System.Drawing }
    $bmp = New-Object System.Drawing.Bitmap($w, $h)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen((To-Int $r.X), (To-Int $r.Y), 0, 0, (New-Object System.Drawing.Size($w, $h)))
    $g.Dispose()
    $samples = New-Object 'int[]' 256
    $i = 0
    for ($gy = 0; $gy -lt 16; $gy++) {
      for ($gx = 0; $gx -lt 16; $gx++) {
        $px = [Math]::Min($w - 1, [int](($gx + 0.5) * $w / 16))
        $py = [Math]::Min($h - 1, [int](($gy + 0.5) * $h / 16))
        $col = $bmp.GetPixel($px, $py)
        $samples[$i] = ($col.R * 65536) + ($col.G * 256) + $col.B
        $i = $i + 1
      }
    }
    $bmp.Dispose()
    return $samples
  } catch { return $null }
}

function Compare-Samples($a, $b) {
  if ($null -eq $a -or $null -eq $b) { return $null }
  $changed = 0
  for ($i = 0; $i -lt 256; $i++) {
    $p = [int]$a[$i]
    $q = [int]$b[$i]
    $dr = [Math]::Abs([int]($p / 65536) - [int]($q / 65536))
    $dg = [Math]::Abs([int](($p % 65536) / 256) - [int](($q % 65536) / 256))
    $db = [Math]::Abs(($p % 256) - ($q % 256))
    if (($dr + $dg + $db) -ge 24) { $changed = $changed + 1 }
  }
  return [int][Math]::Round(100 * $changed / 256)
}

function Find-Match($needle, $typeFilter) {
  $script:uiaHit = $null
  function Search($el, $p, $d) {
    if ($null -ne $script:uiaHit) { return }
    $c = $el.Current
    $t = $c.ControlType.ProgrammaticName.Split('.')[-1]
    $n = [string]$c.Name
    if ($n -ne '' -and $n.ToLower().Contains($needle.ToLower()) -and ($typeFilter -eq '' -or $t -eq $typeFilter)) {
      $script:uiaHit = [ordered]@{ element = $el; path = $p; name = $n; type = $t; enabled = [bool]$c.IsEnabled; offscreen = [bool]$c.IsOffscreen }
      return
    }
    if ($d -ge 10) { return }
    $child = $walker.GetFirstChild($el)
    $i = 0
    while ($null -ne $child) {
      Search $child ($p + '/' + [string]$i) ($d + 1)
      if ($null -ne $script:uiaHit) { return }
      $child = $walker.GetNextSibling($child)
      $i = $i + 1
    }
  }
  Search $root '0' 0
  return $script:uiaHit
}

if ($Mode -eq 'tree') {
  $script:count = 0
  # One cache request turns ~7 cross-process reads per node into one snapshot
  # per element, which roughly halves the walk time on UWP apps.
  $cacheReady = $false
  try {
    $script:cacheReq = New-Object System.Windows.Automation.CacheRequest
    foreach ($prop in @(
      [System.Windows.Automation.AutomationElement]::NameProperty,
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.AutomationElement]::ClassNameProperty,
      [System.Windows.Automation.AutomationElement]::AutomationIdProperty,
      [System.Windows.Automation.AutomationElement]::IsEnabledProperty,
      [System.Windows.Automation.AutomationElement]::IsOffscreenProperty,
      [System.Windows.Automation.AutomationElement]::BoundingRectangleProperty
    )) { $script:cacheReq.Add($prop) }
    $cacheReady = $true
  } catch {
    $script:cacheReq = $null
  }
  function Walk($el, [int]$d, [string]$p) {
    if ($script:count -ge $Max) { return $null }
    $script:count = $script:count + 1
    $c = $null
    if ($null -ne $script:cacheReq) {
      try { $c = $el.Cached } catch { $c = $null }
    }
    if ($null -eq $c -or [string]::IsNullOrEmpty([string]$c.ControlType)) { $c = $el.Current }
    $r = $c.BoundingRectangle
    $type = $c.ControlType.ProgrammaticName.Split('.')[-1]
    $pats = @()
    try {
      foreach ($pat in $el.GetSupportedPatterns()) {
        $pats += $pat.ProgrammaticName.Split('.')[0].Replace('PatternIdentifiers', '')
      }
    } catch { }
    $node = [ordered]@{
      path = $p
      name = [string]$c.Name
      type = $type
      cls = [string]$c.ClassName
      id = [string]$c.AutomationId
      enabled = [bool]$c.IsEnabled
      offscreen = [bool]$c.IsOffscreen
      x = (To-Int $r.X)
      y = (To-Int $r.Y)
      w = (To-Int $r.Width)
      h = (To-Int $r.Height)
      patterns = $pats
      children = @()
    }
    if ($d -lt $Depth) {
      $kids = @()
      $child = $walker.GetFirstChild($el)
      $i = 0
      while ($null -ne $child -and $script:count -lt $Max) {
        $sub = Walk $child ($d + 1) ($p + '/' + [string]$i)
        if ($null -ne $sub) { $kids += $sub }
        $child = $walker.GetNextSibling($child)
        $i = $i + 1
      }
      $node.children = $kids
    }
    return $node
  }
  $tree = $null
  if ($cacheReady) { $script:cacheReq.Push() }
  try {
    $tree = Walk $root 0 '0'
  } finally {
    if ($cacheReady) { $script:cacheReq.Pop() }
  }
  Out-Json ([ordered]@{ ok = $true; nodes = $script:count; tree = $tree })
  exit 0
}

if ($Mode -eq 'probe') {
  try {
    if ($Path -ne '') {
      $el = Resolve-Element $root $Path
    } elseif ($Match -ne '') {
      $hit = Find-Match $Match $Type
      if ($null -eq $hit) { throw ('No element name contains "' + $Match + '". Re-read ui_tree and try again.') }
      $el = $hit.element
    } else {
      $el = $root
    }
  } catch {
    Out-Json ([ordered]@{ ok = $false; error = $_.Exception.Message; action = $Action })
    exit 0
  }
  $problem = Get-ActionProblem $el $Action
  $state = $null
  try { $state = Get-State $el } catch { }
  Out-Json ([ordered]@{ ok = $true; action = $Action; problem = $problem; state = $state; rect = (Get-RectInfo $el) })
  exit 0
}

if ($Mode -eq 'wait') {
  $started = Get-Date
  $deadline = $started.AddMilliseconds($Timeout)
  $met = $false
  $el = $null
  $hit = $null
  while ($true) {
    $el = $null
    $hit = $null
    try {
      if ($Path -ne '') {
        $el = Resolve-Element $root $Path
      } elseif ($Match -ne '') {
        $hit = Find-Match $Match $Type
        if ($null -ne $hit) { $el = $hit.element }
      } else {
        throw 'wait needs a path or match text.'
      }
    } catch {
      $el = $null
      $hit = $null
    }
    if ($Want -eq 'gone') {
      if ($null -eq $el) { $met = $true; break }
    } elseif ($null -ne $el) {
      if ($Want -eq 'exists') { $met = $true; break }
      elseif ($Want -eq 'enabled') {
        if ([bool]$el.Current.IsEnabled) { $met = $true; break }
      } elseif ($Want -eq 'value') {
        try {
          $p = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
          if ([string]$p.Current.Value -eq [string]$Value) { $met = $true; break }
        } catch { }
      }
    }
    if ((Get-Date) -ge $deadline) { break }
    Start-Sleep -Milliseconds $Interval
  }
  $name = ''
  $typeName = ''
  $state = $null
  $foundPath = $Path
  if ($null -ne $hit) { $foundPath = [string]$hit.path }
  if ($null -ne $el) {
    try {
      $name = [string]$el.Current.Name
      $typeName = $el.Current.ControlType.ProgrammaticName.Split('.')[-1]
      $state = Get-State $el
    } catch { }
  }
  $elapsed = [int]((Get-Date) - $started).TotalMilliseconds
  Out-Json ([ordered]@{
    ok = $true
    met = $met
    elapsedMs = $elapsed
    path = $foundPath
    name = $name
    type = $typeName
    state = $state
  })
  exit 0
}

if ($Mode -eq 'act') {
  $t0 = [System.Diagnostics.Stopwatch]::StartNew()
  function Has($state, $key) { return ($null -ne $state) -and $state.Contains($key) }
  function Get-State($element) {
    $c = $element.Current
    $state = [ordered]@{
      name = [string]$c.Name
      type = $c.ControlType.ProgrammaticName.Split('.')[-1]
      enabled = [bool]$c.IsEnabled
      offscreen = [bool]$c.IsOffscreen
    }
    try {
      $p = $element.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
      $state.toggle = [string]$p.Current.ToggleState
    } catch { }
    try {
      $p = $element.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
      $state.expanded = [string]$p.Current.ExpandCollapseState
    } catch { }
    try {
      $p = $element.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
      $state.selected = [bool]$p.Current.IsSelected
    } catch { }
    try {
      $p = $element.GetCurrentPattern([System.Windows.Automation.RangeValuePattern]::Pattern)
      $state.range = [double]$p.Current.Value
    } catch { }
    # Password boxes must never put their contents back into the transcript.
    if (-not $c.IsPassword) {
      try {
        $p = $element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
        $state.value = [string]$p.Current.Value
      } catch { }
    }
    return $state
  }
  function Test-Verified($name, $before, $after, $wanted) {
    if ($null -eq $after) { return $false }
    if ($name -eq 'set_value') {
      if ((Has $after 'value')) { return ([string]$after.value -eq [string]$wanted) }
    } elseif ($name -eq 'toggle') {
      if ((Has $before 'toggle') -and (Has $after 'toggle')) { return ($before.toggle -ne $after.toggle) }
    } elseif ($name -eq 'expand') {
      if ((Has $after 'expanded')) { return ($after.expanded -eq 'Expanded') }
    } elseif ($name -eq 'collapse') {
      if ((Has $after 'expanded')) { return ($after.expanded -eq 'Collapsed') }
    } elseif ($name -eq 'select') {
      if ((Has $before 'selected') -and (Has $after 'selected')) { return ($after.selected -eq $true) }
    }
    return $null
  }
  function As-Json($state) {
    if ($null -eq $state) { return $null }
    return ($state | ConvertTo-Json -Compress -Depth 4)
  }

  try {
    if ($Path -ne '') {
      $el = Resolve-Element $root $Path
    } elseif ($Match -ne '') {
      $hit = Find-Match $Match $Type
      if ($null -eq $hit) { throw ('No element name contains "' + $Match + '". Re-read ui_tree and try again.') }
      $el = $hit.element
    } else {
      $el = $root
    }
  } catch {
    Out-Json ([ordered]@{ ok = $false; error = $_.Exception.Message; action = $Action })
    exit 0
  }
  $tResolve = $t0.ElapsedMilliseconds
  $problem = Get-ActionProblem $el $Action
  if ($null -ne $problem -and -not $Force) {
    Out-Json ([ordered]@{ ok = $false; error = $problem; action = $Action; rect = (Get-RectInfo $el) })
    exit 0
  }
  $stable = Wait-Stable $el
  $tStable = $t0.ElapsedMilliseconds
  $c = $el.Current
  $before = $null
  try { $before = Get-State $el } catch { }
  $tState = $t0.ElapsedMilliseconds
  # Focus is verified through the focused element, so a pixel snapshot would
  # only add latency.
  $samplesBefore = $null
  if ($Action -ne 'focus') { $samplesBefore = Get-Samples $el }
  $tSample = $t0.ElapsedMilliseconds
  $done = ''
  try {
    $done = Do-Action $el $Action $Value
  } catch {
    Out-Json ([ordered]@{ ok = $false; error = $_.Exception.Message; action = $Action })
    exit 0
  }
  $tAct = $t0.ElapsedMilliseconds
  $rect = $c.BoundingRectangle

  # Read the element again: apps apply changes asynchronously, so poll with a
  # short first hop (most UIA patterns commit synchronously) and back off only
  # while the app is still catching up.
  $after = $null
  $verified = $null
  $changed = $null
  if ($Action -eq 'focus') {
    Start-Sleep -Milliseconds 15
    try {
      $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
      $verified = [System.Windows.Automation.Automation]::Compare($focused, $el)
    } catch { $verified = $null }
    try { $after = Get-State $el } catch { $after = $null }
  } else {
    foreach ($delay in 25, 45, 75, 110) {
      Start-Sleep -Milliseconds $delay
      try { $after = Get-State $el } catch { $after = $null }
      $verified = Test-Verified $Action $before $after $Value
      if ($verified -eq $true) { break }
      if ($null -eq $after) { break }
    }
  }
  if ($null -eq $after) {
    $changed = $true
  } else {
    $changed = ((As-Json $before) -ne (As-Json $after))
  }
  # Pixels are the fallback evidence: the state check is faster and cheaper,
  # so only take a second sample when the state did not already confirm.
  $samplesAfter = $null
  $pixels = $null
  if ($verified -ne $true -and $null -ne $samplesBefore) {
    Start-Sleep -Milliseconds 60
    $samplesAfter = Get-Samples $el
    $pixels = Compare-Samples $samplesBefore $samplesAfter
  }

  Out-Json ([ordered]@{
    ok = $true
    action = $Action
    done = $done
    name = [string]$c.Name
    type = $c.ControlType.ProgrammaticName.Split('.')[-1]
    verified = $verified
    changed = $changed
    stable = $stable
    pixels = $pixels
    before = $before
    after = $after
    rect = [ordered]@{ x = (To-Int $rect.X); y = (To-Int $rect.Y); w = (To-Int $rect.Width); h = (To-Int $rect.Height) }
    t = [ordered]@{ resolve = $tResolve; stable = $tStable; state = $tState; sample = $tSample; act = $tAct; total = $t0.ElapsedMilliseconds }
  })
  exit 0
}

throw ('Unknown UIA mode: ' + $Mode)
`;

/* The same UIA logic runs inside one long-lived PowerShell process. Starting
 * PowerShell and loading the UIAutomation assemblies costs ~1.4 s per call, so
 * the one-shot script stays as a fallback but the host serves every request
 * after the first. */
const UIA_HOST_SCRIPT = (() => {
  const start = UIA_SCRIPT.indexOf('$ErrorActionPreference');
  const rootAt = UIA_SCRIPT.indexOf('$root = Get-Root $Handle');
  const dispatchAt = UIA_SCRIPT.indexOf("if ($Mode -eq 'tree') {");
  const unknownAt = UIA_SCRIPT.lastIndexOf("throw ('Unknown UIA mode: ' + $Mode)");
  if (start < 0 || rootAt < 0 || dispatchAt < 0 || unknownAt < 0) return '';
  const helpers = UIA_SCRIPT.slice(start, rootAt);
  const rootBlock = UIA_SCRIPT.slice(rootAt, dispatchAt);
  const dispatch = UIA_SCRIPT.slice(dispatchAt, unknownAt).replace(/\bexit 0\b/g, 'return');
  return `${helpers}
# Load GDI+ up front so the first pixel check does not pay assembly startup.
try { Add-Type -AssemblyName System.Drawing } catch { }
function Out-Json($obj) {
  $json = $obj | ConvertTo-Json -Compress -Depth 60
  if ($null -eq $json) { $json = 'null' }
  [Console]::Out.WriteLine('R:' + [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($json)))
}
function Invoke-UiaRequest {
${rootBlock}
${dispatch}
  throw ('Unknown UIA mode: ' + $Mode)
}
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim() -eq '') { continue }
  try {
    $req = $line | ConvertFrom-Json
    $Mode = [string]$req.mode
    if ($null -eq $req.handle) { $Handle = 0 } else { $Handle = [long]$req.handle }
    if ($null -eq $req.depth) { $Depth = 4 } else { $Depth = [int]$req.depth }
    if ($null -eq $req.max) { $Max = 300 } else { $Max = [int]$req.max }
    if ($null -eq $req.path) { $Path = '' } else { $Path = [string]$req.path }
    if ($null -eq $req.action) { $Action = '' } else { $Action = [string]$req.action }
    if ($null -eq $req.value) { $Value = '' } else { $Value = [string]$req.value }
    $Force = [bool]$req.force
    if ($null -eq $req.match) { $Match = '' } else { $Match = [string]$req.match }
    if ($null -eq $req.type) { $Type = '' } else { $Type = [string]$req.type }
    if ($null -eq $req.want) { $Want = 'exists' } else { $Want = [string]$req.want }
    if ($null -eq $req.timeout) { $Timeout = 5000 } else { $Timeout = [int]$req.timeout }
    if ($null -eq $req.interval) { $Interval = 250 } else { $Interval = [int]$req.interval }
    $NoPixels = [bool]$req.noPixels
    Invoke-UiaRequest
  } catch {
    $m = [regex]::Replace($_.Exception.Message, '[\\r\\n]+', ' ')
    [Console]::Out.WriteLine('R:ERR ' + $m)
  }
  [Console]::Out.Flush()
}
`;
})();

const OCR_SCRIPT = `param(
  [Parameter(Mandatory=$true)][string]$Path,
  [string]$Lang = ''
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $Path)) { throw ('Image not found: ' + $Path) }
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.SoftwareBitmap,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]
$null = [Windows.Globalization.Language,Windows.Globalization,ContentType=WindowsRuntime]

$asTask = @([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -like 'IAsyncOperation*'
})[0]
if ($null -eq $asTask) { throw 'The WinRT async bridge is missing on this Windows install.' }

function Await($op, $type) {
  $method = $asTask.MakeGenericMethod($type)
  $task = $method.Invoke($null, @($op))
  $task.Wait(-1) | Out-Null
  return $task.Result
}

function Out-Json($obj) {
  $json = $obj | ConvertTo-Json -Compress -Depth 10
  if ($null -eq $json) { $json = 'null' }
  return 'J:' + [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($json))
}

$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Path)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

$engine = $null
if ($Lang -ne '') {
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new($Lang))
} else {
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
}
if ($null -eq $engine) { throw 'No OCR language pack is available. Install a Windows language with OCR support.' }

$res = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
$lines = @()
foreach ($line in $res.Lines) {
  $words = @()
  $minX = 1.0 * [int]::MaxValue
  $minY = 1.0 * [int]::MaxValue
  $maxX = 0.0
  $maxY = 0.0
  foreach ($w in $line.Words) {
    $r = $w.BoundingRect
    if ($r.X -lt $minX) { $minX = $r.X }
    if ($r.Y -lt $minY) { $minY = $r.Y }
    if (($r.X + $r.Width) -gt $maxX) { $maxX = $r.X + $r.Width }
    if (($r.Y + $r.Height) -gt $maxY) { $maxY = $r.Y + $r.Height }
    $words += [ordered]@{ text = [string]$w.Text; x = [int]$r.X; y = [int]$r.Y; w = [int]$r.Width; h = [int]$r.Height }
  }
  if ($words.Count -eq 0) { $minX = 0; $minY = 0; $maxX = 0; $maxY = 0 }
  $lines += [ordered]@{
    text = [string]$line.Text
    x = [int]$minX
    y = [int]$minY
    w = [int]($maxX - $minX)
    h = [int]($maxY - $minY)
    words = $words
  }
}
$result = [ordered]@{
  text = [string]$res.Text
  lang = [string]$engine.RecognizerLanguage.LanguageTag
  width = [int]$decoder.PixelWidth
  height = [int]$decoder.PixelHeight
  lines = $lines
}
Out-Json $result
`;

function psScriptFile(name, text) {
  const tag = crypto.createHash('sha1').update(text).digest('hex').slice(0, 10);
  const file = path.join(os.tmpdir(), `orvex-${name}-${tag}.ps1`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, '\uFEFF' + text, 'utf8');
  return file;
}

function runPowerShell(name, text, args, timeout = 90000) {
  return new Promise((resolve) => {
    const file = psScriptFile(name, text);
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', file, ...args],
      { windowsHide: true, timeout, maxBuffer: 12 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        const textOut = String(stdout || '');
        const line = textOut
          .split(/\r?\n/)
          .map((l) => l.replace(/^\uFEFF/, '').trim())
          .find((l) => l.startsWith('J:'));
        if (line) {
          try {
            resolve({ ok: true, data: JSON.parse(Buffer.from(line.slice(2), 'base64').toString('utf8')) });
            return;
          } catch (parseErr) {
            resolve({ ok: false, error: `PowerShell reply was not valid JSON: ${parseErr.message}` });
            return;
          }
        }
        const detail = String(stderr || '').trim() || textOut.trim() || (err && err.message) || 'PowerShell failed.';
        resolve({ ok: false, error: detail.slice(0, 1500) });
      },
    );
  });
}

let uiaHost = null;
let uiaHostReady = null;
let uiaQueue = Promise.resolve();
let uiaPending = null;
let uiaBuffer = '';

function settleUiaReply(reply) {
  const pending = uiaPending;
  if (!pending) return;
  uiaPending = null;
  clearTimeout(pending.timer);
  if (reply.ok) pending.resolve({ ok: true, data: reply.data });
  else pending.reject(new Error(reply.error || 'The UI Automation helper failed.'));
}

function ensureUiaHost() {
  if (uiaHost && uiaHostReady) return uiaHostReady;
  uiaHostReady = new Promise((resolve, reject) => {
    if (!UIA_HOST_SCRIPT) {
      reject(new Error('The UI Automation helper script is unavailable.'));
      return;
    }
    const file = psScriptFile('uia-host', UIA_HOST_SCRIPT);
    const proc = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', file],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      try {
        proc.kill();
      } catch {
        /* already gone */
      }
      if (uiaHost === proc) {
        uiaHost = null;
        uiaHostReady = null;
      }
      reject(err);
    };
    proc.on('error', fail);
    proc.on('exit', () => {
      if (uiaHost === proc) {
        uiaHost = null;
        uiaHostReady = null;
      }
      const pending = uiaPending;
      if (pending) {
        uiaPending = null;
        clearTimeout(pending.timer);
        pending.reject(new Error('The UI Automation helper stopped.'));
      }
    });
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      uiaBuffer += chunk;
      let nl;
      while ((nl = uiaBuffer.indexOf('\n')) >= 0) {
        const line = uiaBuffer.slice(0, nl).replace(/^\uFEFF/, '').trim();
        uiaBuffer = uiaBuffer.slice(nl + 1);
        if (!line.startsWith('R:')) continue;
        const body = line.slice(2).trim();
        if (body.startsWith('ERR ')) {
          settleUiaReply({ ok: false, error: body.slice(4) });
          continue;
        }
        try {
          settleUiaReply({ ok: true, data: JSON.parse(Buffer.from(body, 'base64').toString('utf8')) });
        } catch {
          settleUiaReply({ ok: false, error: 'The UI Automation reply was not valid JSON.' });
        }
      }
    });
    proc.stderr.on('data', () => {});
    uiaHost = proc;
    settled = true;
    resolve(proc);
  });
  return uiaHostReady;
}

function runUiaHost(request, timeout = 30000) {
  const execute = async () => {
    const proc = await ensureUiaHost();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!uiaPending || uiaPending.timer !== timer) return;
        uiaPending = null;
        try {
          proc.kill();
        } catch {
          /* already gone */
        }
        if (uiaHost === proc) {
          uiaHost = null;
          uiaHostReady = null;
        }
        const err = new Error(`The UI Automation request timed out after ${Math.round(timeout / 1000)}s.`);
        err.code = 'UIA_HOST_TIMEOUT';
        reject(err);
      }, timeout);
      uiaPending = { resolve, reject, timer };
      try {
        proc.stdin.write(JSON.stringify(request) + '\n');
      } catch (err) {
        clearTimeout(timer);
        uiaPending = null;
        reject(err);
      }
    });
  };
  const result = uiaQueue.then(execute, execute);
  uiaQueue = result.then(
    () => {},
    () => {},
  );
  return result;
}

const UIA_FLAGS = {
  '-Mode': 'mode',
  '-Handle': 'handle',
  '-Depth': 'depth',
  '-Max': 'max',
  '-Path': 'path',
  '-Action': 'action',
  '-Value': 'value',
  '-Match': 'match',
  '-Type': 'type',
  '-Want': 'want',
  '-Timeout': 'timeout',
  '-Interval': 'interval',
};

function uiaArgsToRequest(args) {
  const request = {};
  for (let i = 0; i < args.length; i += 1) {
    const flag = String(args[i]);
    if (flag === '-Force') {
      request.force = true;
      continue;
    }
    if (flag === '-NoPixels') {
      request.noPixels = true;
      continue;
    }
    const key = UIA_FLAGS[flag];
    if (!key) continue;
    const value = args[i + 1];
    i += 1;
    if (['handle', 'depth', 'max', 'timeout', 'interval'].includes(key)) {
      const n = Number(value);
      if (Number.isFinite(n)) request[key] = Math.round(n);
    } else {
      request[key] = String(value == null ? '' : value);
    }
  }
  return request;
}

async function runUia(args, timeout = 30000) {
  try {
    return await runUiaHost(uiaArgsToRequest(args), timeout + 2000);
  } catch (err) {
    if (err && err.code === 'UIA_HOST_TIMEOUT') throw err;
    // The host could not start or died mid-request; the one-shot script keeps
    // desktop control working, just slower.
    return runPowerShell('uia', UIA_SCRIPT, args, timeout);
  }
}

async function resolveUiHandle(args) {
  if (args.handle != null && String(args.handle).trim() !== '') {
    const n = Number(args.handle);
    if (!Number.isFinite(n) || n <= 0) return { error: 'handle must be a window handle (hwnd) number.' };
    return { handle: Math.round(n), title: '' };
  }
  const ref = args.title ?? args.window ?? args.name;
  if (ref == null) return { error: 'Give a window title or hwnd.' };
  const resolved = await resolveWindow(ref);
  if (resolved.error) return { error: resolved.error };
  return { handle: resolved.window.hwnd, title: resolved.window.title };
}

const UIA_INTERACTIVE_TYPES = new Set([
  'Button',
  'CheckBox',
  'ComboBox',
  'DataItem',
  'Edit',
  'Hyperlink',
  'ListItem',
  'MenuItem',
  'RadioButton',
  'Slider',
  'Spinner',
  'SplitButton',
  'TabItem',
  'TreeItem',
]);

const UIA_INTERACTIVE_PATTERNS = new Set([
  'ExpandCollapse',
  'Invoke',
  'RangeValue',
  'Scroll',
  'Selection',
  'SelectionItem',
  'Toggle',
  'Transform',
  'Value',
]);

function isInteractiveNode(node) {
  if (!node) return false;
  const patterns = Array.isArray(node.patterns) ? node.patterns : [];
  if (patterns.some((p) => UIA_INTERACTIVE_PATTERNS.has(String(p)))) return true;
  return UIA_INTERACTIVE_TYPES.has(String(node.type || '').replace(/Control$/, ''));
}

function countInteractive(node, total = 0) {
  if (!node) return total;
  const next = total + (isInteractiveNode(node) ? 1 : 0);
  return asArray(node.children).reduce((sum, child) => countInteractive(child, sum), next);
}

function findUiNodeByPath(node, wanted) {
  if (!node) return null;
  const here = String(node.path ?? '').replace(/^\[|\]$/g, '');
  if (here === wanted) return node;
  for (const child of asArray(node.children)) {
    const hit = findUiNodeByPath(child, wanted);
    if (hit) return hit;
  }
  return null;
}

function countMatchingNodes(node, name, type) {
  if (!node) return 0;
  let total = String(node.name || '') === name && (!type || String(node.type || '') === type) ? 1 : 0;
  for (const child of asArray(node.children)) total += countMatchingNodes(child, name, type);
  return total;
}

function formatTree(node, depth, lines, cap, onlyInteractive = false) {
  if (!node || lines.length >= cap) return;
  const hidden = onlyInteractive && (node.offscreen || node.w === 0 || node.h === 0);
  const show = !onlyInteractive || (!hidden && isInteractiveNode(node));
  const childDepth = show ? depth + 1 : depth;
  if (show) {
    const label = node.name ? String(node.name).slice(0, 120) : '(no name)';
    const bits = [`${'  '.repeat(depth)}[${node.path}] ${node.type} "${label}"`];
    if (node.id) bits.push(`id=${node.id}`);
    if (node.enabled === false) bits.push('disabled');
    if (node.offscreen) bits.push('offscreen');
    if (node.w) bits.push(`${node.x},${node.y} ${node.w}x${node.h}`);
    if (depth === 0 && Array.isArray(node.patterns) && node.patterns.length) bits.push(`patterns: ${node.patterns.join(',')}`);
    lines.push(bits.join(' '));
  }
  for (const child of asArray(node.children)) formatTree(child, childDepth, lines, cap, onlyInteractive);
}

/* A short snapshot cache removes a full PowerShell round-trip when the agent
 * re-reads the same window. Actions clear it, so it can never report stale
 * element state after something changed. */
const UI_TREE_TTL_MS = 1500;
const UI_TREE_CACHE_LIMIT = 16;
const uiTreeCache = new Map();

function treeCacheKey(handle, depth, max) {
  return `${handle}|${depth}|${max}`;
}

function invalidateUiTree(handle) {
  const prefix = `${handle}|`;
  for (const key of uiTreeCache.keys()) if (key.startsWith(prefix)) uiTreeCache.delete(key);
}

function recallUiTree(handle, depth, max) {
  const key = treeCacheKey(handle, depth, max);
  const hit = uiTreeCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > UI_TREE_TTL_MS) {
    uiTreeCache.delete(key);
    return null;
  }
  return hit;
}

function rememberUiTree(handle, depth, max, data) {
  uiTreeCache.set(treeCacheKey(handle, depth, max), { at: Date.now(), data });
  if (uiTreeCache.size > UI_TREE_CACHE_LIMIT) {
    let oldestKey = null;
    let oldestAt = Infinity;
    for (const [key, hit] of uiTreeCache) {
      if (hit.at < oldestAt) {
        oldestAt = hit.at;
        oldestKey = key;
      }
    }
    if (oldestKey) uiTreeCache.delete(oldestKey);
  }
}

function latestUiTree(handle) {
  let best = null;
  const prefix = `${handle}|`;
  for (const [key, hit] of uiTreeCache) {
    if (key.startsWith(prefix) && (!best || hit.at > best.at)) best = hit;
  }
  return best;
}

async function uiTree(args = {}) {
  if (process.platform !== 'win32') return { ok: false, error: 'UI Automation is Windows-only.' };
  const started = Date.now();
  const target = await resolveUiHandle(args);
  if (target.error) return { ok: false, error: target.error };
  const depth = Math.min(Math.max(Math.round(Number(args.depth) || 4), 1), 12);
  const max = Math.min(Math.max(Math.round(Number(args.max) || 300), 10), MAX_UIA_NODES);
  const interactiveOnly = args.interactive === true;
  let data = null;
  let cached = false;
  if (args.refresh !== true) {
    const hit = recallUiTree(target.handle, depth, max);
    if (hit) {
      data = hit.data;
      cached = true;
    }
  }
  if (!data) {
    const r = await runUia(['-Mode', 'tree', '-Handle', String(target.handle), '-Depth', String(depth), '-Max', String(max)]);
    if (!r.ok) return r;
    data = r.data || {};
    rememberUiTree(target.handle, depth, max, data);
  }
  const lines = [];
  formatTree(data.tree, 0, lines, max, interactiveOnly);
  const shown = interactiveOnly ? lines.length : data.nodes || lines.length;
  const head = `UI Automation tree for ${target.title ? `"${target.title}"` : `hwnd ${target.handle}`} — ${shown} nodes${
    interactiveOnly ? ' (interactive only)' : ''
  } (depth ${depth})${cached ? ', from the snapshot cache' : ''}. Paths are for ui_action.`;
  return {
    ok: true,
    output: `${head}\n${lines.join('\n')}`,
    tree: data.tree || null,
    nodes: data.nodes || lines.length,
    depth,
    title: target.title || '',
    handle: target.handle,
    cached,
    ms: Date.now() - started,
  };
}

/** Flash a click-through frame around the element the agent is about to touch. */
async function flashTarget(rect) {
  const electron = electronApi();
  if (!electron || !electron.BrowserWindow || !electron.screen) return;
  let win = null;
  try {
    let tl;
    let br;
    if (typeof electron.screen.screenToDipPoint === 'function') {
      tl = electron.screen.screenToDipPoint({ x: rect.x, y: rect.y });
      br = electron.screen.screenToDipPoint({ x: rect.x + Math.max(1, rect.w), y: rect.y + Math.max(1, rect.h) });
    } else {
      const display = electron.screen.getDisplayNearestPoint({ x: rect.x, y: rect.y });
      const sf = display.scaleFactor || 1;
      tl = { x: rect.x / sf, y: rect.y / sf };
      br = { x: (rect.x + Math.max(1, rect.w)) / sf, y: (rect.y + Math.max(1, rect.h)) / sf };
    }
    const pad = 4;
    const width = Math.max(8, Math.round(br.x - tl.x + pad * 2));
    const height = Math.max(8, Math.round(br.y - tl.y + pad * 2));
    win = new electron.BrowserWindow({
      x: Math.round(tl.x - pad),
      y: Math.round(tl.y - pad),
      width,
      height,
      frame: false,
      transparent: true,
      focusable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      resizable: false,
      movable: false,
      fullscreenable: false,
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true },
    });
    win.setIgnoreMouseEvents(true);
    win.setAlwaysOnTop(true, 'screen-saver');
    const html =
      '<!doctype html><html><body style="margin:0;background:transparent;overflow:hidden">' +
      '<div style="position:absolute;inset:3px;border:2px solid rgba(0,229,255,.95);border-radius:7px;' +
      'box-shadow:0 0 16px rgba(0,229,255,.85), inset 0 0 12px rgba(0,229,255,.35);background:rgba(0,229,255,.07)"></div>' +
      '</body></html>';
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    win.showInactive();
    await new Promise((resolve) => setTimeout(resolve, 230));
  } catch {
    /* the overlay is cosmetic — never fail an action because of it */
  }
  if (win) {
    try {
      win.destroy();
    } catch {
      /* already gone */
    }
  }
}

async function performUiAction(target, opts = {}) {
  const action = String(opts.action || 'click').toLowerCase();
  const allowed = ['invoke', 'click', 'set_value', 'toggle', 'select', 'expand', 'collapse', 'focus', 'scroll'];
  if (!allowed.includes(action)) return { ok: false, error: `action must be one of ${allowed.join(', ')}.` };
  const path = String(opts.path ?? '').trim().replace(/^\[|\]$/g, '');
  const match = String(opts.match ?? '').trim();
  const type = String(opts.type ?? '').replace(/\s+/g, '');
  if (!path && !match) {
    return { ok: false, error: 'Give an element path from ui_tree, or match text to find it by name.' };
  }
  const started = Date.now();
  let selector = path ? ['-Path', path] : ['-Match', match, '-Type', type];
  const force = opts.force === true;
  let recovered = '';

  if (opts.overlay !== false) {
    let probe = await runUia(['-Mode', 'probe', '-Handle', String(target.handle), ...selector, '-Action', action]);
    if (probe.ok && probe.data && probe.data.ok === false && path) {
      // The tree shifted since the last snapshot. Recover only when the cached
      // element has a unique name, so a rename cannot silently hit a neighbour.
      const cachedTree = latestUiTree(target.handle);
      const node = cachedTree ? findUiNodeByPath(cachedTree.data.tree, path) : null;
      const name = node ? String(node.name || '') : '';
      const type = node ? String(node.type || '') : '';
      if (name && countMatchingNodes(cachedTree.data.tree, name, type) === 1) {
        const alt = ['-Match', name, '-Type', type];
        const retry = await runUia(['-Mode', 'probe', '-Handle', String(target.handle), ...alt, '-Action', action]);
        if (retry.ok && retry.data && retry.data.ok !== false) {
          probe = retry;
          selector = alt;
          recovered = ` — the path had moved and was re-matched by name "${name.slice(0, 80)}"`;
        }
      }
    }
    if (!probe.ok) return probe;
    const info = probe.data || {};
    if (info.ok === false) return { ok: false, error: info.error || 'The element could not be resolved.' };
    if (info.problem && !force) return { ok: false, error: `${info.problem} (use force:true only if you know it is safe)` };
    if (info.rect && info.rect.w > 0 && info.rect.h > 0) await flashTarget(info.rect);
  }

  const psArgs = ['-Mode', 'act', '-Handle', String(target.handle), ...selector, '-Action', action];
  if (opts.value != null) psArgs.push('-Value', String(opts.value));
  if (force) psArgs.push('-Force');
  const r = await runUia(psArgs);
  if (!r.ok) return r;
  const data = r.data || {};
  if (data.ok === false) return { ok: false, error: data.error || 'The UI action was refused.' };

  let check = '';
  if (data.verified === true && action === 'focus') check = ' — verified: the element now has focus';
  else if (data.verified === true) check = ' — verified: the element now reports the new state';
  else if (data.verified === false) check = ' — NOT confirmed: the element still reports its old value/state, so check the screen before relying on this';
  else if (data.changed === true) check = ' — the element state changed';
  else if (data.changed === false) check = ' — no state change was visible on that element';
  if (data.pixels != null) {
    if (data.pixels >= 2) check += ` — the screen region visibly changed (~${data.pixels}%)`;
    else check += ' — the screen region looks unchanged';
  }
  if (data.stable === false) check += ' — warning: the element was still moving when it was acted on';
  invalidateUiTree(target.handle);
  return {
    ok: true,
    output: `UI ${action} on ${data.type || 'element'} "${String(data.name || '').slice(0, 120)}" — ${data.done || 'done'}${
      data.rect ? ` (${data.rect.x},${data.rect.y} ${data.rect.w}x${data.rect.h})` : ''
    }${check}${recovered}.`,
    verified: data.verified ?? null,
    changed: data.changed ?? null,
    stable: data.stable ?? null,
    pixels: data.pixels ?? null,
    recovered: !!recovered,
    ms: Date.now() - started,
    timing: data.t || null,
  };
}

async function uiAction(args = {}) {
  if (process.platform !== 'win32') return { ok: false, error: 'UI Automation is Windows-only.' };
  const target = await resolveUiHandle(args);
  if (target.error) return { ok: false, error: target.error };
  return performUiAction(target, args);
}

async function uiSequence(args = {}) {
  if (process.platform !== 'win32') return { ok: false, error: 'UI Automation is Windows-only.' };
  const steps = Array.isArray(args.steps) ? args.steps : null;
  if (!steps || !steps.length) return { ok: false, error: 'steps must be a non-empty array of {path, action, value}.' };
  if (steps.length > 12) return { ok: false, error: 'A UI sequence is capped at 12 steps. Split it into two calls.' };
  const target = await resolveUiHandle(args);
  if (target.error) return { ok: false, error: target.error };
  const delayMs = Math.min(Math.max(Math.round(Number(args.delayMs) || 80), 0), 5000);
  const results = [];
  const lines = [];
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i] && typeof steps[i] === 'object' ? steps[i] : {};
    const res = await performUiAction(target, {
      path: step.path,
      match: step.match,
      type: step.type,
      action: step.action,
      value: step.value,
      force: args.force,
      overlay: args.overlay,
    });
    results.push({
      step: i + 1,
      action: step.action || 'click',
      ok: res.ok === true,
      output: res.output || '',
      error: res.error || '',
      verified: res.verified ?? null,
    });
    if (!res.ok) {
      const failure = `Step ${i + 1} (${step.action || 'click'}) failed: ${res.error || res.output}`;
      return {
        ok: false,
        error: failure,
        output: `${lines.concat(failure).join('\n')}\nThe sequence stopped; nothing after this step ran.`,
        steps: results,
        failedStep: i + 1,
      };
    }
    lines.push(`Step ${i + 1}: ${String(res.output || '').trim()}`);
    if (delayMs && i < steps.length - 1) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return { ok: true, output: `UI sequence completed ${steps.length} step(s):\n${lines.join('\n')}`, steps: results };
}

async function uiWait(args = {}) {
  if (process.platform !== 'win32') return { ok: false, error: 'UI Automation is Windows-only.' };
  const started = Date.now();
  const state = String(args.state || 'exists').toLowerCase();
  const allowed = ['exists', 'gone', 'enabled', 'value'];
  if (!allowed.includes(state)) return { ok: false, error: `state must be one of ${allowed.join(', ')}.` };
  const path = String(args.path ?? '').trim().replace(/^\[|\]$/g, '');
  const match = String(args.match ?? '').trim();
  if (!path && !match) return { ok: false, error: 'Give an element path from ui_tree or a match text.' };
  const timeoutMs = Math.min(Math.max(Math.round(Number(args.timeoutMs) || 5000), 200), 60000);
  const intervalMs = Math.min(Math.max(Math.round(Number(args.intervalMs) || 200), 50), 2000);
  const target = await resolveUiHandle(args);
  if (target.error) return { ok: false, error: target.error };
  const psArgs = [
    '-Mode',
    'wait',
    '-Handle',
    String(target.handle),
    '-Path',
    path,
    '-Match',
    match,
    '-Type',
    String(args.type || ''),
    '-Want',
    state,
    '-Timeout',
    String(timeoutMs),
    '-Interval',
    String(intervalMs),
    '-NoPixels',
  ];
  if (args.value != null) psArgs.push('-Value', String(args.value));
  const r = await runUia(psArgs, timeoutMs + 20000);
  if (!r.ok) return r;
  const data = r.data || {};
  if (data.met === true) invalidateUiTree(target.handle);
  const seconds = (Number(data.elapsedMs || 0) / 1000).toFixed(1);
  const label = data.type
    ? `${data.type} "${String(data.name || '').slice(0, 120)}"`
    : match
      ? `"${match}"`
      : 'the element';
  const what =
    state === 'gone' ? 'disappeared' : state === 'enabled' ? 'became enabled' : state === 'value' ? `now holds "${String(args.value ?? '')}"` : 'appeared';
  const output = data.met
    ? `Wait met after ${seconds}s: ${label} ${what}${data.path ? ` at path ${data.path}` : ''}.`
    : `Waited ${seconds}s but ${label} did not ${state === 'gone' ? 'disappear' : state === 'enabled' ? 'become enabled' : state === 'value' ? 'reach that value' : 'appear'}. Take a screenshot or re-read ui_tree before retrying.`;
  return {
    ok: true,
    met: data.met === true,
    output,
    elapsedMs: data.elapsedMs || 0,
    path: data.path || '',
    name: data.name || '',
    type: data.type || '',
    ms: Date.now() - started,
  };
}

async function screenOcr(args = {}) {
  let file = '';
  let sourceNote = '';
  if (args.path) {
    const target = path.resolve(String(args.path));
    const blocked = checkPath(target, 'read');
    if (blocked) return { ok: false, error: blocked };
    if (!fs.existsSync(target)) return { ok: false, error: `Image not found: ${target}` };
    file = target;
    sourceNote = `image ${target}`;
  } else {
    const shot = await screenCapture(args);
    if (!shot.ok) return shot;
    const match = /Screenshot saved: (.+)/.exec(shot.output || '');
    if (!match) return { ok: false, error: 'Could not determine the screenshot path.' };
    file = match[1].trim();
    sourceNote = 'current screen';
  }
  const lang = String(args.lang || '').trim();
  let data;
  if (process.platform !== 'win32') {
    const native = await platform.ocr(file, lang);
    if (!native.ok) return native;
    data = native.data || {};
    const electron = electronApi();
    try {
      const image = electron && electron.nativeImage ? electron.nativeImage.createFromPath(file) : null;
      if (image && !image.isEmpty()) {
        const size = image.getSize();
        data.width = size.width;
        data.height = size.height;
      }
    } catch {
      /* size is cosmetic */
    }
  } else {
    const psArgs = ['-Path', file];
    if (lang) psArgs.push('-Lang', lang);
    const r = await runPowerShell('ocr', OCR_SCRIPT, psArgs, 120000);
    if (!r.ok) return r;
    data = r.data || {};
  }
  const lines = asArray(data.lines);
  if (!lines.length) {
    return {
      ok: true,
      output: `No text was recognised on ${sourceNote} (${data.width || '?'}x${data.height || '?'}, language ${data.lang || 'default'}).`,
      image: args.path ? null : file,
      file,
      lines: [],
      text: '',
      lang: data.lang || '',
      width: data.width || 0,
      height: data.height || 0,
    };
  }
  const body = lines.map((l) => `  [${l.x},${l.y} ${l.w}x${l.h}] ${l.text}`).join('\n');
  return {
    ok: true,
    output: `OCR on ${sourceNote} (${data.width}x${data.height}, ${data.lang}) found ${lines.length} line(s):\n${body}\n\nFull text:\n${String(data.text || '').slice(0, 8000)}`,
    image: args.path ? null : file,
    file,
    lines,
    text: String(data.text || ''),
    lang: data.lang || '',
    width: data.width || 0,
    height: data.height || 0,
  };
}

/* ------------------------- apps and screen grounding ------------------------- */

const APP_CACHE_MS = 5 * 60 * 1000;
let appCache = { at: 0, apps: null };

const START_APPS_SCRIPT = `
$ErrorActionPreference = 'Stop'
$apps = @(Get-StartApps | ForEach-Object { [pscustomobject]@{ name = [string]$_.Name; appId = [string]$_.AppID } })
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($apps | ConvertTo-Json -Compress -Depth 3)))
Write-Output "J:$b64"
`;

function matchApp(apps, query) {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return { exact: null, matches: [] };
  const exact = apps.find((a) => a.name.toLowerCase() === needle) || null;
  if (exact) return { exact, matches: [exact] };
  const prefix = apps.filter((a) => a.name.toLowerCase().startsWith(needle));
  if (prefix.length === 1) return { exact: prefix[0], matches: prefix };
  if (prefix.length > 1) return { exact: null, matches: prefix };
  const loose = apps.filter((a) => a.name.toLowerCase().includes(needle));
  return { exact: loose.length === 1 ? loose[0] : null, matches: loose };
}

function flattenUiTree(node, out = []) {
  if (!node || out.length >= MAX_UIA_NODES) return out;
  out.push(node);
  for (const child of asArray(node.children)) flattenUiTree(child, out);
  return out;
}

function matchUiTree(tree, text, exact) {
  const needle = String(text).trim().toLowerCase();
  if (!needle) return [];
  const found = [];
  for (const node of flattenUiTree(tree)) {
    const name = String(node.name || '').trim();
    if (!name) continue;
    const hit = exact ? name.toLowerCase() === needle : name.toLowerCase().includes(needle);
    if (!hit) continue;
    const w = Math.round(Number(node.w) || 0);
    const h = Math.round(Number(node.h) || 0);
    const x = Math.round(Number(node.x) || 0);
    const y = Math.round(Number(node.y) || 0);
    if (node.offscreen === true || w <= 0 || h <= 0) continue;
    found.push({
      source: 'uia',
      name: name.slice(0, 160),
      type: String(node.type || ''),
      path: String(node.path || ''),
      x,
      y,
      w,
      h,
      cx: x + w / 2,
      cy: y + h / 2,
    });
  }
  return found;
}

function matchOcrLines(lines, text, exact, origin = { x: 0, y: 0 }, offset = { x: 0, y: 0 }) {
  const needle = String(text).trim().toLowerCase();
  if (!needle) return [];
  const found = [];
  for (const line of asArray(lines)) {
    const value = String(line.text || '').trim();
    if (!value) continue;
    const hit = exact ? value.toLowerCase() === needle : value.toLowerCase().includes(needle);
    if (!hit) continue;
    const x = (Number(line.x) || 0) + (Number(origin.x) || 0) + (Number(offset.x) || 0);
    const y = (Number(line.y) || 0) + (Number(origin.y) || 0) + (Number(offset.y) || 0);
    const w = Math.round(Number(line.w) || 0);
    const h = Math.round(Number(line.h) || 0);
    found.push({ source: 'ocr', name: value.slice(0, 160), type: 'text', path: '', x, y, w, h, cx: x + w / 2, cy: y + h / 2 });
  }
  return found;
}

async function appsList(args = {}) {
  let installed;
  if (process.platform !== 'win32') {
    const native = await platform.apps(!!args.force);
    if (!native.ok) return native;
    installed = native.apps;
  } else {
    const now = Date.now();
    if (args.force || !appCache.apps || now - appCache.at > APP_CACHE_MS) {
      const r = await runPowerShell('apps', START_APPS_SCRIPT, [], 45000);
      if (!r.ok) return r;
      const data = r.data;
      const rows = Array.isArray(data) ? data : data && Array.isArray(data.value) ? data.value : data ? [data] : [];
      const apps = rows
        .map((row) => ({ name: String((row && row.name) || '').trim(), appId: String((row && row.appId) || '').trim() }))
        .filter((row) => row.name && row.appId)
        .sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
      appCache = { at: now, apps };
    }
    installed = appCache.apps;
  }
  const total = installed.length;
  const needle = String(args.filter || args.query || '').trim().toLowerCase();
  const limit = Math.min(Math.max(Math.round(Number(args.limit) || 60), 1), 300);
  const shown = (needle ? installed.filter((a) => a.name.toLowerCase().includes(needle)) : installed).slice(0, limit);
  if (!total) return { ok: true, output: 'No installed apps were found.', apps: [], total: 0 };
  return {
    ok: true,
    output: shown.length
      ? `${total} installed app${total === 1 ? '' : 's'}${needle ? `, ${shown.length} matching "${args.filter || args.query}"` : ''}:\n${shown
          .map((a) => `  ${a.name}`)
          .join('\n')}`
      : `No installed app matches "${args.filter || args.query}".`,
    apps: shown,
    total,
  };
}

async function appLaunch(args = {}) {
  if (process.platform !== 'win32') return platform.appLaunch(args);
  const electron = electronApi();
  const targetPath = String(args.path || '').trim();
  const appIdArg = String(args.appId || '').trim();
  const query = String(args.name || args.app || '').trim();

  if (targetPath) {
    const blocked = checkPath(path.resolve(targetPath), 'read');
    if (blocked) return { ok: false, error: blocked };
    if (!fs.existsSync(targetPath)) return { ok: false, error: `${targetPath} does not exist.` };
    if (!electron) return { ok: false, error: 'Opening a path runs inside the ORVEX desktop app only.' };
    const failed = await electron.shell.openPath(path.resolve(targetPath));
    if (failed) return { ok: false, error: failed };
    return { ok: true, output: `Opened ${targetPath}.`, app: { name: path.basename(targetPath), appId: '', path: targetPath } };
  }

  let appId = appIdArg;
  let appName = query || appIdArg;
  if (!appId) {
    if (!query) return { ok: false, error: 'Give a name, appId or path to launch.' };
    const list = await appsList({ limit: 300 });
    if (!list.ok) return list;
    const match = matchApp(appCache.apps || [], query);
    if (!match.exact) {
      if (match.matches.length) {
        return {
          ok: false,
          error: `"${query}" matches ${match.matches.length} apps: ${match.matches
            .slice(0, 8)
            .map((a) => a.name)
            .join(', ')}. Give a more exact name.`,
          apps: match.matches.slice(0, 12),
        };
      }
      return { ok: false, error: `No installed app matches "${query}". Run app_list to see names.` };
    }
    appId = match.exact.appId;
    appName = match.exact.name;
  }
  if (/[\u0000-\u001f]/.test(appId) || appId.length > 400) return { ok: false, error: 'That app id is not valid.' };
  try {
    const child = spawn('explorer.exe', [`shell:AppsFolder\\${appId}`], { detached: true, stdio: 'ignore', windowsHide: false });
    child.unref();
  } catch (err) {
    return { ok: false, error: `Windows could not launch that app: ${err && err.message ? err.message : String(err)}` };
  }
  return { ok: true, output: `Launched ${appName}. Use window_list to confirm its window and screen_capture to see it.`, app: { name: appName, appId } };
}

async function screenFind(args = {}) {
  const text = String(args.text || args.query || '').trim();
  if (!text) return { ok: false, error: 'Give the text to find on screen.' };
  if (text.length > 200) return { ok: false, error: 'Search text is limited to 200 characters.' };
  const exact = args.exact === true;
  const source = ['auto', 'uia', 'ocr'].includes(String(args.source)) ? String(args.source) : 'auto';
  const limit = Math.min(Math.max(Math.round(Number(args.limit) || 20), 1), 50);
  let target = null;
  let matches = [];
  let uiError = null;
  let ocrError = null;

  if (source !== 'ocr' && process.platform === 'win32') {
    let handle = args.handle != null && String(args.handle).trim() !== '' ? Number(args.handle) : null;
    if (handle == null) {
      let win = null;
      if (args.window || args.title) {
        const resolved = await resolveWindow(args.window ?? args.title);
        if (resolved.error) uiError = resolved.error;
        else win = resolved.window;
      } else {
        const list = await windowList({ visibleOnly: true, limit: 300 });
        win = (list.windows || []).find((w) => w.foreground) || null;
      }
      if (win) {
        handle = win.hwnd;
        target = { hwnd: win.hwnd, title: win.title, pid: win.pid };
      }
    } else {
      target = { hwnd: Math.round(handle), title: '', pid: null };
    }
    if (handle != null) {
      const tree = await uiTree({
        handle,
        depth: Math.min(Math.max(Math.round(Number(args.depth) || 6), 1), 12),
        max: Math.min(Math.max(Math.round(Number(args.max) || 600), 10), MAX_UIA_NODES),
      });
      if (tree.ok) {
        matches = matchUiTree(tree.tree, text, exact).map((m) => ({ ...m, handle: Math.round(handle), window: target.title }));
      } else {
        uiError = tree.error;
      }
    }
  }

  let shot = null;
  if ((!matches.length && source !== 'uia') || source === 'ocr') {
    shot = await screenCapture({ display: args.display, region: args.region });
    if (shot.ok) {
      const ocr = await screenOcr({ path: shot.file, lang: args.lang });
      if (ocr.ok) {
        const found = matchOcrLines(ocr.lines, text, exact, shot.origin, shot.offset).map((m) => ({
          ...m,
          handle: target ? target.hwnd : null,
          window: target ? target.title : '',
        }));
        matches = matches.concat(found);
      } else {
        ocrError = ocr.error;
      }
    } else {
      ocrError = shot.error;
    }
  }

  matches = matches.slice(0, limit);
  const where = target && target.title ? ` in "${target.title}"` : ' on screen';
  if (!matches.length) {
    const why = [uiError, ocrError].filter(Boolean).join(' · ');
    return {
      ok: true,
      output: `No visible text${where} matches "${text}".${why ? ` (${why})` : ''}`,
      found: false,
      matches: [],
      target,
    };
  }
  return {
    ok: true,
    output: `Found ${matches.length} match${matches.length === 1 ? '' : 'es'}${where}:\n${matches
      .map((m, i) => `  ${i + 1}. [${Math.round(m.cx)},${Math.round(m.cy)}] (${m.source}) "${m.name}"`)
      .join('\n')}`,
    found: true,
    matches,
    target,
    image: shot ? shot.file : null,
  };
}

async function screenClickText(args = {}) {
  const found = await screenFind({ ...args, limit: Math.max(10, Number(args.limit) || 10) });
  if (!found.ok) return found;
  if (!found.found) return { ...found, ok: false, error: found.output };
  const occurrence = Math.min(Math.max(Math.round(Number(args.occurrence) || 0), 0), found.matches.length - 1);
  const match = found.matches[occurrence];
  if (args.dryRun) {
    return { ok: true, output: `Would click "${match.name}" at ${Math.round(match.cx)},${Math.round(match.cy)} (${match.source}).`, match, method: 'none' };
  }
  if (match.source === 'uia' && match.path && match.handle && args.method !== 'mouse') {
    const action = ['invoke', 'click'].includes(String(args.uiaAction)) ? String(args.uiaAction) : 'click';
    const acted = await uiAction({ handle: match.handle, path: match.path, action });
    if (acted.ok) {
      return { ok: true, output: `Clicked "${match.name}" through UI Automation. ${acted.output}`, match, method: 'uia' };
    }
  }
  const clicked = await mouseClick({ x: Math.round(match.cx), y: Math.round(match.cy), button: args.button || 'left', count: args.count || 1 });
  if (!clicked.ok) return clicked;
  return { ok: true, output: `Clicked "${match.name}" at ${Math.round(match.cx)},${Math.round(match.cy)} with the mouse.`, match, method: 'mouse' };
}

let recorder = null;
let recIpcBound = false;

function bindRecorderIpc(electron) {
  if (recIpcBound) return;
  recIpcBound = true;
  electron.ipcMain.on('orvex:rec-chunk', (_e, chunk) => {
    if (!recorder || !recorder.stream) return;
    try {
      recorder.stream.write(Buffer.from(chunk));
    } catch {
      /* disk may be full; stop will report the file size */
    }
  });
  electron.ipcMain.on('orvex:rec-error', (_e, message) => {
    if (recorder) recorder.error = String(message || 'recorder error').slice(0, 800);
  });
  electron.ipcMain.on('orvex:rec-done', () => {
    if (recorder && recorder.finish) recorder.finish();
  });
}

const RECORDER_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>ORVEX recorder</title></head>
<body style="background:#111;color:#eee;font:12px sans-serif;margin:0;padding:8px">recorder</body>
<script>
const ipcRenderer = { send: (channel, payload) => window.recorderIpc.send(channel, payload) };
const q = new URLSearchParams(location.search);
const sourceId = q.get('source') || '';
const fps = Number(q.get('fps') || 15);
const audioMode = q.get('audio') || 'none';
const bitrate = Number(q.get('bitrate') || 4000000);
(async () => {
  try {
    const video = await navigator.mediaDevices.getUserMedia({
      audio: audioMode === 'system' ? { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId } } : false,
      video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId, maxFrameRate: fps } }
    });
    let stream = video;
    let audioCtx = null;
    if (audioMode === 'mic') {
      const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioCtx = new AudioContext();
      const dest = audioCtx.createMediaStreamDestination();
      audioCtx.createMediaStreamSource(mic).connect(dest);
      stream = new MediaStream([...video.getVideoTracks(), ...dest.stream.getAudioTracks()]);
    }
    const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
      ? 'video/webm;codecs=vp9'
      : (MediaRecorder.isTypeSupported('video/webm;codecs=vp8') ? 'video/webm;codecs=vp8' : 'video/webm');
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bitrate });
    rec.ondataavailable = async (e) => {
      if (!e.data || !e.data.size) return;
      try {
        const buf = await e.data.arrayBuffer();
        ipcRenderer.send('orvex:rec-chunk', new Uint8Array(buf));
      } catch (err) {
        ipcRenderer.send('orvex:rec-error', 'chunk failed: ' + (err && err.message ? err.message : err));
      }
    };
    rec.onerror = (e) => ipcRenderer.send('orvex:rec-error', e.error ? e.error.message : 'MediaRecorder error');
    rec.onstop = () => {
      try { if (audioCtx) audioCtx.close(); } catch (e) {}
      try { stream.getTracks().forEach((t) => t.stop()); } catch (e) {}
      ipcRenderer.send('orvex:rec-done');
    };
    rec.start(1000);
    window.__rec = rec;
    window.__stop = () => { try { rec.stop(); } catch (e) { ipcRenderer.send('orvex:rec-done'); } };
    document.title = 'RECORDING';
  } catch (err) {
    ipcRenderer.send('orvex:rec-error', err && err.message ? err.message : String(err));
  }
})();
</script></html>`;

async function screenRecordStart(args = {}) {
  const electron = electronApi();
  if (!electron) return { ok: false, error: 'Screen recording runs inside the ORVEX desktop app only.' };
  if (recorder) return { ok: false, error: `A recording is already running (${recorder.file}). Stop it first.` };
  const picked = pickDisplay(electron, args.display);
  if (picked.error) return { ok: false, error: picked.error };
  const target = picked.display;
  const sf = target.scaleFactor || 1;

  let sources;
  try {
    sources = await electron.desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: Math.round(target.bounds.width * sf), height: Math.round(target.bounds.height * sf) },
    });
  } catch (err) {
    return { ok: false, error: `Screen recording could not start: ${err && err.message ? err.message : String(err)}` };
  }
  const source = sources.find((s) => String(s.display_id) === String(target.id)) || sources[0];
  if (!source) return { ok: false, error: 'No screen source was available for recording.' };

  const fps = Math.min(Math.max(Math.round(Number(args.fps) || 15), 5), 30);
  const audio = ['none', 'mic', 'system'].includes(String(args.audio || 'none')) ? String(args.audio || 'none') : 'none';
  const bitrate = Math.min(Math.max(Math.round(Number(args.bitrate) || 4000000), 500000), 20000000);
  const dir = path.join(baseDir(), 'recordings');
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, `screen-${new Date().toISOString().replace(/[:.]/g, '-')}.webm`);

  bindRecorderIpc(electron);
  const htmlFile = path.join(baseDir(), 'recorder.html');
  await fsp.writeFile(htmlFile, RECORDER_HTML, 'utf8');

  const win = new electron.BrowserWindow({
    show: false,
    width: 320,
    height: 200,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'recorder-preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  win.setMenuBarVisibility(false);
  try {
    await win.loadFile(htmlFile, {
      query: { source: source.id, fps: String(fps), audio, bitrate: String(bitrate) },
    });
  } catch (err) {
    try {
      win.destroy();
    } catch {
      /* already gone */
    }
    return { ok: false, error: `The recorder page did not load: ${err && err.message ? err.message : String(err)}` };
  }

  const stream = fs.createWriteStream(file);
  const rec = {
    win,
    file,
    stream,
    startedAt: Date.now(),
    error: null,
    finish: null,
    done: null,
    timer: null,
    display: target.id,
  };
  recorder = rec;
  stream.on('error', (err) => {
    rec.error = `Could not write the recording: ${err && err.message ? err.message : err}`;
    void beginFinish(rec);
  });

  for (let i = 0; i < 60; i += 1) {
    if (recorder !== rec) return { ok: false, error: 'The recording window closed before it started.' };
    if (rec.error) {
      recorder = null;
      try {
        stream.end();
        win.destroy();
      } catch {
        /* already gone */
      }
      fsp.rm(file, { force: true }).catch(() => {});
      return { ok: false, error: `Screen recording failed: ${rec.error}` };
    }
    let ready = false;
    try {
      ready = await win.webContents.executeJavaScript('Boolean(window.__rec && window.__rec.state === "recording")');
    } catch {
      /* page still loading */
    }
    if (ready) break;
    await new Promise((r) => setTimeout(r, 150));
    if (i === 59) {
      recorder = null;
      try {
        stream.end();
        win.destroy();
      } catch {
        /* already gone */
      }
      return { ok: false, error: 'The screen recorder did not start in time. Try again, or check that screen capture is allowed.' };
    }
  }

  rec.timer = setTimeout(() => {
    if (recorder === rec) void beginFinish(rec);
  }, MAX_RECORD_MS);
  if (rec.timer.unref) rec.timer.unref();

  return {
    ok: true,
    output: `Recording display id ${target.id} at ${fps} fps${audio !== 'none' ? ` with ${audio} audio` : ', no audio'} to ${file}. Call screen_record_stop when done.`,
    file,
    display: target.id,
    fps,
    audio,
    startedAt: rec.startedAt,
    active: true,
  };
}

/** Single teardown path for manual stop, the max-duration timer and write errors. */
function beginFinish(rec) {
  if (!rec) return Promise.resolve({ ok: false, error: 'No recording is running.' });
  if (rec.done) return rec.done;
  rec.done = new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (rec.timer) clearTimeout(rec.timer);
      if (recorder === rec) recorder = null;
      try {
        rec.win.destroy();
      } catch {
        /* already gone */
      }
      const done = () => {
        let size = 0;
        try {
          size = fs.statSync(rec.file).size;
        } catch {
          /* never created */
        }
        const secs = Math.max(1, Math.round((Date.now() - rec.startedAt) / 1000));
        if (rec.error) {
          resolve({ ok: false, error: `Recording stopped with an error: ${rec.error}` });
          return;
        }
        if (!size) {
          resolve({ ok: false, error: `Recording produced no video data (${rec.file}). Screen capture may be blocked.` });
          return;
        }
        resolve({
          ok: true,
          output: `Recording saved: ${rec.file} (${prettySize(size)}, ${secs}s). Remuxed .webm plays in any modern player.`,
          image: null,
          file: rec.file,
          bytes: size,
          seconds: secs,
          display: rec.display,
          active: false,
        });
      };
      try {
        rec.stream.end(done);
      } catch {
        done();
      }
    };
    rec.finish = finish;
    const force = setTimeout(finish, 20000);
    force.unref?.();
    try {
      rec.win.webContents.executeJavaScript('window.__stop && window.__stop()').catch(() => setTimeout(finish, 800));
    } catch {
      setTimeout(finish, 800);
    }
  });
  return rec.done;
}

async function screenRecordStop() {
  const rec = recorder;
  if (!rec) return { ok: false, error: 'No recording is running.' };
  return await beginFinish(rec);
}

async function screenRecordStatus() {
  if (!recorder) return { ok: true, output: 'No recording is running.', active: false, file: null, seconds: 0, bytes: 0, display: null, error: null };
  const secs = Math.round((Date.now() - recorder.startedAt) / 1000);
  let size = 0;
  try {
    size = fs.statSync(recorder.file).size;
  } catch {
    /* not flushed yet */
  }
  return {
    ok: true,
    output: `Recording ${recorder.file} — ${secs}s so far, ${prettySize(size)} written, display id ${recorder.display}.${recorder.error ? ` Error: ${recorder.error}` : ''}`,
    active: true,
    file: recorder.file,
    seconds: secs,
    bytes: size,
    display: recorder.display,
    error: recorder.error || null,
  };
}

function prettySize(bytes) {
  if (!Number.isFinite(bytes)) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)}${units[i]}`;
}

const definitions = [
  {
    name: 'screen_capture',
    description:
      'Take a real screenshot of the user\'s screen. The image is attached to your next message so you can see it. Use its pixel coordinates with mouse_click / mouse_move, and capture again after actions to see what changed. Supports one display, all displays, or a cropped region.',
    parameters: {
      type: 'object',
      properties: {
        display: { type: 'string', description: 'Display id, 1-based index, or "primary". Defaults to the primary screen.' },
        all: { type: 'boolean', description: 'Capture every connected display as separate images.' },
        region: {
          type: 'object',
          description: 'Optional crop in image pixels: {x,y,width,height}. Coordinates are relative to the chosen display.',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
            width: { type: 'number' },
            height: { type: 'number' },
          },
          required: ['x', 'y', 'width', 'height'],
        },
      },
      required: [],
    },
  },
  {
    name: 'screen_info',
    description:
      'List connected displays, their pixel sizes/origins/scale and the current cursor position. Use before clicking on a multi-monitor setup.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'screen_ocr',
    description:
      'Read text off an image or the current screen with the built-in Windows OCR engine. Returns recognized lines with their screen coordinates. Give path for an existing image, or omit it to OCR the screen (optionally with region).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute image path (PNG/JPG/BMP). Omit to capture the screen first.' },
        region: {
          type: 'object',
          description: 'Optional screen crop {x,y,width,height} when capturing live.',
          properties: { x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' } },
          required: ['x', 'y', 'width', 'height'],
        },
        display: { type: 'string', description: 'Display id or 1-based index for the live capture.' },
        lang: { type: 'string', description: 'BCP-47 language tag, e.g. en-US or ur-PK. Defaults to the Windows user languages.' },
      },
      required: [],
    },
  },
  {
    name: 'ui_tree',
    description:
      'Read the Windows UI Automation tree of a window: names, control types, ids, on-screen rectangles and supported actions. Use this instead of screenshots when precision matters. Paths shown here are accepted by ui_action. Re-reads are served from a 1.5 s snapshot cache; actions clear it.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Part of the window title (or pass handle).' },
        handle: { type: 'number', description: 'Window handle from window_list.' },
        depth: { type: 'number', description: 'How deep to walk, 1-12 (default 4).' },
        max: { type: 'number', description: 'Maximum nodes, 10-1200 (default 300).' },
        interactive: {
          type: 'boolean',
          description: 'Only print elements that can be acted on (buttons, edits, menus, lists…). Much smaller and faster; paths stay valid for ui_action.',
        },
        refresh: { type: 'boolean', description: 'Ignore the snapshot cache and re-read the window.' },
      },
      required: [],
    },
  },
  {
    name: 'ui_action',
    description:
      'Act on an element from ui_tree through UI Automation: invoke, click, set_value, toggle, select, expand, collapse, focus or scroll. It first checks that the element is enabled and reachable, briefly highlights the target, then re-reads its state and only falls back to a pixel diff when the state does not confirm. If a stale path no longer resolves, it retries once by the element’s unique name. The reply says verified, NOT confirmed or visibly changed — when it says NOT confirmed, take a screenshot before assuming it worked.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Part of the window title (or pass handle).' },
        handle: { type: 'number', description: 'Window handle from window_list.' },
        path: { type: 'string', description: 'Element path from ui_tree, e.g. "0/0/2/1". Re-resolved right before the action, so a shifted tree cannot silently hit the wrong control.' },
        match: { type: 'string', description: 'Instead of a path: act on the first element whose name contains this text (case-insensitive).' },
        type: { type: 'string', description: 'Optional control type filter with match, e.g. Button. No spaces.' },
        action: {
          type: 'string',
          description: 'invoke | click | set_value | toggle | select | expand | collapse | focus | scroll',
        },
        value: { type: 'string', description: 'Text for set_value; up/down/left/right for scroll.' },
        force: { type: 'boolean', description: 'Bypass the enabled/off-screen pre-flight check. Only for a control you have seen work.' },
        overlay: { type: 'boolean', description: 'Set false to skip the target highlight (default true).' },
      },
      required: ['action'],
    },
  },
  {
    name: 'ui_wait',
    description:
      'Wait for a UI element to appear, disappear, become enabled or reach a value, instead of guessing with sleeps. Polls UI Automation and returns honestly whether the condition was met inside the timeout.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Part of the window title (or pass handle).' },
        handle: { type: 'number', description: 'Window handle from window_list.' },
        path: { type: 'string', description: 'Element path from ui_tree. Re-resolved on every poll, so it detects a re-created element.' },
        match: { type: 'string', description: 'Text to find in an element name (case-insensitive), when no path is known.' },
        type: { type: 'string', description: 'Optional control type filter with match, e.g. Button. No spaces.' },
        state: { type: 'string', description: 'exists (default) | gone | enabled | value' },
        value: { type: 'string', description: 'Expected text when state is value.' },
        timeoutMs: { type: 'number', description: 'Maximum wait in ms, 200-60000 (default 5000).' },
        intervalMs: { type: 'number', description: 'Poll interval in ms, 50-2000 (default 200).' },
      },
      required: [],
    },
  },
  {
    name: 'ui_sequence',
    description:
      'Run an ordered list of UI Automation steps on one window with per-step verification. Stops at the first failed step and reports exactly which one failed; nothing after it runs. Use this for a known form instead of many separate ui_action calls.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Part of the window title (or pass handle).' },
        handle: { type: 'number', description: 'Window handle from window_list.' },
        steps: {
          type: 'array',
          description: 'Ordered steps, 1-12. Each is {path, action, value}.',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Element path from ui_tree.' },
              match: { type: 'string', description: 'Or target the first element whose name contains this text.' },
              type: { type: 'string', description: 'Optional control type filter with match.' },
              action: { type: 'string' },
              value: { type: 'string' },
            },
            required: ['action'],
          },
        },
        delayMs: { type: 'number', description: 'Pause between steps in ms, 0-5000 (default 80).' },
        overlay: { type: 'boolean', description: 'Set false to skip the target highlight (default true).' },
        force: { type: 'boolean', description: 'Bypass the pre-flight check for every step.' },
      },
      required: ['steps'],
    },
  },
  {
    name: 'mouse_move',
    description: 'Move the real mouse cursor to screen pixel coordinates taken from the latest screen_capture.',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'X in screen pixels' },
        y: { type: 'number', description: 'Y in screen pixels' },
      },
      required: ['x', 'y'],
    },
  },
  {
    name: 'mouse_click',
    description:
      'Click the real mouse at screen pixel coordinates. Use coordinates read from screen_capture. Can double/triple click with count.',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'X in screen pixels' },
        y: { type: 'number', description: 'Y in screen pixels' },
        button: { type: 'string', description: 'left (default), right or middle' },
        count: { type: 'number', description: '1-3 clicks, default 1' },
      },
      required: ['x', 'y'],
    },
  },
  {
    name: 'key_type',
    description:
      'Type text with the real keyboard into whichever window currently has focus. Works for any language and punctuation. Focus the target app first (app_open, shell_exec start, or mouse_click inside it).',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to type (max 2000 characters, \\n presses Enter)' },
      },
      required: ['text'],
    },
  },
  {
    name: 'key_press',
    description:
      'Press one key or a shortcut on the focused window. Examples: ENTER, TAB, ESC, F5, CTRL+S, CTRL+SHIFT+ESC, ALT+TAB, WIN+R, MEDIAPLAY, MEDIANEXT, MEDIAPREV, VOLUMEUP, VOLUMEDOWN, VOLUMEMUTE.',
    parameters: {
      type: 'object',
      properties: {
        keys: { type: 'string', description: 'Key or shortcut, e.g. "CTRL+S"' },
      },
      required: ['keys'],
    },
  },
  {
    name: 'mouse_scroll',
    description:
      'Scroll the real mouse wheel. Positive amount scrolls up, negative scrolls down. Give x/y to scroll at a specific point (recommended).',
    parameters: {
      type: 'object',
      properties: {
        amount: { type: 'number', description: 'Wheel clicks, negative = down (default 3).' },
        x: { type: 'number', description: 'Optional X to place the cursor first.' },
        y: { type: 'number', description: 'Optional Y to place the cursor first.' },
      },
      required: [],
    },
  },
  {
    name: 'mouse_drag',
    description: 'Drag the real mouse from one screen point to another, e.g. for sliders, selections or moving files.',
    parameters: {
      type: 'object',
      properties: {
        fromX: { type: 'number' },
        fromY: { type: 'number' },
        toX: { type: 'number' },
        toY: { type: 'number' },
        button: { type: 'string', description: 'left (default), right or middle' },
        durationMs: { type: 'number', description: 'Drag duration in ms, default 500 (max 5000).' },
      },
      required: ['fromX', 'fromY', 'toX', 'toY'],
    },
  },
  {
    name: 'mouse_down',
    description: 'Press and hold a mouse button at the current cursor position without releasing it (use for drags driven by other tools, e.g. air touch).',
    parameters: {
      type: 'object',
      properties: { button: { type: 'string', description: 'left (default), right or middle' } },
      required: [],
    },
  },
  {
    name: 'mouse_up',
    description: 'Release a mouse button previously held with mouse_down.',
    parameters: {
      type: 'object',
      properties: { button: { type: 'string', description: 'left (default), right or middle' } },
      required: [],
    },
  },
  {
    name: 'wait',
    description: 'Pause for a number of milliseconds so an app or page can finish loading (max 60s).',
    parameters: {
      type: 'object',
      properties: {
        ms: { type: 'number', description: 'Milliseconds to wait (max 60000).' },
        seconds: { type: 'number', description: 'Alternative to ms.' },
      },
      required: [],
    },
  },
  {
    name: 'window_list',
    description: 'List visible windows with their hwnd, pid, title, class, state and rectangle. Use it to find the window to focus or control.',
    parameters: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: 'Only windows whose title or class contains this text.' },
        limit: { type: 'number', description: 'Maximum windows, default 60.' },
      },
      required: [],
    },
  },
  {
    name: 'window_action',
    description: 'Focus, minimize, maximize, restore or close a window by title (part of it) or hwnd. Closing may prompt the app to save.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Part of the window title.' },
        handle: { type: 'number', description: 'Window hwnd from window_list.' },
        action: { type: 'string', description: 'focus | minimize | maximize | restore | close' },
      },
      required: ['action'],
    },
  },
  {
    name: 'app_list',
    description:
      'List apps installed in the Windows Start menu with their exact names and ids. Use it to find the right app before app_launch.',
    parameters: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: 'Only apps whose name contains this text.' },
        limit: { type: 'number', description: 'Rows to return, default 60 (max 300).' },
        force: { type: 'boolean', description: 'Re-scan the Start menu instead of using the 5-minute cache.' },
      },
      required: [],
    },
  },
  {
    name: 'app_launch',
    description:
      'Launch an installed app by Start-menu name or app id, or open a path. Prefer this over shell_exec for opening apps. Needs user approval.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'App name from app_list, e.g. "Notepad".' },
        appId: { type: 'string', description: 'Exact app id from app_list.' },
        path: { type: 'string', description: 'Absolute path to an app, shortcut or document to open.' },
      },
      required: [],
    },
  },
  {
    name: 'screen_find',
    description:
      'Find visible text on screen and return clickable screen coordinates. Searches the foreground (or given) window with UI Automation first, then Windows OCR. Use it when you know the label but not the coordinates.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Visible label or part of it.' },
        window: { type: 'string', description: 'Optional window title to search instead of the foreground window.' },
        handle: { type: 'number', description: 'Optional window hwnd.' },
        source: { type: 'string', description: 'auto (default) | uia | ocr' },
        exact: { type: 'boolean', description: 'Require an exact case-insensitive match.' },
        display: { type: 'string', description: 'Display for the OCR pass.' },
        region: {
          type: 'object',
          description: 'Optional screen crop {x,y,width,height} for OCR.',
          properties: { x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' } },
          required: ['x', 'y', 'width', 'height'],
        },
        lang: { type: 'string', description: 'OCR language tag, e.g. en-US.' },
        limit: { type: 'number', description: 'Maximum matches, default 20.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'screen_click_text',
    description:
      'Find text on screen and click it: UI Automation first, real mouse at the OCR centre as a fallback. Set dryRun to only report where it is.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Visible label to click.' },
        window: { type: 'string', description: 'Optional window title.' },
        handle: { type: 'number', description: 'Optional window hwnd.' },
        source: { type: 'string', description: 'auto (default) | uia | ocr' },
        exact: { type: 'boolean', description: 'Require an exact match.' },
        occurrence: { type: 'number', description: 'Which match to click, 0-based (default 0).' },
        method: { type: 'string', description: 'auto (UIA first) or mouse.' },
        uiaAction: { type: 'string', description: 'click (default) or invoke for UI Automation.' },
        button: { type: 'string', description: 'Mouse button, default left.' },
        count: { type: 'number', description: 'Click count, 1-3.' },
        dryRun: { type: 'boolean', description: 'Report the target without clicking.' },
        display: { type: 'string', description: 'Display for the OCR pass.' },
        region: {
          type: 'object',
          description: 'Optional screen crop for OCR.',
          properties: { x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' } },
          required: ['x', 'y', 'width', 'height'],
        },
      },
      required: ['text'],
    },
  },
  {
    name: 'process_list',
    description: 'List running processes with pid, memory, CPU time and window title. Sort by memory, cpu, name or pid.',
    parameters: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: 'Process name or window title contains this text.' },
        sort: { type: 'string', description: 'memory (default) | cpu | name | pid' },
        limit: { type: 'number', description: 'Rows to show, default 40.' },
      },
      required: [],
    },
  },
  {
    name: 'process_kill',
    description:
      'Stop a running process by pid or by an exact, unique process name. Core Windows processes and ORVEX itself are always refused. This needs user approval.',
    parameters: {
      type: 'object',
      properties: {
        pid: { type: 'number', description: 'Process id from process_list.' },
        name: { type: 'string', description: 'Exact process name, e.g. notepad. Must match exactly one process.' },
      },
      required: [],
    },
  },
  {
    name: 'clipboard_read',
    description: 'Read the current clipboard text (or image, which is saved as a screenshot). Use when the user copied something for you.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'clipboard_write',
    description: 'Put text on the clipboard so the user can paste it anywhere.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to copy.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'screen_record_start',
    description:
      'Start recording a display to a .webm video file. Returns the file path; call screen_record_stop to finish. Optional mic or system audio. Max 10 minutes.',
    parameters: {
      type: 'object',
      properties: {
        display: { type: 'string', description: 'Display id or 1-based index; defaults to primary.' },
        fps: { type: 'number', description: '5-30, default 15.' },
        audio: { type: 'string', description: 'none (default) | mic | system' },
        bitrate: { type: 'number', description: 'Video bitrate, default 4000000.' },
      },
      required: [],
    },
  },
  {
    name: 'screen_record_stop',
    description: 'Stop the running screen recording and finalize the .webm file.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'screen_record_status',
    description: 'Report whether a recording is running, for how long and how many bytes are written.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'system_status',
    description:
      'Report real machine status: host, OS release, CPU/cores, RAM use, uptime, battery/charging, current system volume and display brightness, plus network addresses.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'system_volume',
    description: 'Read or set the Windows system output volume (0-100) and mute state. Changes the real speaker volume.',
    parameters: {
      type: 'object',
      properties: {
        level: { type: 'number', description: '0-100. Omit to only read the current volume.' },
        mute: { type: 'boolean', description: 'true mutes, false unmutes. Omit to leave mute unchanged.' },
      },
      required: [],
    },
  },
  {
    name: 'system_brightness',
    description:
      'Read or set internal-display brightness (0-100) through the Windows WMI brightness API. Desktop monitors may refuse; the tool then reports that honestly.',
    parameters: {
      type: 'object',
      properties: {
        level: { type: 'number', description: '0-100. Omit to only read brightness.' },
      },
      required: [],
    },
  },
  {
    name: 'system_metrics',
    description:
      'Sample live hardware metrics: CPU utilisation, RAM used, disk usage, uptime and GPU utilisation when the driver reports it. GPU is reported unavailable rather than invented.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
];

const handlers = {
  screen_capture: screenCapture,
  screen_info: screenInfo,
  screen_ocr: screenOcr,
  ui_tree: uiTree,
  ui_action: uiAction,
  ui_wait: uiWait,
  ui_sequence: uiSequence,
  mouse_move: mouseMove,
  mouse_click: mouseClick,
  mouse_scroll: mouseScroll,
  mouse_drag: mouseDrag,
  mouse_down: mouseDown,
  mouse_up: mouseUp,
  key_type: keyType,
  key_press: keyPress,
  wait: waitFor,
  window_list: windowList,
  window_action: windowAction,
  app_list: appsList,
  app_launch: appLaunch,
  screen_find: screenFind,
  screen_click_text: screenClickText,
  process_list: processList,
  process_kill: processKill,
  clipboard_read: clipboardRead,
  clipboard_write: clipboardWrite,
  screen_record_start: screenRecordStart,
  screen_record_stop: screenRecordStop,
  screen_record_status: screenRecordStatus,
  system_status: systemStatus,
  system_volume: systemVolume,
  system_brightness: systemBrightness,
  system_metrics: systemMetrics,
};

module.exports = {
  definitions,
  handlers,
  init,
  shutdown,
  appsList,
  appLaunch,
  screenFind,
  screenClickText,
  _internals: {
    matchApp,
    matchUiTree,
    matchOcrLines,
    flattenUiTree,
    isInteractiveNode,
    countInteractive,
    countMatchingNodes,
    findUiNodeByPath,
    formatTree,
    invalidateUiTree,
    clearUiTreeCache: () => uiTreeCache.clear(),
  },
};
