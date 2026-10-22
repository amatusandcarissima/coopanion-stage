# 聚焦元素探测（Windows PowerShell 5.1）。每 250ms 往 stdout 吐一行 UTF-8 JSON：
#   {"t":"focus","ok":true,"hwnd":..,"pid":..,"type":"Edit","value":true,"readonly":false,
#    "text":false,"editable":true,"name":"..","rect":{"x":..,"y":..,"w":..,"h":..},
#    "scale":1,"dpi":96}
# 只读 UI 元素属性，不读取输入内容、不模拟按键、不注入任何东西。
# 任何一次采样失败只吐一行 ok:false，循环永远不退出（Node 侧断了会重启）。
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

try {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
} catch {
  @{ t = 'focus'; ok = $false; error = 'uia-load-failed' } | ConvertTo-Json -Compress | Write-Output
  exit 1
}

$dpiReady = $false
try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class StageDpi {
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hWnd);
}
'@
  $dpiReady = $true
} catch { }

$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$interval = 250

@{ t = 'ready'; ok = $true; script = 'uia-watch'; interval = $interval } | ConvertTo-Json -Compress | Write-Output

while ($true) {
  $payload = $null
  try {
    $el = [System.Windows.Automation.AutomationElement]::FocusedElement
    if ($null -eq $el) {
      $payload = @{ t = 'focus'; ok = $false; reason = 'no-focused-element' }
    } else {
      $cur = $el.Current
      $typeName = ''
      try { $typeName = ([string]$cur.ControlType.ProgrammaticName) -replace '^ControlType\.', '' } catch { }
      if ($null -eq $typeName) { $typeName = '' }

      $hwnd = [Int64]0
      try { $hwnd = [Int64]$cur.NativeWindowHandle } catch { }
      if ($hwnd -eq 0) {
        $node = $el
        $depth = 0
        while ($null -ne $node -and $depth -lt 6) {
          $h = [Int64]0
          try { $h = [Int64]$node.Current.NativeWindowHandle } catch { $h = [Int64]0 }
          if ($h -ne 0) { $hwnd = $h; break }
          try { $node = $walker.GetParent($node) } catch { break }
          $depth = $depth + 1
        }
      }

      $rect = $null
      try {
        $b = $cur.BoundingRectangle
        if ($null -ne $b -and $b.Width -gt 0 -and $b.Height -gt 0 -and -not [double]::IsInfinity($b.Width) -and -not [double]::IsInfinity($b.Height)) {
          $rect = @{
            x = [int][Math]::Round($b.X)
            y = [int][Math]::Round($b.Y)
            w = [int][Math]::Round($b.Width)
            h = [int][Math]::Round($b.Height)
          }
        }
      } catch { }

      $valueOk = $false
      $valueReadOnly = $true
      $textOk = $false
      try {
        $vp = $null
        if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) {
          if ($null -ne $vp) {
            $valueOk = $true
            try { $valueReadOnly = [bool]$vp.Current.IsReadOnly } catch { $valueReadOnly = $true }
          }
        }
      } catch { }
      try {
        $tp = $null
        if ($el.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$tp)) {
          if ($null -ne $tp) { $textOk = $true }
        }
      } catch { }

      $editable = $false
      if ($typeName -eq 'Edit' -or $typeName -eq 'ComboBox') { $editable = $true }
      if ($valueOk -and -not $valueReadOnly) { $editable = $true }

      $name = ''
      try { $name = [string]$cur.Name } catch { $name = '' }
      if ($null -eq $name) { $name = '' }
      $name = ($name -replace '[\u0000-\u001F]', ' ').Trim()
      if ($name.Length -gt 80) { $name = $name.Substring(0, 80) }

      $pidVal = 0
      try { $pidVal = [int]$cur.ProcessId } catch { }

      $dpi = 96
      if ($dpiReady -and $hwnd -ne 0) {
        try {
          $d = [StageDpi]::GetDpiForWindow([IntPtr]$hwnd)
          if ($d -gt 0) { $dpi = [int]$d }
        } catch { $dpi = 96 }
      }
      $scale = [Math]::Round($dpi / 96.0, 4)

      $payload = @{
        t = 'focus'
        ok = $true
        hwnd = $hwnd
        pid = $pidVal
        type = $typeName
        value = $valueOk
        readonly = $valueReadOnly
        text = $textOk
        editable = $editable
        name = $name
        rect = $rect
        scale = $scale
        dpi = $dpi
      }
    }
  } catch {
    $payload = @{ t = 'focus'; ok = $false; error = ($_.Exception.Message) }
  }

  try { $payload | ConvertTo-Json -Compress -Depth 5 | Write-Output } catch { }
  Start-Sleep -Milliseconds $interval
}
