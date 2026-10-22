# 一键安装:形象包 whale-stage + World 扩展 cortico-world-stage
#
# 用法(项目根目录):
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
#   powershell ... -File .\install.ps1 -WorldOnly     # 只装/更新 World 扩展
#   powershell ... -File .\install.ps1 -PackOnly      # 只装/更新形象包
#   powershell ... -File .\install.ps1 -NoSwitch      # 不自动切形象(默认会切到 whale-stage)
#
# 前提:Coopanion 正在运行(控制台 HTTP 服务可用),否则只做文件拷贝。

[CmdletBinding()]
param(
  [switch]$WorldOnly,
  [switch]$PackOnly,
  [switch]$NoSwitch,
  [string]$Console = 'http://127.0.0.1:17788',
  [string]$DataDir = ''
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$worldSrc = Join-Path $root 'world'
$packSrc = Join-Path $root 'pack'
$packId = 'whale-stage'
$worldId = 'stage'

# 应用数据目录:优先读指针文件,没有就用 -DataDir 参数
$ptr = Join-Path $env:LOCALAPPDATA 'Coopanion\data-location.json'
$dataDir = $DataDir
if (-not $dataDir -and (Test-Path $ptr)) {
  try { $dataDir = (Get-Content -Raw $ptr | ConvertFrom-Json).path } catch { }
}
if (-not $dataDir) { throw "找不到 Coopanion 数据目录。请用 -DataDir 指定,或确认 %LOCALAPPDATA%\Coopanion\data-location.json 存在。" }
if (-not (Test-Path $dataDir)) { throw "找不到 Coopanion 数据目录:$dataDir" }
Write-Host "数据目录:$dataDir"

function Api($method, $path, $body) {
  $uri = "$Console$path"
  try {
    if ($body -ne $null) {
      $json = $body | ConvertTo-Json -Depth 8
      return Invoke-RestMethod -Uri $uri -Method $method -Body $json -ContentType 'application/json' -TimeoutSec 30
    }
    return Invoke-RestMethod -Uri $uri -Method $method -TimeoutSec 30
  } catch {
    throw "请求 $method $uri 失败:$($_.Exception.Message)"
  }
}

function Wait-Console([int]$seconds = 120) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    try {
      $r = Invoke-RestMethod -Uri "$Console/api/worlds" -TimeoutSec 3
      if ($null -ne $r) { return $true }
    } catch { Start-Sleep -Milliseconds 800 }
  }
  return $false
}

# ---- 形象包:直接拷进 figures 根目录(宠物服务每次列包都会重扫) ----
if (-not $WorldOnly) {
  if (-not (Test-Path (Join-Path $packSrc 'figure.json'))) { throw "形象包不完整:缺 $packSrc\figure.json" }
  # 真实扫描根是 companion 自己的 data 目录下的 figures\:
  #   <root>\data\home\companion\data\figures  (世界 ctx.dataDir = abs(config.paths.data),默认 "data")
  # 写成 ..\home\companion\figures 宠物服务不会扫描,包不会出现在 /api/figures。
  $figuresDir = Join-Path $dataDir 'home\companion\data\figures'
  $dest = Join-Path $figuresDir $packId
  New-Item -ItemType Directory -Force -Path $figuresDir | Out-Null
  if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
  Copy-Item -Recurse -Force $packSrc $dest
  Write-Host "形象包已安装:$dest"
  try {
    $figs = Invoke-RestMethod -Uri 'http://127.0.0.1:7797/api/figures' -TimeoutSec 5
    $hit = $figs | Where-Object { $_.id -eq $packId }
    if ($hit) { Write-Host "宠物服务已识别:$($hit.id)  ($($hit.name.zh))" }
    else {
      Write-Warning "宠物服务暂未列出 $packId,看看 /api/figures/status 里的 problems:"
      try { (Invoke-RestMethod -Uri 'http://127.0.0.1:7797/api/figures/status' -TimeoutSec 5).problems | Format-Table } catch { }
    }
  } catch { Write-Warning "宠物服务(7797)不可用,跳过校验;形象包已复制。" }
}

# ---- World 扩展:优先走控制台安装接口;失败则手工 link(见 README「安装方式 B」) ----
if (-not $PackOnly) {
  if (-not (Test-Path (Join-Path $worldSrc 'package.json'))) { throw "World 扩展不完整:缺 $worldSrc\package.json" }
  if (-not (Wait-Console 20)) { throw "控制台 $Console 不可达,请先启动 Coopanion(或用 -PackOnly 只装形象包)" }

  $worlds = (Api 'GET' '/api/worlds').worlds
  $before = $worlds | Where-Object { $_.id -eq $worldId }
  if ($before) {
    Write-Host "World '$worldId' 已安装;更新代码后重启应用生效。"
  } else {
    Write-Host "安装 World 扩展:$worldSrc"
    $installed = $false
    try {
      $r = Api 'POST' '/api/extensions/install' @{ path = $worldSrc }
      Write-Host ("安装结果:ok={0} restartRequired={1}" -f $r.ok, $r.restartRequired)
      $installed = [bool]$r.ok
    } catch {
      Write-Warning "控制台安装失败:$($_.Exception.Message)"
    }
    if (-not $installed) {
      # 手工方式:extensions\package.json 里加 link: 依赖 + node_modules 下建 junction。
      # 应用自带的 pnpm 存储位置可能和已有 node_modules 不一致(ERR_PNPM_UNEXPECTED_STORE),
      # 这条手工路径和官方安装后的目录形状完全一样。
      # 注意:package.json 必须写成 UTF-8 **不带 BOM**,否则 Core 启动即 JSON.parse 失败。
      $extDir = Join-Path $dataDir 'extensions'
      $pkgPath = Join-Path $extDir 'package.json'
      if (-not (Test-Path $pkgPath)) { throw "找不到 $pkgPath" }
      $raw = [IO.File]::ReadAllText($pkgPath)
      $spec = 'link:' + $worldSrc
      if ($raw -notmatch [regex]::Escape($spec)) {
        $bak = "$pkgPath.bak-stage"
        if (-not (Test-Path $bak)) { Copy-Item $pkgPath $bak }
        $pkg = $raw | ConvertFrom-Json
        if (-not $pkg.dependencies) { $pkg | Add-Member -NotePropertyName dependencies -NotePropertyValue (@{}) }
        $pkg.dependencies | Add-Member -NotePropertyName 'cortico-world-stage' -NotePropertyValue $spec -Force
        $json = $pkg | ConvertTo-Json -Depth 20
        [IO.File]::WriteAllText($pkgPath, $json, (New-Object System.Text.UTF8Encoding($false)))
        Write-Host "已写入依赖:cortico-world-stage -> $spec"
      }
      $link = Join-Path $extDir 'node_modules\cortico-world-stage'
      if (-not (Test-Path $link)) {
        & cmd /c mklink /J "$link" "$worldSrc" | Out-Null
        Write-Host "已创建目录联接:$link"
      }
      Write-Host "手工安装完成。"
    }
  }

  Write-Host "重启应用(控制台 /api/run/restart)…"
  try { Api 'POST' '/api/run/restart' $null | Out-Null } catch { Write-Warning "重启请求失败:$($_.Exception.Message)" }
  Start-Sleep -Seconds 3
  if (-not (Wait-Console 180)) { throw "重启后 180 秒内控制台没有恢复,请看 $dataDir\logs\core.log" }

  $now = (Api 'GET' '/api/worlds').worlds | Where-Object { $_.id -eq $worldId }
  if (-not $now) { throw "重启后仍没有 World '$worldId';检查 $dataDir\logs\core.log 里的 extensions / world 报错" }
  if ($now.status -ne 'active') {
    Write-Host "激活 World '$worldId'"
    Api 'POST' '/api/worlds/activation' @{ id = $worldId; enabled = $true } | Out-Null
    Start-Sleep -Milliseconds 800
    $now = (Api 'GET' '/api/worlds').worlds | Where-Object { $_.id -eq $worldId }
  }
  Write-Host ("World 状态:status={0} tools={1}" -f $now.status, ($now.tools -join ','))
}

# ---- 把形象切成 whale-stage(等价于 pet_set {figure:"whale-stage"}) ----
# 必须切:watch / type 这些落点是形象包自己的 moves,内置 whale 没有。
# 两个包用的是同一套部件和配色,看起来和原来的鲸鲸一模一样。
if (-not $NoSwitch) {
  try {
    $skin = (Invoke-RestMethod -Uri 'http://127.0.0.1:7797/api/state' -TimeoutSec 5).skin
    $skin = $skin | ConvertTo-Json -Depth 8 | ConvertFrom-Json   # 复制成普通对象
    $skin.figure = $packId
    $body = @{ skin = $skin } | ConvertTo-Json -Depth 8
    Invoke-RestMethod -Uri 'http://127.0.0.1:7797/api/skin' -Method Post -Body $body -ContentType 'application/json' -TimeoutSec 10 | Out-Null
    Write-Host "形象已切换为 $packId"
  } catch { Write-Warning "切换形象失败:$($_.Exception.Message)(也可以让 Coo 用 pet_set {figure:""$packId""})" }
}

Write-Host "完成。"
