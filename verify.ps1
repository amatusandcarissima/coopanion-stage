# 验证脚本:形象包是否被识别、切换形象、截屏看效果、World 是否挂上
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\verify.ps1
#   ... -File .\verify.ps1 -Figure whale-stage -Shot     # 切形象并截屏
#   ... -File .\verify.ps1 -World stage -Shot            # 看 World 状态并截屏

[CmdletBinding()]
param(
  [string]$Figure = '',
  [string]$World = 'stage',
  [int]$WaitMs = 1500,
  [switch]$Shot
)

$ErrorActionPreference = 'Continue'
$pet = 'http://127.0.0.1:7797'
$console = 'http://127.0.0.1:17788'
$shots = Join-Path $PSScriptRoot '.shots'
New-Item -ItemType Directory -Force -Path $shots | Out-Null

function J($o) { $o | ConvertTo-Json -Depth 8 }

Write-Host "=== 形象包列表 ==="
try {
  $figs = Invoke-RestMethod "$pet/api/figures" -TimeoutSec 5
  $figs | ForEach-Object {
    $nm = if ($_.name.zh) { $_.name.zh } elseif ($_.name.en) { $_.name.en } else { '' }
    "  {0,-16} {1,-10} moves={2} needs={3} vocab={4}" -f $_.id, $nm, ($_.moves | Measure-Object).Count, ($_.needs -join ','), ($_.vocab | Measure-Object).Count
  }
} catch { Write-Warning "宠物服务不可用:$($_.Exception.Message)" }

Write-Host "=== 加载问题(/api/figures/status) ==="
try {
  $st = Invoke-RestMethod "$pet/api/figures/status" -TimeoutSec 5
  "  importable=$($st.importable) max=$($st.max)"
  if ($st.problems.Count -eq 0) { '  (无)' } else { $st.problems | Format-Table -AutoSize | Out-String -Width 160 }
} catch { Write-Warning $_.Exception.Message }

Write-Host "=== 当前 skin ==="
$state = $null
try {
  $state = Invoke-RestMethod "$pet/api/state" -TimeoutSec 5
  "  figure=$($state.skin.figure) scheme=$($state.skin.scheme) scale=$($state.scale) roam=$($state.roam) hideWhenFullscreen=$($state.hideWhenFullscreen)"
} catch { Write-Warning $_.Exception.Message }

if ($Figure -and $state) {
  Write-Host "=== 切换形象 -> $Figure ==="
  $skin = $state.skin
  $skin.figure = $Figure
  try {
    $r = Invoke-RestMethod "$pet/api/skin" -Method Post -Body (J @{ skin = $skin }) -ContentType 'application/json' -TimeoutSec 10
    "  ok=$($r.ok)"
    Start-Sleep -Milliseconds $WaitMs
  } catch { Write-Warning "切换失败:$($_.Exception.Message)" }
}

if ($World) {
  Write-Host "=== World '$World' ==="
  try {
    $w = (Invoke-RestMethod "$console/api/worlds" -TimeoutSec 5).worlds | Where-Object { $_.id -eq $World }
    if (-not $w) { Write-Warning "  未安装/未挂载" }
    else {
      "  status=$($w.status) tools=$($w.tools) env=$(if ($w.envPrompt) { 'yes' } else { 'no' }) lamps=$((($w.lamps | ForEach-Object { "$($_.label):$($_.state)" }) -join ','))"
      try {
        $full = Invoke-RestMethod "$console/api/worlds/$World" -TimeoutSec 5
        "  config: " + (J $full | Out-String -Width 200)
      } catch { }
    }
  } catch { Write-Warning $_.Exception.Message }
}

if ($Shot) {
  $file = Join-Path $shots ("shot-{0:HHmmss}.png" -f (Get-Date))
  Add-Type -AssemblyName System.Windows.Forms, System.Drawing
  $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size)
  $bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Write-Host "截图:$file"
}
