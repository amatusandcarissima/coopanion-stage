# 卸载/还原:删掉形象包 whale-stage、卸载 World 扩展、把形象切回 whale
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\uninstall.ps1

[CmdletBinding()]
param([string]$Console = 'http://127.0.0.1:17788', [string]$Figure = 'whale', [string]$World = 'stage', [string]$DataDir = '')

$ErrorActionPreference = 'Continue'
$packId = 'whale-stage'

$ptr = Join-Path $env:LOCALAPPDATA 'Coopanion\data-location.json'
$dataDir = $DataDir
if (-not $dataDir -and (Test-Path $ptr)) { try { $dataDir = (Get-Content -Raw $ptr | ConvertFrom-Json).path } catch { } }
if (-not $dataDir) { throw "找不到 Coopanion 数据目录。请用 -DataDir 指定。" }

# 1) 先把形象切回内置的 whale,免得她穿着要删的包
try {
  $st = Invoke-RestMethod 'http://127.0.0.1:7797/api/state' -TimeoutSec 5
  $skin = $st.skin
  if ($skin.figure -ne $Figure) {
    $skin.figure = $Figure
    Invoke-RestMethod 'http://127.0.0.1:7797/api/skin' -Method Post -Body (ConvertTo-Json @{ skin = $skin } -Depth 8) -ContentType 'application/json' -TimeoutSec 10 | Out-Null
    Write-Host "形象已切回 $Figure"
  }
} catch { Write-Warning "切换形象失败(宠物服务不可用?):$($_.Exception.Message)" }

# 2) 删形象包目录(真实扫描根:data\home\companion\data\figures)
$dest = Join-Path $dataDir "home\companion\data\figures\$packId"
if (Test-Path $dest) { Remove-Item -Recurse -Force $dest; Write-Host "已删除形象包:$dest" }

# 3) 卸载 World 扩展(控制台接口;失败则手工删依赖 + junction)
try {
  $r = Invoke-RestMethod "$Console/api/extensions/uninstall" -Method Post -Body (ConvertTo-Json @{ name = "cortico-world-$World" }) -ContentType 'application/json' -TimeoutSec 120
  Write-Host ("扩展卸载:ok={0} restartRequired={1}" -f $r.ok, $r.restartRequired)
} catch {
  Write-Warning "控制台卸载失败,改用手工方式:$($_.Exception.Message)"
  $extDir = Join-Path $dataDir 'extensions'
  $pkgPath = Join-Path $extDir 'package.json'
  $link = Join-Path $extDir "node_modules\cortico-world-$World"
  if (Test-Path $pkgPath) {
    $raw = [IO.File]::ReadAllText($pkgPath)
    $pkg = $raw | ConvertFrom-Json
    if ($pkg.dependencies -and ($pkg.dependencies.PSObject.Properties.Name -contains "cortico-world-$World")) {
      $pkg.dependencies.PSObject.Properties.Remove("cortico-world-$World")
      $json = $pkg | ConvertTo-Json -Depth 20
      [IO.File]::WriteAllText($pkgPath, $json, (New-Object System.Text.UTF8Encoding($false)))  # 不带 BOM
      Write-Host "已移除依赖:cortico-world-$World"
    }
  }
  if (Test-Path $link) { (Get-Item $link).Delete(); Write-Host "已删除目录联接:$link" }
}
try { Invoke-RestMethod "$Console/api/run/restart" -Method Post -TimeoutSec 15 | Out-Null } catch { }
Write-Host "已请求重启;如果没自动回来,手动重开 Coopanion。"

Write-Host "完成。"
