# class-info 验证记录

2026-11-08，基于 GDeck `4d3350b` 的本地改动。结论：**PASSED（macOS / Godot 4.7.2）**，对应[Brief](brief.md)。本记录描述发布前的功能验证；后续安装升级验证见 [1.6.9 发布记录](../../releases/1.6.9.md)。

## 交付行为

新增 `gdeck class-info <class> [project] [--filter TEXT] [--json] [--godot PATH] [--timeout SECONDS]`，接入现有命令发现、引擎选择及异步进程清理机制。返回内置类的方法、参数、类型、默认值、属性、信号、继承与声明归属，以及实际引擎身份。支持成员名过滤，保留过滤前后数量。

查询使用空临时项目，避免加载目标项目脚本、autoload 和扩展；结束后清理。元数据来自 [ClassDB](https://docs.godotengine.org/en/stable/classes/class_classdb.html)，完整性声明限定于它的注册元数据，不包括实例动态生成的 `script`、主题覆盖等属性。方法默认值保留 Variant 类型和 Godot 文本表示；未知类、范围外名称、元数据不全、进程失败和超时不会被当作完整成功。

## GreyRanger 实证

- 使用原项目 `/Users/chaoliu/Documents/Ai/GodotGames/GreyRanger` 的 CLI 查询入口；其 `godotPath` 为空，`GODOT_BIN` 未设置，按现行规则选到 `/Applications/Godot.app/Contents/MacOS/Godot`。
- 引擎自报 `4.7.2-stable (official)`，构建哈希 `ed1daf0bf001b61586d9930840f2f1394092c079`。
- 五类完整查询如下；`Vector2` 和 `NoSuchBuiltin` 正确返回 `class_not_found`、`complete: false`、退出码 1，并说明 ClassDB 查询范围。

| 类 | 方法 | 属性 | 信号 |
| --- | ---: | ---: | ---: |
| Control | 510 | 93 | 29 |
| Resource | 92 | 4 | 4 |
| Node3D | 267 | 31 | 14 |
| Button | 561 | 116 | 33 |
| EditorPlugin | 272 | 14 | 19 |

以 GreyRanger 查询结果作为输入，在同一引擎的隔离项目中实例化前四类，核对真实对象的方法、参数、默认值、返回类型、属性和信号，并执行以下调用：Control 锚点与属性修改、Object 继承的 Variant 元数据方法、Resource 信号连接与触发、Node3D 带 Vector3/bool 默认参数的朝向调用。**9,185 项检查，零失败**。GreyRanger 的 UI 脚本使用 Control，主场景脚本使用 Node3D；本轮没有修改游戏内容。

GreyRanger 的 Git 状态仍仅有原先的 `project.godot` 改动，查询前后相关文件 SHA-256 相同：

- `project.godot`：`fbe46bc3d92c162f62422f19b8e0388fff38c5970e2b11e9cb4349b822fd4e08`
- `.gdeck/config.json`：`ac68220dabfdbdeea2c73b85bc20918cea568cc4651cda4e9f3f5218b49d844b`

## 回归与反例

- `npm test --prefix mcp`：**86/86 通过，0 跳过**。新增用例验证命令契约、文本呈现、配置/环境/显式覆盖的引擎选择优先级、无匹配过滤、元数据缺失、未知/范围外类结果、缺失或损坏报告、引擎错误输出、非零退出、超时、无法启动和临时目录清理。
- `GODOT_BIN=/Applications/Godot.app/Contents/MacOS/Godot npm run test:godot --prefix mcp`：**3/3 通过，0 跳过**，包含新增真实 API 对照、既有 A/B 截图与恢复、既有 MCP/Godot 类型及 Editor 操作集成。
- 新增真实引擎测试使用含故障 autoload 的源项目，查询仍成功且源项目未生成 `.godot`；这验证了查询没有加载该项目代码。项目脚本类和非 ClassDB 内置类型也覆盖了拒绝路径。
- 初始验证夹具将实例动态属性误计入 ClassDB 总量，并在节点进入树之前调用 `look_at`。已通过实际差集确认动态属性来源，分别核对注册属性与实例属性，并在树就绪后执行调用；最终没有放宽 API 一致性断言。

可复用测试：[CLI 与故障路径](../../../mcp/class-info.test.mjs)、[真实引擎对照及 API 调用](../../../mcp/class-info-godot.test.mjs)。用法见 [README](../../../README.md)。

本机原始证据目录：`/Users/chaoliu/.codex/tmp/gdeck-class-info-20261108-6po8x9d6`，包含 `greyranger-evidence.json`、逐类 JSON、`queries.json`、`exercise.gd`、`greyranger-api-exercise.log`、`node-tests.log` 和 `godot-regression.log`。

## 验证范围

本轮验证的是 CLI 能力及其兼容性，没有新增 MCP/Pi 工具接口。未对 Windows/Linux、其他 Godot 版本或真实无调试元数据的发布二进制做认证；元数据缺失的结果处理用受控报告验证。未重跑 GreyRanger 长流程、画面或性能验收，它们不是本次 API 查询变更的交付范围。
