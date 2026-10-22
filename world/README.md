# cortico-world-stage（看片与打字）

让 Coopanion 的鲸鱼娘 Coo 能「坐」到视频画面和输入框上的 World 扩展。

两件事分开：

1. **她自己做事时配对做动作（主要用法）**：她要看视频 / 要用电脑输入文字前，先调 `stage_locate` 截图定位真实的视频画面或输入框，拿到可直接照抄的 `pet_move_to {to:"watch"|"type", params:[x,y]}`，跑过去坐下做姿势；做完必须 `pet_act {actions:["起身"]}` 或回桌面底部。这条路径完全由环境提示词驱动，不需要感知事件。
2. **对用户活动做反应（可选，默认关）**：`watchEnabled` / `typingEnabled` 打开后，你放视频时推 `stage.watch`、你打字时推 `stage.typing`，提示她可以凑过来；你离开时推 `stage.leave`。

世界本身**不直接命令**宠物。它只做两件事：**只读感知**（前台窗口、窗口矩形、聚焦的输入框、截图）和**推事件/给工具结果**；是否真的走过去由模型看到结果后调用形象包的 `pet_move_to` 决定，所以不会出现「世界和模型互相抢控制权」。

## 隐私

- 只读取：前台窗口的标题、类名、进程名、窗口矩形，UI 自动化（UIA）给出的**聚焦元素类型与矩形**，以及 `stage_locate` 时截取的当前屏幕图。
- **不读取、不记录你输入的任何字符**；键盘轮询只统计「可打印键的按下次数」，用于判断「是否在打字」，不取键值内容。
- 截图只保存到本机 `<dataDir>/logs/stage-shots/`（默认只保留最近 20 张，可在设置页调 `screenshot.maxWidth/quality/format`，或把 `screenshot.enabled` 关掉）。
- 所有数据只在本机内存中使用，并写到本机日志（`<dataDir>/logs/stage.log`），**不发往任何服务器**。
- 唯一的外发是本机回环地址上的探针 HTTP（默认 `127.0.0.1:19388`，可关）。

## 坐标契约

宠物窗口是铺满主显示器工作区的一个置顶透明窗，页面像素 == DIP（100% 缩放时 == 屏幕物理像素）。

`pet_move_to` 的 `params: [x, y]`：

- `x` = 屏幕横向比例 `0..1`（0 = 最左，1 = 最右）
- `y` = 落座面/站立高度在**屏幕高度**上的比例 `0..1`（0 = 屏幕顶端，1 = 屏幕底）

四个目标名（形象包 `whale-stage` 侧实现）：`watch`（视频底边左下/右下角，坐着看）、`type`（输入框下边缘，打字动作）、`floor`（桌面底部）、`near`（站到某点）。事件正文里已经算好并写成可以直接照抄的调用。

## 事件格式（稳定，供模型与文档引用）

> 这三个事件是对**用户活动**的反应，默认关闭（`watchEnabled` / `typingEnabled` 默认 `false`）。她自己的看/打字动作走 `stage_locate` + 提示词，不依赖它们。

```
[stage.watch] 用户正在看《<标题>》（播放中）。画面区域比例（估计值） x 0.12–0.88，y 0.30–0.72。想爬上去看就调 pet_move_to {to:"watch", params:[0.50, 0.30]}，然后 pet_act {actions:["sit"]}。不想去就忽略。
[stage.typing] 用户正在「<应用>」的输入框里打字（输入框底边比例 y 0.72，横向中心 0.50，估计值）。想过去做动作就调 pet_move_to {to:"type", params:[0.50, 0.72]}，然后 pet_act {actions:["typepaw"]}。不想去就忽略。
[stage.leave] 视频窗口没了或不再播放。想回桌面底部就调 pet_move_to {to:"floor"}。
```

- 数值一律两位小数；`params` 总是两个数。
- 浏览器窗口里的 16:9 视频区域是**推算**的（没有走 CDP），所以标「估计值」；全屏时矩形是精确的。
- 事件语气是「如果想…」，模型忙的时候允许错过。
- 视频：开播 / 换视频 / 画面区域明显移动时各推一次（冷却 `videoCooldownSec`，换标题用 `titleCooldownSec`）。
- 打字：一次「开始打字」推一次，停止约 2.5 秒后推一次 `stage.leave`，绝不每键一条。

## 工具

| 工具 | 说明 |
| --- | --- |
| `stage_locate` | 截图并定位当前输入框（`kind:"input"`）或视频画面（`kind:"video"`），返回 `rect`、`fractions` 和可直接照抄的 `suggestion`（`pet_move_to {...}`）。视频落点是画面底边左下角或右下角（按屏幕左右留白多的一侧选，相等选左），`fractions` 里同时给出 `cornerLeft` / `cornerRight`。做动作前先调它。 |
| `stage_status` | 当前感知快照：前台窗口、视频/输入框矩形、算好的落点、舞台尺寸、开关状态。 |
| `stage_probe` | 与 `stage_status` 相同的完整采样 JSON（开发者自测用）。 |
| `stage_check` | 只返回 `watchEnabled` / `typingEnabled` / `hideWhenFullscreen` / 全屏视频判断。 |

## 配置

世界配置在 `home/companion/config.json` 的 `worlds.stage` 下；下面是默认值（全部可改）。其中带「设置页」的键同时出现在 WebUI 插件设置页的「看片与打字」分组里（`x-hot:true` 改完即生效）。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `false` | 总开关；由安装脚本/面板打开 |
| `watchEnabled` | `false` | 对「用户看视频」推事件；默认关（她自己看视频的动作由提示词驱动，不依赖它） |
| `typingEnabled` | `false` | 对「用户打字」推事件；默认关 |
| `pollMs` | `800` | 主采样间隔（毫秒），建议 700–1000 |
| `keyPollMs` | `80` | 键盘按下轮询间隔（毫秒） |
| `videoCooldownSec` | `90` | 同一视频重复通报的最短间隔（秒，设置页可调） |
| `typingCooldownSec` | `45` | 两段打字通报之间的最短间隔（秒，设置页可调） |
| `titleCooldownSec` | `30` | 浏览器标题变化后重新通报的冷却（秒，设置页可调） |
| `probePort` | `19388` | 本地只读探针端口（0 = 关闭；设置页可调，改端口需重启世界） |
| `screenshot.enabled` | `true` | `stage_locate` 是否落盘截图（关掉只返回矩形） |
| `screenshot.maxWidth` | `1600` | 截图最大宽度（px，0 = 原尺寸） |
| `screenshot.quality` | `90` | 保留参数：当前 PNG 无损编码，质量暂不生效 |
| `screenshot.format` | `png` | 目前固定 `png`（纯 JS 编码，不依赖 PowerShell/.NET） |
| `screenshot.keep` | `20` | 只保留最近 N 张截图，自动清理 |
| `debug.log` | `true` | 写 `<dataDir>/logs/stage.log`（一行一条 `<ISO 时间戳> <JSON 摘要>`，含每次采样与每个事件全文） |
| `debug.console` | `false` | 同时打到 Core 控制台 |
| `debug.sampleLogSec` | `15` | 每 N 秒写一条采样摘要；0 = 关闭 |
| `probe.enabled` | `true` | 本地只读探针 HTTP |
| `probe.port` | `19388` | 旧键，兼容用；优先读顶层 `probePort` |
| `stage.originX/originY/width/height` | `null` | 舞台覆盖；null = 读主显示器工作区 |
| `stage.screenW/screenH`（或顶层 `screenW/screenH`） | `null` | 舞台尺寸的显式覆盖（Lead 建议项） |
| `stage.scale` | `1` | 显示缩放；100% 时保持 1（见下） |
| `video.browsers` | msedge/chrome/firefox/brave/vivaldi/opera/thorium/zen | 视频网站进程名（另接受 `Chrome_WidgetWin_1` / `MozillaWindowClass` 窗口类） |
| `video.titles` | bilibili/哔哩哔哩/youtube/抖音/douyin/腾讯视频/爱奇艺/netflix | 窗口标题关键词（不区分大小写） |
| `video.excludeTitles` | `[]` | 追加排除的标题子串 |
| `video.chromeTop` / `chromeSide` / `chromeBottom` | `88` / `12` / `0` | 浏览器窗口内容区相对窗口的内缩（DIP），用于推算视频区域 |
| `video.fullscreenCoverage` | `0.9` | 无标题栏且覆盖显示器 ≥ 此比例 → 视为全屏视频 |
| `video.cooldownSec` | `90` | 同一视频重复通报的最短间隔（秒） |
| `video.endGraceMs` | `10000` | 窗口不再匹配多久后算「结束」 |
| `video.rectMoveFrac` | `0.05` | 画面区域移动超过舞台该比例才重新通报 |
| `typing.enabled` | `true` | 打字子开关（与 `typingEnabled` 同时为真才生效） |
| `typing.keyTransitions` | `2` | 至少检测到几次按键按下才认为在打字 |
| `typing.minSessionMs` | `1500` | 会话至少持续多久才推事件 |
| `typing.endIdleMs` | `2500` | 停止按键多久算结束（Lead 要求 2.5s） |
| `typing.focusGraceMs` | `800` | 焦点移开后保留会话的时间 |
| `typing.sessionWindowMs` | `4000` | 统计按键的时间窗 |
| `typing.freshSampleMs` | `2000` | UIA 样本新鲜度上限 |
| `typing.cooldownSec` | `45` | 两次打字通报的最短间隔 |
| `typing.emitEndedMinMs` | `2000` | 会话短于此时长不推结束事件 |
| `typing.fallback` | `true` | UIA 不可用/不报可编辑元素时，用前台窗口底部中间的矩形近似输入框 |
| `pet.hideWhenFullscreen` | `null` | 读到 companion 配置里的 `worlds.desktop-pet.window.hideWhenFullscreen`；可在此强制覆盖 |
| `excludeTitles` | `[]` | 标题命中即当作自身窗口（默认为空；自身窗口靠进程名 `Coopanion.exe` 和标题 `Cortico` 识别，避免误伤提到 Coopanion 的文档窗口） |

## 已知限制 / 注意事项

- **不要开 `worlds.desktop-pet.window.hideWhenFullscreen`**（默认 false）。一旦为 true，用户把视频 F11 全屏时宠物窗口会被 `win.hide()`，此时世界会跳过「爬上去」的通报（`stage_status` 里 `pet.hiddenByFullscreen` 为 true）。
- 本世界运行在 Core 进程里，**故意不调用 `SetProcessDpiAwarenessContext`**（那会改整个进程的 DPI 感知）。坐标按 Windows 交给本进程的虚拟化结果处理；如果显示器缩放不是 100%，把 `stage.scale` 设成实际缩放（例如 1.25），UIA 矩形会按元素自身 DPI 自动换算。
- 没有 CDP：浏览器内的视频区域是 16:9 启发式推算（`chromeTop=88` 是标签栏 + 地址栏的估计高度）；播放/暂停状态检测不到，文本里统一写「播放中」。
- 全屏检测：窗口无 `WS_CAPTION` 且覆盖其显示器 ≥90% 即视为全屏视频。
- 视频网站识别依赖进程名 + 标题关键词，不同站点/浏览器可在配置里补。
- koffi 加载失败时世界仍然挂载，工具返回错误字符串，不会让 Core 崩。
- 如果 `pet_move_to {to:"watch"}` / `{to:"type"}` 报「没执行 / to 不认识」，说明当前形象不是 `whale-stage`：先 `pet_set {figure:"whale-stage"}` 再重试一次。

## 自测

不需要安装进应用：

```bat
rem 只看感知（前台窗口、显示器工作区、空闲时间、按键轮询、UIA 聚焦元素）
node test\probe.js

rem 用假 host 跑世界 ~60 秒，打印所有事件（STAGE_SECONDS 可改时长）
node test\fake-host.js
```

探针 HTTP（世界启用后）：

```bat
curl http://127.0.0.1:19388/probe
```

`stage_status` / `stage_probe` 返回同一份感知 JSON，`stage_check` 只返回开关与全屏隐藏状态；`stage_locate` 额外截图到 `<dataDir>/logs/stage-shots/` 并返回落点。调试日志在 `<dataDir>/logs/stage.log`（每行 `<ISO 时间戳> <JSON 摘要>`，重启不覆盖，>8MB 自动轮转 `.1`）。
