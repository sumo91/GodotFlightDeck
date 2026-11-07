# Godot Flight Deck

Godot Flight Deck 是一个面向自动化开发和 AI 编程代理的本地 Godot 驾驶舱。它统一处理环境诊断、脚本与单元测试、场景流程、运行时截图、视觉回归、性能预算、桌面导出和安全的 Editor 自动化，不需要操作系统屏幕录制或辅助功能权限。

当前版本：`1.6.7`（Fork；详见 `README-FORK.md` / `CHANGELOG-FORK.md`）

首要兼容目标：Godot `4.7`

## 当前状态

当前版本适合真实 Godot 项目的本地开发、提交前回归和内部测试包交付，可作为后续 CI 的执行核心。SpaceIdle 实战项目目前通过 12 阶段完整验证；Flight Deck 自身的 CLI、导出安全、进程清理和真实 Editor Undo/Redo 均有自动化回归覆盖。

它尚不是公开商店发布认证工具：正式签名、公证和平台原生运行矩阵仍未实现，`--publish` 当前是保留但不可用的参数，所有 manifest 都会标记 `publishReady: false`。

## 快速开始

```bash
cd /Users/admin/Documents/PiAgent/Tools/GodotFlightDeck
npm link

gdeck init /path/to/godot-project
gdeck doctor /path/to/godot-project
gdeck evidence-index /path/to/godot-project --json
gdeck check /path/to/godot-project
gdeck capture default /path/to/godot-project
gdeck benchmark default /path/to/godot-project --frames 600
gdeck scenario full-loop /path/to/godot-project
gdeck baseline hangar /path/to/godot-project
gdeck visual-test hangar /path/to/godot-project
gdeck verify /path/to/godot-project
gdeck templates install /path/to/godot-project
gdeck export-init /path/to/godot-project
gdeck export all /path/to/godot-project
gdeck unit /path/to/godot-project --timeout 120
gdeck editor status /path/to/godot-project
gdeck editor tree /path/to/godot-project
gdeck editor set Node/Path property '"value"' /path/to/godot-project
gdeck editor undo /path/to/godot-project
gdeck editor create Parent/Path Label NewLabel /path/to/godot-project
gdeck editor delete Parent/Path/NewLabel /path/to/godot-project
gdeck editor resource-inspect res://resources/ui/theme.tres /path/to/godot-project
gdeck editor batch changes.json /path/to/godot-project --dry-run
```

不使用 `npm link` 也可以直接运行：

```bash
node cli/gdeck.mjs doctor /path/to/godot-project
```

## Pi Agent 集成

仓库同时是一个可安装的 Pi Package，包含结构化 Extension 工具和 `godot-flight-deck` Skill。现有 CLI 仍是唯一执行核心；Extension 只负责可信项目发现、严格参数映射、确认门、安全执行、结果截断和结构化报告，不提供任意命令或参数透传。

本地试运行：

```bash
pi -e ./extensions/godot-flight-deck.ts
```

全局安装本地包：

```bash
pi install /Users/admin/Documents/PiAgent/Tools/GodotFlightDeck
```

只在当前 Godot 项目启用：

```bash
cd /path/to/godot-project
pi install -l /Users/admin/Documents/PiAgent/Tools/GodotFlightDeck
```

安装后 Agent 可使用：

- `gdeck_project`：项目发现、初始化和 doctor
- `gdeck_validate`：check、unit、scenario、baseline、visual、benchmark 和 verify
- `gdeck_release`：模板、导出初始化和内部桌面构建
- `gdeck_editor`：认证 Editor 查询、场景/资源写入、Batch、Undo/Redo 和保存
- `/gdeck-status`、`/gdeck-verify`：供用户直接触发的快捷命令

Extension 只能操作包含 Pi 当前工作目录的可信 Godot 项目。确认策略显式区分 `none`、`generated-write`、`project-write`、`destructive` 和 `host-write` 风险；项目初始化、视觉基准覆盖、模板安装、导出、包含已配置导出阶段的 `verify` 和 Editor 写操作需要独立的 Pi 系统确认，聊天中的文字同意不等于系统授权。确认框使用 Pi 原生倒计时，并说明预检已完成、执行尚未开始以及明确的决定截止时间；默认等待 90 秒，可通过可信项目配置将其限制在 5–120 秒。无 UI、拒绝、超时或未知策略均拒绝执行且不会自动重试。

`generated-write`（原子替换项目声明的生成构建路径）和普通 `project-write` 默认使用 120 秒的内存 approval lease，包括内部 `export`、包含配置导出的 `verify`、`init`、`export-init` 以及非删除的常规 Editor 写操作。lease 只在已确认操作成功后创建，精确绑定当前真实项目路径、tool family/action 和规范化 effect scope（例如导出目标或 Editor 节点/属性/值）；失败会撤销已复用的 lease，session 结束也会全部清除。项目可将其配置为 `0` 完全禁用。视觉基准、节点/资源删除、committed batch、stale Editor-session 清理等 `destructive` 操作，以及模板安装这类 `host-write` 永不使用 lease。一次 `verify` 对内部 Verification Plan 声明的全部导出影响只显示一个聚合确认；确认和 lease scope 均绑定该 Plan 的语义与目标路径。确认后若配置、测试发现、scenario、baseline、fixture adapter 或导出目的地使 Plan 发生变化，执行会在启动前中止并要求重新预检。`gdeck_editor batch` 默认只执行 dry-run，只有显式设置 `commit: true` 并确认后才提交。Extension 不暴露正式发布参数。验证报告保存在项目 `.gdeck/reports/`；Pi 的第一次结果始终先返回有界 Result Envelope，再返回兼容的、仅使用结构化证据的 failure-first 摘要。Envelope 给出 profile/legacy 策略、`PASSED` / `FAILED` / `INCONCLUSIVE` / `CANCELLED` Verdict、完整 coverage、决定性阶段、证据优先的 failure classification、可得的 expected/actual、产物路径和确定性下一步；Pi 不把可能含 fixture/save/token 的 verify 原始输出复制进第一次结果，而是写入权限受限的完整日志并明确给出路径。非 verify 命令的日志若被截断，也会明确披露并给出完整日志路径。失败的 unit、scenario 和 verify 都会在处理非零退出码前读取精确报告。

## MCP 集成

Codex、ZCode 等 MCP 客户端可以通过 `mcp/server.mjs` 使用六组 `gdeck_*` 工具。
依赖安装、连接重启和回归测试命令见 [MCP server 文档](mcp/README.md)。

## 命令

CLI、Pi Tool Schema、参数白名单、确认策略与帮助信息共享 `registry/commands.mjs` 中的声明式契约。CLI 会在解析阶段拒绝未知选项或用于错误命令的已知选项，并列出当前命令允许的参数；只有 `gdeck run ... -- <game arguments>` 允许任意游戏参数透传。

可以用机器可读方式检查某个命令的当前契约：

```bash
gdeck describe scenario --json
gdeck describe editor --json
```

`describe` 会报告 usage、选项、嵌套 action、对应 Pi Tool action 和确认策略。`--publish` 仍只是 CLI 中主动拒绝的保留参数，永远不会出现在 Pi Tool Schema 中。

### `gdeck init`

- 将运行时探针安装至 `addons/flight_deck/`
- 在 `project.godot` 注册 `FlightDeckProbe` 自动加载
- 创建 `.gdeck/config.json`
- 将生成的截图和报告加入 `.gitignore`

该命令可以重复执行，用于升级已安装的探针。Addon 会先写入同文件系统 staging、校验版本后再原子替换；项目级排他锁和持久化 journal 可在进程中断后的下一次 Init 恢复未完成的 Addon swap，配置、`project.godot`、`.gitignore` 和 token 也纳入带并发修改检测的回滚快照。托管文件使用临时文件、flush/fsync 与 rename 提交并保留 POSIX mode；平台特有 ACL/xattr 不作为跨平台保证。升级失败会恢复旧 Addon 与托管文件；Init 不会删除它无法证明已失效的 Editor session 元数据，过期会话应通过显式的 `editor cleanup-sessions` 安全清理。若 Init 进程被外部强制终止，锁会故意保留并阻止自动重入；确认原进程已退出后删除项目根的 `.gdeck-init.lock`，下一次 Init 会校验带 HMAC 与目录树指纹的 journal、恢复中断的 swap，再重新执行升级。若项目已在 Editor 中打开，必须重启 Editor 后才能继续 Bridge 写操作。

### `gdeck doctor`

检查 Godot 路径和版本、工具配置、探针安装、自动加载、Export Templates 与 Git 状态。除了兼容的 `checks[]`，Doctor 还输出独立 `capabilities[]`：Godot process、项目元数据、runtime integration、import、Unit、Scenario、Visual、Benchmark、Editor read/write、desktop export 和 native smoke 分别标记为 `available`、`degraded`、`unavailable` 或 `not_probed`，并列出 supporting check、decisive probe、可用子集和缺失条件。只有实际决定性 probe 支持时才会标记 `available`；静态前置条件齐全但未实际运行的 Unit/import/Export 保持 `not_probed`。缺少 Editor 或 Export 能力不会污染无关 headless capability，且不存在模糊的全局 `ready` 布尔值。Pi 对完整 schema、known ID、supporting check、decisive probe 和可信项目绑定重新验证后，只显示固定 reason code 与脱敏 capability projection，不回显 Doctor 原始 stdout/stderr。普通诊断退出码 1 可携带该结构化事实返回；124/125/127 仍分别保持 timeout、cleanup timeout 和 process-spawn failure，不能伪装成成功。

Editor 集成会分别报告 addon 安装、插件启用、项目级 session 元数据和实时 Bridge 可用性，并区分版本不匹配、认证失败、其他项目以及连接失败。Editor 关闭时仅警告；若 `gdeck init` 发生在 Editor 已打开之后，会明确提示重启 Editor 或手动启用插件。Bridge 写请求同时由 CLI 预检和服务端 `client_version` 握手保护，旧版本实例不能执行新版写操作。若配置端口已被占用，插件会在有界的后续端口范围中选择当前 session 端口，并通过实例独占的 `.gdeck/editor-session-<instance>.json` 告知 CLI；不会把 token 写入 session 文件。同一项目出现多个存活 session 时，写操作会失败关闭，直到只保留一个 Editor 实例。

### `gdeck evidence-index`

以零 Godot、零确认、零写入方式有界扫描当前项目的 verification evidence：

```bash
gdeck evidence-index /path/to/project --json
```

Final Report 与 incomplete Journal 分开投影；Freshness 只使用历史 `evidenceBinding` 中的 Profile、output、timeout、resolver contract、Plan digest 和输入字节指纹重建为 `current`、`stale` 或 `unverifiable`。它不依赖 mtime、分支名或“最近一次通过”，不从 stage count 推导 Verdict，也只建议显式的新 invocation 或检查前置条件。symlink、transplant、未知 schema、hash/sequence drift、扫描 mutation 或文件数/字节/时间超限均 fail closed 为 `unverifiable`。

### `gdeck check`

使用 Godot headless editor 导入项目并检查 GDScript。出现解析错误或引擎错误时返回非零状态码。

### `gdeck capture`

通过游戏 Viewport 截图，不依赖系统截图：

```bash
gdeck capture hangar /path/to/project --frames 30 --output /tmp/hangar.png
```

Capture 在输出目录内创建独立临时文件，核对本次 PNG 与成功报告后才原子替换最终图片。引擎失败、超时、缺图或报告不匹配时保留已有图片，不把它作为本次成果；成功报告中的 `capture` 指向发布后的路径。

### `gdeck benchmark`

运行指定帧数并输出 JSON 性能报告：

```bash
gdeck benchmark processing /path/to/project --frames 1200 --warmup 60
```

`--frames` 表示稳定测量窗口，预热帧不计入这些指标；profile 可用 `benchmarkWarmupFrames` 设置默认预热帧数。报告同时记录预热、稳定和总帧数，并在 `performance_timing` 中保留最多 32 个确定性稀疏帧事实及 8 个最慢帧事实，便于区分持续退化与孤立尖峰；这些事实不自动丢弃 outlier、不触发重试，也不改变项目声明的预算策略。`static_memory_bytes` 是报告结束时 Godot `Performance.MEMORY_STATIC` 的快照，按 1 MiB = 1,048,576 bytes 评估预算，不是操作系统进程 RSS，也不是峰值内存。

### `gdeck scenario`

执行项目内的 JSON 场景脚本，支持输入注入、等待语义事件、项目命令与事件断言，并可临时覆盖场景 JSON 中声明的 profile：

```bash
gdeck scenario full-loop /path/to/project
gdeck scenario full-loop /path/to/project --profile smoke
```

场景文件默认位于 `qa/scenarios/`：

```json
{
  "name": "smoke-loop",
  "timeoutFrames": 1200,
  "steps": [
    { "press": "ui_accept", "frames": 2 },
    { "wait_event": "scene_changed", "where": { "scene": "game" } },
    { "command": "complete_test_objective" }
  ],
  "assertions": [
    { "event": "objective_completed", "count_gte": 1 }
  ]
}
```

游戏可以通过 `FlightDeckProbe.event()` 发布语义事件，并监听 `command_requested` 实现安全、明确的项目测试命令。若场景的第一个步骤是 `wait_event`，它可以匹配 Runner 启动前已产生的初始化事件；后续等待仍只匹配各自步骤或前置动作窗口中的新事件，避免误用陈旧事件。等待超时时，`scenario.failure_details` 会记录当前事件窗口、窗口内匹配数，以及窗口前满足同一事件名和 `where` 条件的精确匹配；旧匹配详情最多返回 10 条，嵌套集合和字符串也会截断，避免诊断无限增长。

项目或隔离测试适配器还可以通过 `FlightDeckProbe.state("travel", {"request_id": "travel-1", "ok": true})` 声明当前状态。每个名字只保留最后一次调用的深拷贝；普通游戏运行时探针未激活，此调用不记录状态。`wait_state` 按 `where` 的字段匹配最新快照，没有该状态时继续等待，超时判为声明的期望未满足。

```json
{
  "wait_state": "travel",
  "where": { "request_id": "travel-1", "ok": true },
  "fail_where": { "request_id": "travel-1", "ok": false },
  "timeout_frames": 600
}
```

`wait_event` 同样支持可选的 `fail_where`，匹配同名事件且沿用原有事件窗口和增量游标。两个条件独立匹配；异步请求应在成功与失败条件中都写同一个请求 ID。一次更新同时满足成功和失败条件时，失败优先，并立即释放测试持有的按键和鼠标。没有 `fail_where` 的旧用例保持原语义。`wait_state` 检查当前状态，不使用事件历史或 `since`；需要保证属于本次操作时，用请求 ID 区分。

### 同次运行 A/B 截图

在场景已就绪的 Scenario 中加入 `capture_ab` 步骤，通过原有 `gdeck_validate(action="scenario", name="…", project="…")` 调用：

```json
{
  "capture_ab": {
    "name": "player-locator",
    "changes": [{ "path": "HUD/PlayerLocator", "property": "visible", "value": false }]
  }
}
```

`path` 相对于当前主场景。A 使用当前属性，B 使用声明的值。探针在同一游戏进程内暂停场景树、禁用节点处理，等待完整渲染后依次截取 A、B 和恢复原属性后的还原图，然后恢复节点处理模式与原暂停状态。测试持有的输入会先释放；不会保存场景或资源文件。

支持的临时视觉属性：

- CanvasItem：`visible`、`modulate`、`self_modulate`（颜色为四个 0–1 数值）。Node3D：`visible`。
- Camera3D：`position`、`rotation_degrees`（三维数组）、`fov`、`size`。
- Camera2D：`position`、`offset`、`zoom`（二维数组，zoom 必须为正）。

运行 profile 必须声明隔离的 `fixtureAdapter`；每个场景最多四组对照，每组最多八项改动，主视口最多 8,388,608 像素。用一个改动开始，便于解释画面差异。

只有整次场景运行成功、五张图片的尺寸与哈希正确，才把整组目录发布到 `.gdeck/captures/`。每组提供 `a.png`、`b.png`、`restored.png`、`side_by_side.png`（左 A、右 B）、`diff.png` 和 `comparison.json`。报告记录属性改动、游戏进程 ID、探针帧、像素差异比例与恢复检查；MCP/Pi 和 Verify 返回有界摘要及产物路径。旧产物不会被覆盖，超时和取消沿用原有进程清理机制。

可比性检查覆盖节点集合与处理模式、主视口、当前相机的非目标属性和已声明的语义状态；还原图必须与 A 逐像素一致。项目还可在测试适配器实现只读的 `gdeck_capture_state() -> String`，返回待保护游戏状态的稳定摘要（非空且不超过 4096 字符），例如单位位置、模拟时间与项目 RNG 状态的 JSON 哈希。每个截图阶段都会重新读取并比较它。

暂停节点不能冻结所有外部回调、网络或 shader TIME；工具不自动回滚整个游戏或全局 RNG。检测到状态漂移、还原图变化或发布失败时返回 `INCONCLUSIVE`，不发布对照图。图片差异本身不是失败判据，`PASSED` 表示场景步骤与断言完成，不代表画面已被批准。截图与图像处理的耗时也会进入场景墙钟计时；性能预算应使用不含截图步骤的场景。

### `gdeck baseline` 与 `gdeck visual-test`

建立可提交到项目仓库的视觉基准，并在后续修改中自动比较：

```bash
gdeck baseline hangar /path/to/project
gdeck visual-test hangar /path/to/project
```

视觉测试会生成当前截图、JSON 指标和差异热图。默认逐像素阈值为 5%，允许变化像素比例为 0.1%：

```bash
gdeck visual-test hangar /path/to/project \
  --threshold 0.05 \
  --tolerance 0.001
```

基准图保存在 `qa/baselines/` 并应提交 Git；实际截图、热图和报告保存在 `.gdeck/`，默认忽略。

### `gdeck templates` 与 `gdeck export`

检测并安装与当前 Godot 精确匹配的官方导出模板：

```bash
gdeck templates status /path/to/project
gdeck templates install /path/to/project
```

安装过程会从 Godot 官方 GitHub Release 获取模板、校验可用的 SHA-256，并安装到 Godot 标准目录。

初始化桌面导出预设并构建：

```bash
gdeck export-init /path/to/project
gdeck export macos /path/to/project
gdeck export windows /path/to/project
gdeck export linux /path/to/project
gdeck export all /path/to/project
```

导出目标也可以加入 `verify.exports`，作为统一验证流水线的一部分。release 导出在临时项目副本中移除 Flight Deck autoload、编辑器插件和 addon，再原子替换专用的产物子目录；项目根目录、越界路径和包含符号链接的路径会被拒绝，共享产物目录会合并后一次提交，源项目配置不会被改写。旧产物不会被当作本次导出，跨平台路径冲突也会使验证失败。

`build/release-manifest.json` 记录产物 hash、size、Git SHA 和 smoke 结果；`verify` 会聚合本次通过验证的所有平台，并重新检查文件存在性、大小、SHA-256 和路径唯一性。macOS 默认仍只做结构 smoke；在 macOS host 上可以通过 `exports.nativeSmoke.macos` 显式启用隔离的原生启动验证：

```json
{
  "exports": {
    "nativeSmoke": {
      "macos": {"enabled": true, "timeoutSeconds": 10}
    }
  }
}
```

启用后，GDeck 会安全解压 `.app`，使用一次性的 HOME/XDG/平台数据目录和最小环境白名单执行 `--headless --quit-after 2`，限制 1–30 秒，并在成功、失败或超时后清理整个启动进程组；启动失败或超时不会替换上一份产物。该隔离用于保护普通用户数据和避免继承调用者凭据，但不是阻止硬编码绝对路径或网络访问的安全沙箱。Windows/Linux 在非对应 host 上仍只做可执行文件与 `.pck` 结构 smoke，不声称原生运行。macOS 普通开发构建使用 ad-hoc 签名；正式签名和公证验证尚未实现，因此所有构建均标记 `publishReady: false`，即使提供签名身份，`--publish` 也会直接失败。

### `gdeck unit`

自动发现 `tests/**/*_test.gd` 并在 Godot Headless 模式运行：

```bash
gdeck unit /path/to/project
gdeck unit /path/to/project --filter economy --verbosity normal
```

测试脚本继承 `FlightDeckTest`，支持布尔、相等、近似值、范围和字典断言。长流程会通过 owner/invocation/output/timeout/runtime-argument 绑定的 schema v2 report 发布有界 case counter；`complete: false` 只是 operational progress，不能产生通过、失败或 assertion evidence，只有原子发布的 `complete: true` 才是 terminal Unit evidence。旧 schema v1 terminal report 保持兼容。`compact`、`normal`、`diagnostic` 只改变有界展示频率和字段；任何模式都不会改变 timeout、oracle 或 raw-output withholding。normal/diagnostic 的 slowest-case 摘要只显示 ordinal、opaque identifier 和 duration。

直接运行 `gdeck unit` 始终严格要求至少执行一个测试；`verify.unit: true` 同样要求测试存在，`false` 明确禁用，未配置时则自动发现测试——若没有 `tests/**/*_test.gd`，报告会将 Unit 阶段标记为 `skipped`，不能据此声称单元测试已通过。

### `gdeck editor`

通过运行中的 Godot Editor 查询或安全修改场景，不依赖 macOS 辅助功能或屏幕录制权限：

```bash
gdeck editor status /path/to/project
gdeck editor sessions /path/to/project --json
gdeck editor cleanup-sessions /path/to/project --json
gdeck editor tree /path/to/project --depth 8 --limit 500
gdeck editor inspect Node/Path /path/to/project
gdeck editor logs /path/to/project --limit 100
```

Bridge 仅监听 `127.0.0.1`，使用项目本地的 256-bit 随机令牌认证。令牌位于 `.gdeck/editor-token`、权限为当前用户只读写，并自动加入 `.gitignore`。`editor sessions` 会列出每个实例的 PID、端口、版本及 `authenticated-live`、`live-unreachable`、`stale-dead`、`invalid-preserved` 或 `unsafe-preserved` 状态。`cleanup-sessions` 需要独立确认，只删除结构有效、同项目、PID 明确不存在且在删除前内容指纹未变化的元数据；存活但不可达、格式损坏、符号链接或并发变化的文件均保留。

写操作默认关闭，需在项目配置中显式设置 `editorBridge.allowWrites: true`：

```bash
gdeck editor set Node/Path text '"新的文本"' /path/to/project
gdeck editor create Parent/Path Label NewLabel /path/to/project
gdeck editor reorder Parent/Path/NewLabel 0 /path/to/project
gdeck editor delete Parent/Path/NewLabel /path/to/project
gdeck editor undo /path/to/project
gdeck editor redo /path/to/project
gdeck editor save /path/to/project
gdeck editor resource-inspect res://resources/ui/theme.tres /path/to/project
gdeck editor resource-create StyleBoxFlat res://resources/ui/new_style.tres /path/to/project
gdeck editor resource-set res://resources/ui/new_style.tres bg_color '"#6652bd"' /path/to/project
gdeck editor resource-assign Node/Path theme res://resources/ui/theme.tres /path/to/project
gdeck editor resource-delete res://resources/ui/new_style.tres /path/to/project
gdeck editor batch changes.json /path/to/project --dry-run
gdeck editor batch changes.json /path/to/project
```

属性写入会验证节点范围、属性可写性及 Variant 类型；节点创建仅允许安全的 UI、2D 和容器类，且不能删除或重排场景根节点。资源操作仅允许配置的 `resourceRoots` 目录和 Theme、StyleBoxFlat、SystemFont、Gradient、Curve、PhysicsMaterial 白名单。属性修改、节点与资源创建、删除、重排和引用都通过 `EditorUndoRedoManager` 注册。`script`、`owner` 和场景路径等敏感属性不可写。

批量事务文件格式：

```json
{
  "name": "Update launch copy",
  "operations": [
    {"action": "set", "path": "Footer/LaunchButton", "property": "text", "value": "开始"},
    {"action": "resource-set", "resource": "res://resources/ui/styles/panel.tres", "property": "corner_radius_top_left", "value": 8},
    {"action": "resource-assign", "path": ".", "property": "theme", "resource": "res://resources/ui/theme.tres"}
  ]
}
```

`--dry-run` 只做完整预检，不修改场景或资源。正式执行会在全部操作通过后一次提交，并注册为单个 Undo/Redo 动作；任何操作校验失败时，整批保持零修改。同一批最多 100 项，且禁止重复写同一目标属性。涉及场景节点的单项操作和批量事务都会进入当前场景的 Undo 历史并标记场景未保存；纯资源事务继续使用插件历史。

### `gdeck verify`

一次执行环境诊断、GDScript 检查、可选的 Headless 单元测试、场景测试、视觉回归、性能预算和配置的桌面导出：

```bash
gdeck verify /path/to/project
# 展示级别只影响 presentation，不进入 Verification Plan
gdeck verify /path/to/project --verbosity normal
```

配置示例：

```json
{
  "verify": {
    "scenarios": ["full-loop"],
    "visuals": ["hangar", "processing"],
    "exports": ["macos", "windows", "linux"],
    "benchmarks": [
      {
        "profile": "processing",
        "frames": 420,
        "budgets": {
          "averageFpsGte": 55,
          "worstProcessMsLte": 50,
          "staticMemoryMbLte": 256
        }
      }
    ]
  }
}
```

验证开始前会只读解析一份内部 Verification Plan；CLI 执行、报告 coverage、Pi 聚合确认和 lease scope 使用同一份事实源。Plan 将每项覆盖标记为 `run`、`skipped`、`not_configured` 或 `blocked` 并记录原因，解析过程中不启动 Godot、不创建目录或报告，也不请求确认。执行获准后，GDeck 会把 Plan 绑定的项目源码和文件型输入复制到隔离临时快照，在资源导入或 unit class cache 需要时先用有界 `--import` 准备缓存、验证源码未变，再封闭为只读；check、unit、scenario、fixture、visual、benchmark 和 export source 只消费该快照；报告、截图及获准导出仍写入原项目声明的生成路径，临时快照在运行结束时删除。Plan 还显式记录 `preparation.godotImportRequired`，使 CLI 与 Pi outer budget 对条件性预处理使用同一事实；该 Plan 仍是内部契约，不新增公共 `plan` 命令；命名 Verification Profile 只通过同一解析入口选择已有 evidence lane。

验证结果聚合为 schema v2 JSON 和 Markdown，可以直接作为 CI 产物或代码评审附件；JSON 以增量字段记录 `verificationProfile`、`verificationPlanDigest`、完整 `coverage`、schema v1 `resultEnvelope` 和 self-contained `evidenceBinding`，既有 `status`、`summary`、阶段字段及退出码保持兼容。每次调用在首次 Plan 解析前获得新的内部 invocation identity；identity 会改变完整 Plan、私有 namespace、stage report 和 Journal 路径，但不会改变 confirmation effects、authorization digest 或 lease scope。

获准且通过最后 fresh-Plan gate 后，Verify 在 `.gdeck/reports/private/evidence/` 下建立权限受限、排他 owner 绑定的 Incremental Evidence Journal。记录通过 immutable copy-on-write 文件、严格 sequence/hash chain 和 no-follow/inode 检查提交；该链只声明 torn write、移植和篡改检测，不声称抵御同一 OS 用户的恶意代码或提供身份认证。Journal 只保存 opaque stage ID、ordinal、counter、结构化终态和 artifact digest，不保存 raw stdout/stderr、环境、fixture/assertion payload。CLI 与 Pi 从该私有时间线投影有界 stage ordinal/total/state/monotonic elapsed 更新；渲染失败不影响 supervisor。Benchmark 进入测量窗口后禁用 heartbeat 和 Journal polling，只等待文件系统 terminal event，避免观测扫描或高频渲染污染预算。正常发布先准备 aggregate bytes、写 Markdown，再提交精确 report-binding record，最后发布权威 JSON；读取方只有在 Journal 与当前 JSON 的路径、bytes、digest、identity 和 `evidenceBinding` 双向匹配时才显示 `sealed`。Journal、seal、Freshness 和 incomplete timeline 永远不生成或升级 Verdict，也不会 resume、跳过 stage 或自动重试。中断时可保留已验证 terminal 与当前 stage start；下一次调用仍生成新 identity 并从第一个选中 stage 重新执行。Evidence retention 采用固定 count/bytes/age 上限；只清理由 Plan 完整枚举并绑定 owner、path、inode 和 digest 的 dead/expired 或同 output 已 sealed namespace。cleanup effect 进入完整 Plan digest 和 `evidenceBinding`，但不进入 confirmation、authorization digest 或 lease scope；无法安全回收 quota 时在首个 stage 前停止。

Envelope Verdict 与兼容 `status` 有意分离：只有项目标准提供合格失败证据时才是 `FAILED`；配置、fixture、报告、进程或前置条件不足为 `INCONCLUSIVE`；确认拒绝、确认超时和显式中止为 `CANCELLED`；没有实际运行证据的全 skipped profile 不能伪装成 `PASSED`。结构化报告优先于显式预检事实，显式预检优先于特殊进程结果；没有资格证据的退出码 1 保持 `unknown`，不会依据日志文本归因于游戏代码。功能、视觉、性能和发布 lane 在 Envelope 中分别汇总；`rerun_same_target` 只描述保留证据的显式动作，并绑定原 Verification Profile、运行时 profile、seed、fixture adapter 与 timeout，不会自动重试或猜测代码修复。

`passed`、`skipped` 和 `failed` 继续分别统计，跳过的 Unit 阶段不会被计作通过；aggregate report 的旧消费者应允许新增可选字段。Unit report 则按版本严格区分：合法 schema v1 是 legacy terminal，schema v2 强制 boolean `complete`，缺失、畸形、owner/output/invocation 不匹配或 incomplete evidence 均不能进入 Verdict。配置多个导出目标时，最终 release manifest 会保留所有通过验证且文件完整性仍匹配的产物。不可变 snapshot 的 Godot import preparation 若在任何 stage 前失败，仍会原子发布 schema v2 JSON 与 Markdown：coverage 保持 `not_attempted`，Verdict 为 `INCONCLUSIVE`，并记录 Plan digest、固定阶段、退出码和生命周期事实。底层 Godot 输出不会复制进首次结果或普通 JSON，而是写入 Plan 绑定、权限为 `0600` 的 invocation evidence namespace 内 `preflight.log` 并作为本地 artifact 引用；私有 process spec、环境和凭据不会持久化。每个 process-backed preflight/stage 默认有 300 秒单调时钟执行预算，可用 `--timeout SECONDS` 调整；嵌套 supervisor 只消费 enclosing deadline 的剩余时间，Pi verify 的有限 outer watchdog 由当前 Plan 的条件性 import、选中阶段和清理余量推导。无法 spawn、执行超时、清理超时和报告发布失败分别保留稳定退出码 `127`、`124`、`125`、`126`，均保持 `INCONCLUSIVE`；TERM/KILL、输出 drain 和 lifecycle registry 会清理 GDeck-owned 的嵌套进程组、fixture HOME、verification snapshot、release/native-smoke staging。输出洪泛会被有界截断并明确披露，不会通过 backpressure 或继承 pipe 延长 deadline。

命名 Verification Profile 位于独立的 `verificationProfiles`，与 capture/scenario/benchmark 使用的运行时 `profiles` 没有同名继承关系：

```json
{
  "verificationProfiles": {
    "fast": { "check": true, "unit": "auto" },
    "gameplay": { "unit": true, "scenarios": ["full-loop"] },
    "visual": { "visuals": "auto" },
    "performance": { "benchmarks": [{ "profile": "processing" }] },
    "release": { "check": true, "unit": true, "exports": ["macos", "windows", "linux"] }
  }
}
```

```bash
gdeck verify /path/to/project --profile gameplay
```

命名 profile 自包含：未声明的 family 为 `not_configured`，不会触发 legacy 自动发现。`unit: "auto"` 会自动发现并在无测试时标记 skipped，`unit: true` 同样自动发现但将缺失测试视为 blocked；scenario 和 visual 只有显式使用 `"auto"` 才自动发现。显式 `false` 或空数组会报告为 skipped，而不是伪装成未配置。未传 `--profile` 时继续严格使用原有 `verify` 配置和自动发现语义。只读 profile 零确认，包含导出的 profile 仍只显示一次绑定 profile、Plan digest 和准确目标路径的聚合确认。

## 项目配置

每个接入项目拥有自己的 `.gdeck/config.json`：

```json
{
  "schemaVersion": 1,
  "flightDeckVersion": "1.6.0",
  "godotPath": "",
  "editorBridge": {
    "host": "127.0.0.1",
    "port": 47835,
    "allowWrites": false,
    "resourceRoots": ["res://resources/"]
  },
  "pi": {
    "confirmationTimeoutSeconds": 90,
    "approvalLeaseSeconds": 120
  },
  "profiles": {
    "default": {
      "description": "Main scene",
      "frames": 30,
      "benchmarkWarmupFrames": 60,
      "seed": 42,
      "fixtureAdapter": "res://tests/fixtures/main_state.gd",
      "userArgs": []
    },
    "processing": {
      "description": "Processing preview",
      "frames": 360,
      "seed": 42,
      "userArgs": ["--preview-processing"]
    }
  }
}
```

`userArgs` 会继续原样传给游戏。具体项目可以使用这些参数进入固定测试状态；fixture adapter 必须通过独立的 `fixtureAdapter` 字段声明，不能藏在 `userArgs` 中。

`fixtureAdapter` 是可选的测试专用 GDScript，只允许位于 `res://tests/` 或 `res://qa/` 下、扩展名为 `.gd`，路径的任一段都不能是符号链接，也不能通过 `..` 越界。脚本必须 `extends Node`；若实现 `gdeck_setup(probe)`，Runtime Probe 会在有效的 Flight Deck capture/scenario/benchmark 运行开始时调用它。每次隔离测试运行还会生成仅在命令参数与环境中同时匹配的一次性 capability；缺失或错误时 adapter fail closed。`gdeck run` 拒绝 passthrough 中保留的 `--gdeck-*` 命名空间，因此普通游戏启动不能借此加载 adapter。启用 adapter 的进程会使用一次性的 HOME、XDG 和平台数据目录，结束后删除，避免读写真实玩家数据；`tests/`、`qa/`、`.gdeck/` 和 Flight Deck addon 仍从 release staging 中排除。

`pi.confirmationTimeoutSeconds` 必须是 5–120 的整数，默认 90 秒。`pi.approvalLeaseSeconds` 默认为 120 秒；设为 `0` 可禁用 lease，启用时必须是 1–300 的整数。lease 仅复用当前 Pi session、同一项目、同一 action 的 `generated-write`/`project-write` 授权，baseline、删除、模板安装及 stale session 清理始终逐次确认；非法值会让需要确认的 Pi 操作 fail closed。

## 架构

- `cli/gdeck.mjs`：零依赖 Node.js CLI
- `cli/result-envelope.mjs`：CLI 与 Pi 共用的有界 evidence-first Verdict、classification 和渲染器
- `registry/commands.mjs`：CLI、Pi Schema、参数与确认策略的单一声明式契约
- `godot/addons/flight_deck/`：可安装 Godot 插件和运行时探针
- `tests/`：CLI、Pi Package、Registry 契约与真实 Godot 回归测试
- `.gdeck/captures/`：项目生成截图，不提交 Git
- `.gdeck/reports/`：项目生成 JSON 报告，不提交 Git

## 安全边界

运行时探针只响应显式的 `--gdeck-*` 参数，正常启动游戏时保持休眠。Editor Bridge 只绑定本机回环地址并要求随机令牌；写入能力默认关闭。Headless Verification Profile 不选择 Editor evidence 时，Doctor 将 Editor 安装/在线状态视为可选且不建立 Bridge 连接；直接 Doctor 和所有 Editor 操作仍严格诊断并 fail closed。开启写入后，场景操作仍受节点范围、属性类型和类白名单约束，资源操作只能访问配置的 `resourceRoots` 且拒绝符号链接逃逸；所有写操作均注册 Undo/Redo。

建议普通项目保持 `editorBridge.allowWrites: false`，只在明确需要 Editor 自动化时临时启用，并优先使用 `--dry-run` 预检批量事务。

## 下一阶段

- CI 工作流、验证产物归档、历史趋势和 macOS/Windows/Linux 原生运行矩阵
- Apple Developer ID、公证、Windows Authenticode 与发布凭据验证
- 多区域遮罩和动态内容忽略规则
- 更丰富的输入轨迹与场景变量断言
