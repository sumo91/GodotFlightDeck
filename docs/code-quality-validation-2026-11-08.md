# 代码质量修订验证记录

日期：2026-11-08（Asia/Shanghai）。对应[修订计划](code-quality-revision-plan-2026-11-08.md)。

R1–R5 已完成本地修订及下述验证。R6 尚未找到实际调用项目，保留公开 Oracle 入口，不能计为迁移完成。未推送、发布或替换全局安装。

## 源码与环境

- 实施基线 `ece9c24`，最终运行代码和测试 `ad5051e`；版本仍为 `1.6.8`。
- macOS 27.0.1（26A434）、Node v24.22.0、Godot `4.7.2.stable.official.ed1daf0bf`。
- Godot 路径：`/Applications/Godot.app/Contents/MacOS/Godot`。
- 最终源码 MCP buildId：`3b237684073dba756e746b5b7df3f4d3020b4e4a83d80a74144fe89ae38910bf`。
- 测试使用临时项目、模拟引擎或隔离 Godot 用户目录；没有使用真实玩家存档。

## 修订与提交

| 项目 | 结果 | 提交 |
| --- | --- | --- |
| R1 性能预算 | 计划校验和指标评估使用同一预算定义，两个帧耗时上限贯通 legacy、named profile 和 Verify | `c1a4849` |
| R3 Pi 写操作 | 确认通过后才给 commit/delete/resource-delete/cleanup-sessions 生成 `--apply`；预览保留 dry-run | `47f216f` |
| R4 watch | 分别处理 stdout/stderr 的跨块和尾行错误；观察窗口结束不能抹掉已检测的错误 | `f671688` |
| R2 直接执行 | 常规 Godot 调用改为共享异步生命周期，保留直启方式，加入有界 TERM/KILL、后代清理与嵌套 deadline | `614a9f8` |
| R5 参数重复 | Pi/MCP 共用纯 argv 转换；授权、schema 校验和临时文件仍由适配层负责 | `1043990` |
| R5 验证职责 | 抽出快照、阶段执行、报告发布、项目配置、文件原子写入等职责；共享模块不导入可执行入口 | `5168bc3` |
| R2 取消遗漏 | 取消导入或阶段后停止后续工作，保留 `CANCELLED`；已有合格断言失败仍保持 `FAILED` | `6ee97b3` |
| 入口补验 | 实际 Pi 回调的授权与取消测试替身、MCP watch 正常观察窗口 | `ad5051e` |

`cli/gdeck.mjs` 从审计时 5,905 行降为 3,678 行；验证编排为独立模块。CLI 静态模块依赖检查未发现环。

相对实施基线：运行代码与配置新增 3,020 行、删除 3,294 行，净减 274 行；测试新增 452 行、删除 1 行，净增 451 行。新增运行依赖为 0。该统计不包含本验证记录与计划文档，也不把搬迁行数作为正确性指标。

## 验证结果

| 检查 | 结果与覆盖 | 证据 |
| --- | --- | --- |
| 默认 Node 回归 | **83/83，通过；0 跳过**。预算、argv、报告、输出截断、启动失败、进程清理、取消、MCP 新会话与 Pi 回调均包含在默认命令中 | [Node 日志](validation/code-quality-2026-11-08/node.log) |
| 真实 Godot 集成 | **2/2，通过；0 跳过**。Editor preview/commit/undo/redo/delete、真实 Unit/Verify、解析失败、计划漂移、渲染 A/B 恢复与产物保留 | [Godot 日志](validation/code-quality-2026-11-08/godot.log) |
| 拆分语义对照 | `1043990` 与拆分后各通过 9 类夹具：成功、断言失败、缺失/损坏/不完整报告、漂移、超时、导入失败、发布失败。8 份已发布报告先校验 receipt 哈希、invocation、Journal 和阶段报告哈希，再比较退出码、Verdict、分类与 coverage，全部一致。发布失败均不遗留 JSON/Markdown 半成品 | [拆分前](validation/code-quality-2026-11-08/parity-before.log)、[拆分后](validation/code-quality-2026-11-08/parity-after.log) |
| 模拟导出 | 拆分前后均 **3/3 通过**：成功 manifest/hash、导出文件篡改拒收、提交期间源文件漂移后恢复旧构建和旧 manifest。仅验证模拟 Windows 文件结构 | [拆分前](validation/code-quality-2026-11-08/export-before.log)、[拆分后](validation/code-quality-2026-11-08/export-after.log) |
| 取消回归 | 明确 readiness 后取消；导入/阶段取消均清理快照，阶段取消不启动下一阶段；不依赖外部 watchdog 救场 | [修复前失败](validation/code-quality-2026-11-08/cancellation-red.log)、[修复后通过](validation/code-quality-2026-11-08/cancellation-green.log) |
| 分发与服务指纹 | `npm pack --dry-run --json` 包含全部 15 个新增运行模块；在隔离源码副本中逐个修改这些模块，每次 buildId 都变化 | [检查记录](validation/code-quality-2026-11-08/buildid-package.log) |
| GreyRanger fast | **PASSED**；GDScript + Unit 两阶段通过，**123 用例 / 4,943 断言**。Doctor、场景、视觉、性能和导出未配置在 fast 中 | [日志](validation/code-quality-2026-11-08/greyranger-fast.log)、[报告副本](validation/code-quality-2026-11-08/quality-fast.json.log) |
| GreyRanger 短场景 | `straight-drive-1x` **passed**；2/2 步骤、2/2 断言。检查匀速与跟随状态；没有评审美术质量或更新基线 | [日志](validation/code-quality-2026-11-08/greyranger-scenario-after-import.log)、[报告副本](validation/code-quality-2026-11-08/quality-scenario.json.log) |

Pi 测试使用实际 `extensions/godot-flight-deck.ts` 注册的工具回调，替换宿主确认与执行出口。同意时启动一次并携带 `--apply`，拒绝、确认超时、无 UI 时零次启动；取消信号传给执行出口并保留取消结果。这是宿主契约测试，不是实际 Pi UI 验收。真实 Godot Editor 写操作由 MCP smoke 验证。

MCP 测试启动当前源码的新 stdio 服务并检查结构化结果。watch 的 CLI 观察窗口不变，外层监督增加 5 秒收尾余量；正常窗口结束退出 0，外层不误报超时。

复现默认命令（仓库根目录）：

```sh
npm test --prefix mcp
GODOT_BIN=/Applications/Godot.app/Contents/MacOS/Godot npm run test:godot --prefix mcp
npm pack --dry-run --json
```

## 项目抽样与失败记录

GreyRanger 固定源码为 `e9f47448b20af963983dff6c2266174ff9d11b63`，通过 `git archive` 创建独立副本，再复制本次源码 addon。原工作区已有 `project.godot` 修改，未包含、未改动。fast 在 `5168bc3` 的正常运行路径通过；之后增加的取消修复由最终 83 项 Node 回归与真实 Godot 套件覆盖，没有重复运行无关的 123 项游戏用例。

短场景第一次在没有 `.godot` 导入缓存的归档副本中直接启动，字体资源和全局类未准备，45 秒到期、没有报告；不计为游戏验收。先对该副本执行有界 `check` 完成导入，再运行相同场景，成功产生报告。保留[首次失败](validation/code-quality-2026-11-08/greyranger-scenario.log)与[导入检查](validation/code-quality-2026-11-08/greyranger-scenario-import.log)。导入检查有隔离副本 Editor Bridge 的启动诊断，不作为 Editor 能力验收；Editor 行为由上面的独立 smoke 覆盖。

开发过程中修正过测试夹具本身：进程 readiness 窗口过短、断言夹具缺少合法 Unit schema/typed failure，以及新测试文本插入位置错误。这些失败不计为产品回归，也没有通过放宽业务预算取绿。取消时继续下一阶段则是实际复现的问题，已单独修复。

本机完整项目抽样目录为 `/private/var/folders/2c/p30_nh2x4xq6gfg_35n45cgc0000gn/T/gdeck-quality-acceptance-52d9b5yi`，包含独立用户目录、报告、Journal 和截图。上述日志/报告副本保存在仓库 `docs/validation/code-quality-2026-11-08/`，沿用 `*.log` 忽略规则，不加入 Git；临时目录可能被系统清理。

## 仍开放的范围

- **R6 消费者迁移未完成。** 搜索 `/Users/chaoliu/Documents/Ai` 的脚本与文档，只找到本工具内的声明与实现；原引入提交 `9196426` 也未提供可确认的调用项目路径。[搜索记录](validation/code-quality-2026-11-08/oracle-search.log)。保留 19 项 Oracle 脚本及公开命令，不猜测所属项目、不删除调用契约。
- Oracle 仍使用原专用同步执行链；常规 Godot 入口的异步生命周期验收不能扩展为该旧业务链已验收。迁移需获得真实项目，然后在其隔离副本验证顺序、失败与超时，再移除兼容实现。
- Windows Agent Shell / PowerShell / cmd、Linux 原生运行、实际 Pi UI 未验证。macOS 的模拟导出不代表 Windows 可运行构建；没有执行真实发布导出、签名或公证。
- 未替换全局安装或重连用户当前 MCP 客户端。现有连接的 version/buildId 不能据此视为已更新。游戏长测、设备性能和视觉基线不属于本次验收。

本地提交只包含本次修订、测试与说明；`docs/missions/` 的既有未跟踪工作保持原状。
