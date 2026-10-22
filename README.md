# Coopanion 小插件：她自己看视频 / 打字时，自己做动作

给 Coopanion 的桌宠 Coo（鲸鲸）加了两套「她自己」的动作：

1. **看视频**：当她**自己**看视频时（浏览器世界的 `[视频]…播放中` 事件，或用她自己的浏览器打开视频在看），
   她先截图定位视频画面，再**爬上去**（上升/下降是台阶式攀爬，不是平移），坐到画面**左下角或右下角**、
   **脸朝视频中心**看；看完 / 暂停就起身。
2. **打字**：当她**自己**用电脑输入文字时（调 `pet_cua_type` / `pet_cua_key`，或在浏览器里填字），
   **先完整做完动作**（截图定位真实输入框 → 跑过去 → 摆好打字姿势），**之后才开始真正输入**；输入完就起身。

动作是**强制**的：只要她用电脑输入文字或看视频，就必须先做动作，不能跳过，也不能把"打字"和"移动/姿势"穿插。

定位靠 `stage_locate`（先截图、再定位输入框/视频画面，返回可直接照抄的 `pet_move_to` 落点）；
移动靠 `watch` / `type` / `floor` / `near` 四个落点。

> **注意**：用户自己看视频 / 打字时，她**不会**跑过去做动作（那套"对用户做反应"已默认关闭）。

整个实现**零补丁**：不修改 Coopanion 自带的任何文件，应用升级不会被覆盖。它由两个官方支持的扩展点组成：

| 部分 | 这是什么 | 装到哪 |
|---|---|---|
| `world\` → `cortico-world-stage` | **World 扩展**（官方"世界"插件）：系统提示词（教她"自己看/打字时配对做动作"）+ 4 个查询工具（含 `stage_locate` 截图定位）+ 一组插件设置里的可调数值 + 可选（默认关）的"对用户做反应"感知 | `<数据目录>\extensions\` |
| `pack\` → `whale-stage` | **形象包**（figure pack）：复用内置鲸鲸的全部部件，加了"站在任意高度"的能力和新的落点/动作词 | `<数据目录>\home\companion\data\figures\` |

> 数据目录以 `%LOCALAPPDATA%\Coopanion\data-location.json` 里的 `path` 为准（脚本会自动读，找不到时用 `-DataDir` 指定）。
> 注意 figures 的真实扫描根是 `<数据目录>\home\companion\data\figures`（世界上下文的 `dataDir`），
> 不是 `home\companion\figures`——写错地方包不会出现在 `/api/figures` 里。

---

## 一、安装 / 更新 / 卸载

前提：Coopanion 正在运行（控制台在 `http://127.0.0.1:17788`）。

```powershell
cd <本项目目录>
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

脚本做四件事：

1. 把 `pack\` 拷到 `<数据目录>\home\companion\data\figures\whale-stage\`（宠物服务每次列包都重扫，不用重启）；
2. 装 World 扩展：优先调控制台 `POST /api/extensions/install {"path":"...\world"}`；
   **若控制台的 pnpm 因存储位置不一致失败**（`ERR_PNPM_UNEXPECTED_STORE`），自动改走手工 link：
   在 `extensions\package.json` 里加 `"cortico-world-stage": "link:...\world"`，并在
   `extensions\node_modules\` 下建同名目录联接（和官方安装后的目录形状完全一样）；
3. 调 `POST /api/run/restart` 重启应用，等控制台回来；
4. 调 `POST /api/worlds/activation {"id":"stage","enabled":true}` 启用它（不用二次重启），
   最后把形象切到 `whale-stage`（`watch`/`type` 这些落点是形象包自己的，内置 `whale` 没有）。

可选参数：

```powershell
.\install.ps1 -PackOnly     # 只更新形象包（改完动作最常用，不用重启应用）
.\install.ps1 -WorldOnly    # 只更新 World 扩展（会重启应用）
.\install.ps1 -NoSwitch     # 装完不自动切形象
```

**重要：改 World 的 JS 后必须重启应用，不能只重启世界。** 控制台的
`POST /api/worlds/restart` 只是重新 `create()` 世界实例，ESM 模块仍走 Node 的模块缓存，
新代码不会生效；`/api/run/restart` 才会重新加载。改形象包则不用重启，`pet_set {figure:"whale-stage"}`
或重开换装页即可。

**安装依赖**：`world\` 依赖 `koffi`（Win32 FFI）。有网络时 `cd world && npm install`。
离线时把应用自带的这两个目录拷到 `world\node_modules\` 即可（与已有扩展同一 ABI）：

```
<Coopanion 安装目录>\resources\app\node_modules\koffi                    → world\node_modules\koffi
<Coopanion 安装目录>\resources\app\node_modules\@koromix\koffi-win32-x64 → world\node_modules\@koromix\koffi-win32-x64
```

### 卸载 / 还原

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\uninstall.ps1
```

会删掉 `figures\whale-stage`、移除 World 扩展依赖与联接（控制台接口失败时自动改手工）、
把形象切回 `whale`，**不碰**任何自带文件。

### 验证

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\verify.ps1 -World stage -Shot
powershell -NoProfile -ExecutionPolicy Bypass -File .\verify.ps1 -Figure whale-stage -Shot
```

`-Shot` 会把整屏截图写到项目目录下的 `.shots\`（已加入 `.gitignore`）。

---

## 二、怎么用

### 自动（她自己的动作，默认行为）

装好、形象切到 `whale-stage` 后，她会在**自己**做这些事时配上动作（由世界系统提示词驱动，不需要任何感知进程）。规则是**强制**的：核心是「**先定位 → 移动（等它完成）→ 摆姿势 → 才开始做事 → 做完起身**」。

- **她自己输入文字**（调 `pet_cua_type` / `pet_cua_key`，或在浏览器里填字）：
  1. `stage_locate {kind:"input"}` —— 先截图、定位真实输入框（UIA 焦点 → 光标行 → 启发式兜底），返回可照抄的 `suggestion`；
  2. 照抄 `pet_move_to {to:"type", params:[x,y]}` 并**等它返回**（她跑到输入框下沿）；
  3. `pet_act {actions:["打字"]}` 敲爪子；
  4. **以上动作完整做完之后，才**开始真正输入（`pet_cua_type` / `pet_cua_key` / 浏览器填字）；
  5. **输入完 → `pet_act {actions:["起身"]}`（或 `pet_move_to {to:"floor"}`）结束动作**。
- **她自己看视频**（浏览器世界的 `[视频]…播放中` 事件，或她用浏览器打开视频在看）：
  1. `stage_locate {kind:"video"}` 定位视频画面（落点是画面**左下角或右下角**，按屏幕留白自动选一侧）；
  2. 照抄 `pet_move_to {to:"watch", params:[x,y]}` 并**等它返回**（她台阶式**爬上去**，坐到画面角落）；
  3. `pet_act {actions:["坐着看"]}` —— 她**脸朝视频中心**看；
  4. **以上动作完整做完之后，才**开始看；
  5. **看完 / 暂停 / 关掉 → `pet_act {actions:["起身"]}` 结束**。

这些姿势会「保持到下一个动作」：开始做时演一次、结束时 `起身` 一次即可。因为她本人就是动作发起者，
所以**没有"事件→落座 20–35 s"的延迟**——她决定做的那一刻就摆姿势。系统提示词里的硬性规则明确要求：
动作**不允许跳过**、**先做完动作再开始输入/观看**、结束必须起身。

### （可选，默认关）对「用户」的活动做反应

最初那套"检测到**用户**在看视频 / 打字，就跑过去"保留为可选，但两个开关默认关闭：

- `config.json` 里 `worlds.stage.watchEnabled` / `worlds.stage.typingEnabled` 默认 `false`；
- 想开就设成 `true` 并重启应用；事件 `stage.watch` / `stage.typing` / `stage.leave` 仍会按 90 s / 45 s 节流推送。

节流：视频 90 s、打字 45 s 一条（同一段视频内不重复刷）。事件是"通知"不是命令，
模型也可能忽略（她正忙/在和你说话时）；这是官方世界接口的边界，事件文本因此写成"想…就…"。

**实测延迟**（仅指可选的那套"对用户做反应"）：从事件推给模型到她落座完成，约 20–35 s
（取决于模型这一轮的思考时间）。别当成实时跟随。

坐标语义（两个数都是**比例**，和分辨率无关）：

- `x` = 屏幕横向比例，0 = 最左，1 = 最右；
- `y` = 落座面在屏幕高度上的比例，0 = 屏幕最顶，1 = 屏幕最底（她的脚/坐面就在这个高度）。

### 手动（直接指挥她）

在 Coopanion 聊天里说：

- "爬上视频坐着看" → `pet_move_to {to:"watch", params:[0.5, 0.28]}`
- "去输入框那里敲键盘" → `pet_move_to {to:"type", params:[0.5, 0.72]}`
- "下来" → `pet_move_to {to:"floor"}`（回桌面底部）
- "去屏幕左上角待着" → `pet_move_to {to:"near", params:[0.1, 0.5]}`
- 只做动作：`pet_act {actions:["打字"]}`、`["坐着看"]`、`["爬上去"]`、`["起身"]`

形象包自带 4 个新动作词：`爬上去/攀上去`、`坐着看/看视频`（持续）、`打字/敲键盘`（持续）、`站起来/起身`。

### 插件设置（可调数值）

在 Coopanion 的「世界」设置页里，`cortico-world-stage` 有一个配置组，可直接改这些数值（改完即用，
其中 `watchEnabled/typingEnabled` 改动后需重启应用；其余热生效）：

| 设置 | 默认 | 说明 |
|---|---|---|
| `watchEnabled` / `typingEnabled` | 关 / 关 | 「对用户做反应」的总开关（她自己做动作由提示词驱动，不在这两个开关里） |
| `videoCooldownSec` | 90 | 视频事件节流（秒） |
| `typingCooldownSec` | 45 | 打字事件节流（秒） |
| `titleCooldownSec` | 30 | 浏览器标题抖动抑制（秒） |
| `pollMs` | 800 | 采样周期（毫秒） |
| `probePort` | 19388 | 本地探针端口 |
| `screenshot.maxWidth` | 1600 | `stage_locate` 截图最大宽度（像素） |
| `screenshot.quality` | 90 | 截图质量（PNG 暂不生效，预留） |
| `screenshot.format` | png | 截图格式 |

这些值和 `config.json` 里的 `worlds.stage.*` 一一对应；也可以直接改 `config.json`（**必须 UTF-8 无 BOM**）。

### 探针（排查用）

```
GET http://127.0.0.1:19388/probe
```

一次完整采样：前台窗口（标题/进程/矩形）、显示器与舞台尺寸、视频检测（`source` 为 `heuristic`
表示按浏览器窗口推算的估计值）、输入框检测（`source` = `uia` 精确 / `heuristic` 兜底）、
按键脉冲计数、以及 `hideWhenFullscreen` 当前值。日志：`<数据目录>\logs\stage.log`。

---

## 三、原理（为什么这样设计）

```
       她自己要做动作（看视频 / 打字）
              │
              ▼
   ┌─────────────────────────────────────┐
   │  cortico-world-stage (World)        │  系统提示词：先 stage_locate、再过去、做完起身
   │  • stage_locate：截图 + 定位输入框/  │  ── koffi GDI BitBlt 截屏 → 纯 JS PNG
   │    视频画面 → 可照抄的 suggestion    │  ── UIA 焦点元素 / GetGUIThreadInfo 光标行 / 启发式
   │  • stage_status / probe / check     │
   │  • webUi().config：10 个可调数值     │  （插件设置页直接改）
   └───────────────┬─────────────────────┘
                   │ 她照抄 suggestion 调工具
                   ▼
              Coo 的模型 ──工具调用──▶ pet_move_to / pet_act / stage_locate
                   │
                   ▼
   ┌─────────────────────────────────────┐
   │ whale-stage (figure pack)           │  复用内置鲸鲸的 rig（11.2 MB 部件，无新图）
   │  • 可变 "地板" floorY                │  包装 host.bounds() + 变化后调 kitBody.resize()
   │  • moves: watch/type/floor/near     │  收到落点后插值上升（爬屏）、坐下、进入姿势
   │  • 新动作词：爬上/坐着看/打字/起身   │  figure.js 里用现有部件叠出攀爬/敲键盘动作
   └─────────────────────────────────────┘
```

（可选、默认关）另外保留了一套「对用户做反应」的感知：Win32 前台窗口 + UIA 输入框 + 按键脉冲轮询，
命中后 `host.pushEvent` 一条"想…就…"的事件。因为官方没有"世界观察另一个世界工具调用"的钩子，
所以主力路径（她自己做动作）**只能靠她本人发起**，系统提示词负责把「定位→移动→姿势→起身」串起来。

三条关键事实（决定了上面的结构）：

1. **宠物窗口盖住整个工作区**，宠物本体是页面里画的 → "屏幕上任意 (x,y)" 只是舞台坐标，不需要移动窗口。
2. **形象包运行在沙箱 iframe 里**：不能联网、不能读窗口、不能读键盘。所以"看见"的部分必须在
   World 里（Node + koffi/UIA），"移动/摆姿势"的部分必须在形象包里（它有整屏舞台）。
3. **World 不能直接命令宠物，也不能观察另一个世界的工具调用**——官方没有这种钩子（`onCuaAnswer` 只收权限答案，
   不是动作回执）。所以"她自己看视频/打字"这条触发**只能靠她本人（模型）发起**：系统提示词教她
   在看视频/打字的同时配对 `pet_act` 姿势。上面框图里 `host.pushEvent` 那一路是**可选、默认关**的
   "对用户做反应"，不是主力。

---

## 四、文件清单

```
coopanion-stage\
├─ install.ps1            一键安装（含 pnpm 失败时的手工 link 兜底）
├─ uninstall.ps1          卸载/还原
├─ verify.ps1             验证：列形象包、切形象、看 World 状态、截屏
├─ world\                 World 扩展 cortico-world-stage（MIT）
│  ├─ package.json         cortico.kind=world / api 6 / os win32 / deps koffi
│  ├─ describe.json        工具与事件声明（市场用）
│  ├─ ENV_PROMPT.md        给 Coo 的系统提示词（教她怎么用这些事件和落点）
│  ├─ src\index.js         WorldDefinition：采样循环 + 状态机 + 推事件 + 4 个工具
│  ├─ src\win32.js         koffi Win32（前台窗口/进程/显示器/按键状态 + GetGUIThreadInfo 光标行 + GDI BitBlt 截屏，只读）
│  ├─ src\uia.js           常驻 UIA 助手客户端（焦点元素 → 输入框矩形）
│  ├─ src\uia-watch.ps1    UIA 助手本体（PowerShell，每 250 ms 一条 JSON）
│  ├─ src\video.js         视频区域判定（浏览器进程 + 标题关键词 + 全屏/16:9 推算）
│  ├─ src\typing.js        打字状态机（按键脉冲 + UIA 可编辑元素 + 停手判定）
│  ├─ src\keyboard.js      按键上升沿计数（只判断"在敲"，不记录敲了什么）
│  ├─ src\locate.js        stage_locate：截图 + 定位输入框/视频 → suggestion
│  ├─ src\screenshot.js    纯 JS PNG 编码（配合 koffi BitBlt，绕过 PS 截屏被 AMSI 拦）
│  ├─ src\configGroup.js   插件设置页的配置组（world:stage，10 个可调数值）
│  ├─ src\probe.js         本地探针 HTTP 服务（127.0.0.1:19388）
│  └─ test\                node test/probe.js、node test/fake-host.js 自测
├─ tools\
│  └─ preview.mjs          脱机预览姿势/动作词/落点并截图（改动作的主力工具，见 docs\自己拼动作_实操.md）
├─ pack\                  形象包 whale-stage（复用内置 whale 资源）
│  ├─ figure.json          manifest v2 / api 2 / 4 个 moves / 42 个动作词（含示例 bye 挥手告别）
│  ├─ figure.js            包入口：包装 host + 实现 moves + 新姿势/动作
│  ├─ whale.js             内置鲸鲸 figure 的拷贝（只做薄包装）
│  ├─ model.json           鲸鲸的骨骼/贴图定义（原样）
│  └─ tex\ feat\ schemes\ outfits\ thumbs\   鲸鲸的部件（原样）
└─ docs\
   ├─ 自己拼动作_实操.md   ← 想加动作就看这个：参数手册 + 三类模板 + 预览循环（推荐先看）
   ├─ 动作用什么软件做.md   ← 想画新部件/新形象看这个
   └─ shots\               实测截图（看片 / 打字 / 回桌面 / 挥手告别）
```

---

## 五、实测记录（2026-10-22 晚，本机）

| 项 | 结果 |
|---|---|
| 形象包被识别 | `/api/figures` 列出 `whale-stage 大肥鱼·舞台`，`vocab=42`，`/api/figures/status` 无 problems |
| World 挂载 | `status=active`，工具 `stage_status/stage_probe/stage_check/stage_locate`，lamps 全 online |
| 看片（感知链验证，现已默认关） | 在用户的 Edge 打开 B 站 → `kind=video`、`video.source=heuristic`；事件推出后她爬上画面顶沿坐下（`docs/shots/watch-bilibili.png`）——证明"世界→事件→pet_move_to→落座"整链可用 |
| 打字（感知链验证，现已默认关） | 记事本里连续打字 → `typing.active=true`、`source=heuristic`、`fractions={to:'type',xc:0.40,y1:0.58}`；她跑到文本区下沿坐下敲爪子（`docs/shots/typing-notepad.png`） |
| 打字（浏览器输入框） | Edge 地址栏：UIA 报 `type=Edit, editable=true`，精确矩形 468,283 1015×24 → `to=type, x=0.508, y=0.284`（精确路径，不是兜底） |
| 离开 | 停手/切窗口 → `stage.leave`，她走回桌面底部（`docs/shots/leave-back-to-floor.png`） |
| 就地姿势（主力路径） | `坐着看`/`打字`/`起身` 三个词由 `figure.js` 的 `enterPose/exitPose` 实现，preview 工具逐一验证（不依赖上面那套感知，由她本人发起） |
| 截图定位（`stage_locate`） | 工具返回 `{ok,source,rect,fractions,suggestion,...}`；输入框按 UIA 焦点 → caret → 启发式，`suggestion` 可直接照抄（实测 UIA 返回输入框 767,782 657×37 → `params:[0.57,0.76]`）；截图用 koffi GDI BitBlt + 纯 JS PNG（PowerShell `CopyFromScreen` 被本机 AMSI 拦） |
| 爬屏动画（定稿） | 上升/下降走**台阶式攀爬**（每阶前 34% 猛冲一阶、后 66% 停顿，竖直轨迹是台阶不是斜线）+ 左右重心摇摆（`±4.4px` 横向微晃 + `swing 19cos` 甩发/裙/鳍）+ 站立蹬墙腿（`f.sit=0` + 自造 `HIPS/FOOT_Y` 交替抬膝）+ 手臂交替够拉（`armN 62→96` 到脸侧，rig 上限）+ 抬头/低头；常量 `CLIMB_RISE_MS=1200`/`CLIMB_FALL_MS=720`/`CLIMB_STEP_PX=170` 在 `pack\figure.js` 顶部可调；CDP 逐帧验证（`docs/shots/climb-up.png`/`climb-down.png`/`climb-steps.png`） |
| 看视频角落落座 | `stage_locate {kind:"video"}` 按留白选**左下角或右下角**，`suggestion` 用角坐标；`watch` 落座后 `kitBody.place(x, poseX<.5?1:-1)` 翻朝向、视线朝视频中心偏上——左下角坐→朝右/视线右上、右下角坐→朝左/视线左上（`docs/shots/watch-corner-left.png`/`watch-corner-right.png`） |
| 插件设置（可调数值） | `/api/config` 出现 `world:stage` 组（10 个键），设置页可直接调节流/轮询/探针端口/截图参数 |
| 踩过的坑 | ① `figures` 真实路径是 `home\companion\data\figures`；② `extensions\package.json` 写成 UTF-8 **带 BOM** 会让 Core 启动即 `JSON.parse` 失败崩溃循环——必须无 BOM；③ 控制台的 pnpm 装在 `E:\.pnpm-store`，与 `data\pnpm\store` 不一致 → 控制台安装报 `ERR_PNPM_UNEXPECTED_STORE`，改手工链接；④ 世界 JS 改动必须重启**应用**（模块缓存）；⑤ 浏览器标题抖动会让 `stage.watch` 连推两条 → 已加 `video.titleCooldownSec`（默认 15 s） |

截图（`docs\shots\`）：

| 看 B 站时爬到画面角落坐下看 | 记事本打字时坐在文本区下沿 |
|---|---|
| ![](shots/watch-corner-left.png) | ![](shots/typing-notepad.png) |

---

## 六、故障排查

| 现象 | 检查 |
|---|---|
| 形象没变 / 包不生效 | `GET http://127.0.0.1:7797/api/figures/status` 看 `problems`；或跑 `verify.ps1` |
| 她会动但摆不出新动作 | `figure.json` 的 `vocab` 名字里不能有空格/逗号/顿号/全角括号；`manifest`/`api` 必须是整数 2 |
| 事件不触发 | `GET http://127.0.0.1:19388/probe`；看 `<数据目录>\logs\stage.log` 的 `push-event` 行 |
| 打字检测不到 | 探针里看 `keyboard.transitionsLast4s`；若一直 0，说明按键轮询没起来（`win32.available` 也看） |
| 全屏看 B 站时她不见了 | 配置 `worlds.desktop-pet.window.hideWhenFullscreen` 被打开了 → 改回 `false` |
| 事件太吵 | 世界配置的 `video.cooldownSec`（默认 90）/ `typing.cooldownSec`（默认 45） |
| 只在主显示器有效 | v1 只覆盖宠物所在那块屏（宠物窗口本来也只在一张屏上） |
| 装完没反应 | `GET http://127.0.0.1:17788/api/worlds` 里应有 `stage` 且 `status=active`；没有就 `-WorldOnly` 再装一次 |
| 设置页里没有 stage 的数值组 | `GET http://127.0.0.1:17788/api/config` 找 `world:stage`；没有就重启一次应用（世界重新 `create()` 才重新声明 `webUi().config`） |
| `stage_locate` 截图失败/报错 | 截图走 koffi GDI BitBlt，不经过 PowerShell；看 `<数据目录>\logs\stage.log` 里 `locate` 行；确认 `screenshot.maxWidth` 没被设成 0 |
| 应用启动即退出 | `<数据目录>\logs\core.log` 找 `JSON.parse`：多半是某个 JSON 被写成了带 BOM |

---

## 七、想自己加动作？

**先看 [`docs\自己拼动作_实操.md`](docs/自己拼动作_实操.md)** —— 用现有骨架拼动作的完整手册：
参数手册（`armN/armF/headTilt/pitch/swing/face/look` 的实测方向与量级）、三类动作模板
（一次性手势 / 持续姿势 / 新落点）、30 秒预览循环（`node tools\preview.mjs ...`，不打扰桌面上的她）、
八个可直接抄的配方、以及坑清单。包里已经放了一个可运行的示例动作 `bye`（挥手告别），
照它改就是第二个动作。

想**画新部件 / 换形象 / 做逐帧动画**，看 [`docs\动作用什么软件做.md`](docs/动作用什么软件做.md)：
里面写了 Coopanion 的动画模型、该用什么软件画部件（Krita / CSP / PS）、怎么用 Blender 或 AE
烘焙关键帧再回放、怎么用 Aseprite 做逐帧动作，以及一次完整的上线流程和常见坑。

改完动作后跑 `.\install.ps1 -PackOnly` 就生效（改的是 `figure.js` 不用重启；改了 `vocab`/`moves`
之后她不认识新词的话重启一次应用）。
