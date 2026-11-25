# ---- config ----
$Url        = "http://localhost:8000"
$Port       = 8000
$TargetName = "Wacom"      # substring of the monitor's friendly name; falls back to primary if absent
# ----------------

Add-Type -AssemblyName System.Windows.Forms

# start the local server (minimized), serving this folder
Start-Process -FilePath "python" -ArgumentList "-m","http.server","$Port" `
  -WorkingDirectory $PSScriptRoot -WindowStyle Minimized
Start-Sleep -Milliseconds 800

# --- map each screen's GDI name to its friendly name via the CCD display API ---
$map = @{}
try {
  $code = @'
using System;
using System.Runtime.InteropServices;
public static class CCD {
  [StructLayout(LayoutKind.Sequential)] public struct LUID { public uint LowPart; public int HighPart; }
  [StructLayout(LayoutKind.Sequential)] public struct RATIONAL { public uint Num; public uint Den; }
  [StructLayout(LayoutKind.Sequential)] public struct SRC { public LUID adapterId; public uint id; public uint modeIdx; public uint statusFlags; }
  [StructLayout(LayoutKind.Sequential)] public struct TGT { public LUID adapterId; public uint id; public uint modeIdx; public uint outTech; public uint rotation; public uint scaling; public RATIONAL refresh; public uint scanLine; public bool available; public uint statusFlags; }
  [StructLayout(LayoutKind.Sequential)] public struct PATH { public SRC src; public TGT tgt; public uint flags; }
  [StructLayout(LayoutKind.Sequential)] public struct MODE { public uint infoType; public uint id; public LUID adapterId; [MarshalAs(UnmanagedType.ByValArray, SizeConst=48)] public byte[] u; }
  [StructLayout(LayoutKind.Sequential)] public struct HDR { public uint type; public uint size; public LUID adapterId; public uint id; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct TNAME { public HDR header; public uint flags; public uint outTech; public ushort mfg; public ushort prod; public uint conn; [MarshalAs(UnmanagedType.ByValTStr, SizeConst=64)] public string friendly; [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)] public string path; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct SNAME { public HDR header; [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string gdi; }
  [DllImport("user32.dll")] public static extern int GetDisplayConfigBufferSizes(uint f, out uint np, out uint nm);
  [DllImport("user32.dll")] public static extern int QueryDisplayConfig(uint f, ref uint np, [Out] PATH[] pa, ref uint nm, [Out] MODE[] ma, IntPtr topo);
  [DllImport("user32.dll")] public static extern int DisplayConfigGetDeviceInfo(ref TNAME d);
  [DllImport("user32.dll")] public static extern int DisplayConfigGetDeviceInfo(ref SNAME d);
}
'@
  Add-Type -TypeDefinition $code
  $np=0; $nm=0
  [void][CCD]::GetDisplayConfigBufferSizes(2, [ref]$np, [ref]$nm)
  $paths = New-Object 'CCD+PATH[]' $np
  $modes = New-Object 'CCD+MODE[]' $nm
  [void][CCD]::QueryDisplayConfig(2, [ref]$np, $paths, [ref]$nm, $modes, [IntPtr]::Zero)
  for ($i=0; $i -lt $np; $i++) {
    $p = $paths[$i]
    $t = New-Object CCD+TNAME
    $h = $t.header; $h.type = 2; $h.size = [Runtime.InteropServices.Marshal]::SizeOf($t); $h.adapterId = $p.tgt.adapterId; $h.id = $p.tgt.id; $t.header = $h
    [void][CCD]::DisplayConfigGetDeviceInfo([ref]$t)
    $s = New-Object CCD+SNAME
    $h2 = $s.header; $h2.type = 1; $h2.size = [Runtime.InteropServices.Marshal]::SizeOf($s); $h2.adapterId = $p.src.adapterId; $h2.id = $p.src.id; $s.header = $h2
    [void][CCD]::DisplayConfigGetDeviceInfo([ref]$s)
    if ($s.gdi) { $map[$s.gdi] = $t.friendly }
  }
} catch { }

# --- pick the target screen by friendly name, else primary ---
$target = [System.Windows.Forms.Screen]::AllScreens |
  Where-Object { $map[$_.DeviceName] -like "*$TargetName*" } | Select-Object -First 1
if (-not $target) { $target = [System.Windows.Forms.Screen]::PrimaryScreen }
$x = $target.Bounds.X + 40
$y = $target.Bounds.Y + 40

# --- launch a Chromium browser positioned on that screen; else default browser ---
$browser = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LocalAppData\Google\Chrome\Application\chrome.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if ($browser) {
  Start-Process -FilePath $browser -ArgumentList @(
    "--app=$Url", "--new-window",
    "--window-position=$x,$y", "--start-maximized"
  )
} else {
  Start-Process $Url
}