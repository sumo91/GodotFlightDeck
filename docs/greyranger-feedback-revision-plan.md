# GreyRanger 使用反馈修订计划

日期：2026-11-06。输入：GreyRanger `docs/tooling/gdeck-usage-feedback-2026-11-06.md`。

## 第一批：本次实施

1. **F02 有界 MCP 结果**：复用 Verify Result Envelope；独立动作返回明确的结构化结果、执行状态和报告引用。默认文本上限 8 KiB，原始输出保存到权限受限文件，通过按字节分页读取。结构化结果不携带事件历史，不从日志推导产品失败。compact/normal/diagnostic 不改变执行或证据权威。
2. **F01 增量等待**：每个 wait_event 窗口维护游标和累计命中数，保持首步历史、include_history/includeHistory、since: command、动作窗口、where、count_gte 和最终断言语义。先保留完整事件历史；事件存储重构另行设计。
3. **F03/F04 补丁归并**：核对已在仓库中的参数契约修复；归并已验证的异步监督、显式 scenario 最长 7,800 秒（默认 120 秒，其他动作 900 秒），补上服务版本、构建指纹、schema 版本与启动时间。检验取消、超时、断开清理及实际 CLI 二次解析。

## 验收与执行顺序

- 先用旧实现复现响应无结构/过大与等待重复扫描，再修改。
- Node 契约、结果边界、分页完整性、进程生命周期回归。
- 隔离 Godot Editor smoke：JSON 类型、根路径、预览、提交、撤销、显式删除、具名 Verify 与 Unit 报告。
- GreyRanger：临时安装仓库插件及窄回归测试，通过新建 SDK MCP 会话运行仓库服务，先窄测试，再 fast、campaign-expansion 和短持续场景。临时项目改动验证后恢复；所有证据留在忽略的报告目录，摘要写回本文件。
- 不将历史 122 分钟结果充当新版本长测，不将 macOS 清理测试推广为 Windows 认证。

## 第二批：后续修订

- **F05**：退出异常的脱敏诊断线索和阶段耗时；断言通过但退出非零保持 INCONCLUSIVE/unknown。按原目标单独调查历史 gameplay 快照超时。
- **F06**：报告固定模拟步长、墙钟预热/采样、累计模拟时间与倍率，分别标记夹具计量和工具开销。
- **F07**：展示计划指纹、冻结范围和漂移发生阶段/路径类别；保留 plan_drift 判定。
- F01 事件流式落盘和有界索引须另有兼容性方案；持久任务 ID/重连观察仅在有限长调用仍有明确使用障碍时实施。

不改变项目预算、异常帧保留、隔离和 Verdict 标准，不引入自动重试或全局编辑锁。

## 首轮进展与证据（历史）

- 初始核对：仓库 `7727603` 已包含 F03 大部分契约修复；F01/F02 尚未修复；F04 补丁只在本机安装目录。
- 已实施：8 KiB 文本上限、结构化结果、私有日志及按字节分页、增量事件游标、异步监督/7,800 秒 schema、服务身份。归并时额外修复 MCP 生命周期标记绕过 Unit/Verify 绑定初始化，以及 batch `--json` 混入预览提示的问题。
- 红绿：`node --test mcp/result.test.mjs` 在旧版因响应过大失败；GreyRanger 窄 Unit 在旧版为 3/4，新版 4/4、12 断言。相同 1,002 条待检查记录的累计遍历量为 **502,502 → 1,002**；这是事件查询工作量，不是 FPS 收益。
- `npm test --prefix mcp`：最终 **42/42 通过**，涵盖 schema、真实 CLI 解析、分页重组与 SHA256、非 UTF-8 原始字节、非法请求输出边界、退出分层、MCP 取消/断开/超时和拒绝 SIGTERM 的后代清理。补充测试期间曾有一个进程夹具未在原 2 秒观测窗内就绪；现在显式等待 readiness 文件或调用提前结束，启动等待最多 6 秒。项目的游戏预算和场景超时未因此调整。
- `GODOT_BIN=/Applications/Godot.app/Contents/MacOS/Godot npm run test:godot --prefix mcp`：1/1 隔离 Editor smoke 通过，Verify Envelope 与原始报告逐字段相等。
- GreyRanger `fast`：PASSED，2/2 阶段、127/127 单元测试、4,955 断言、0 跳过；包含临时 4 项工具回归。Doctor/scenario/visual/benchmark/export 未配置。49.308 秒，MCP 文本 1,645 字节。
- GreyRanger `campaign-expansion` 首次回归：FAILED / scenario_expectation，7/8 通过；`regional-journey` 夹具的 `chain_complete` 与 `regional_state_persisted` 为 false。保留失败，未改预算或断言。对其 358 条事件进行 356 个前缀窗口的旧扫描/增量扫描计数比较，完全一致；此离线对照不单独证明运行时序无影响。
- GreyRanger `expansion-soak-short`：PASSED；墙钟 152.005 秒、预热 2 秒、正式采样 150.005 秒，保留全部 20,674 个采样帧；2 次战斗、1 次行军、4 次存读档。项目预算通过。1,450 条事件、96,398 字节 stdout 对应 **454 字节 MCP 文本**；stdout/stderr 文件哈希均与响应一致，捕获未截断。此结果不是 900 秒以上或两小时长测认证。
- 旧扫描器对照：使用相同 `campaign-expansion` 请求、seed、profile、夹具、600 秒超时，仅恢复原 `scenario_runner.gd`。**regional-journey 通过**。Unit 中新增的扫描工作量断言按预期失败（502,502 ≠ 1,002），因此对照整体仍为 FAILED / unit_assertion，不能记作整合通过。两轮 Verify MCP Envelope 均与对应 CLI Envelope 完全一致。

## 续轮修订：regional-journey 与整合兼容性

区域旅程的缺失业务事件来自 QA 输入夹具的可靠性问题。原 `click()` 只发按下/抬起，实际鼠标位置可能仍在按钮外；`button()` 无论是否触发 `pressed` 都返回 true。针对真实 Button 的窄夹具，在按下与抬起之间按实际鼠标位置刷新 hover，旧实现出现零次激活但返回成功。修复同步原生/视口指针、发送 motion，并等待本次真实 `pressed` 信号确认；不增加固定等待、不重复点击、不改变玩法与预算。

补充回归还覆盖 disabled 与顶部按钮。第一次整合暴露修订中错误沿用服务面板边界的问题：顶部音频按钮被拒绝。现已改为按按钮实际所属 ScrollContainer 的裁剪区域滚动，顶部按钮直接使用自身位置。原 expanded-commands、原 regional-journey 和窄点击回归均通过。临时 DEBUG-gdeck-claim 插桩已删除；一次插桩错误导致的失败也保留在原始证据中，未作为产品缺陷。

并行工作新增 demo-capture 配置及夹具时，另一轮整合正确得到 INCONCLUSIVE / plan_drift。没有回滚并行工作或关闭漂移检查；改用 GreyRanger 的独立副本，复制前后输入指纹一致。该副本原整合 8 项加点击回归共 **9/9 PASSED**，172.019 秒，123 项项目单元测试、4,943 断言。此结果关闭首轮 F01 的区域旅程整合缺口；最终报告修订后的复验另列。

## 第二批实施情况

- **F05**：固定类别的首条相关错误提示、资源类型与捕获行号；独立的断言完成事实；失败/有错误线索阶段的私有日志、哈希及截断说明。线索标为 diagnostic_only，五类退出/断言夹具保留原有 Verdict 分层。加入快照复制、验证、导入、封装、移除耗时，以及监督进程启动、执行、清理计时；当前 fork 默认 direct 兼容模式只能测子进程总耗时，明确 phaseBreakdownAvailable=false，不能虚构细分时间。阶段同时保存有绑定的子进程计时。
- **F06**：固定步长/实时/未知模式、模拟 delta 累计、探针墙钟预热与采样、模拟/墙钟比率。Godot 消费 --fixed-fps 后不会将其保留在 OS.get_cmdline_args()；实际引擎回归锁住了此问题，改由启动器将真实启动选择作为保留元数据传递。没有元数据时为 unknown。同步夹具 setup、命令分发和探针采样/场景 tick 计时分别披露；不声称测到异步夹具全部开销，场景 tick 包含命令分发。项目采样窗口和游戏倍率不从工具推断。
- **F07**：启动时显示/发送计划、输入、配置和源码指纹及去重后的排除范围；MCP 客户端请求 progress 时收到启动通知。漂移报告包含检测阶段、阶段 ID、变化类别及 original_inputs_only 证据范围。代码依赖、夹具、配置、文档改变触发漂移；排除的生成报告不触发。真实 Godot 夹具在执行期间修改其专用源文件，确认断言通过仍被 plan_drift 拒绝。没有全局编辑锁。

## 续轮验证与交付边界

- Node 回归 **47/47** 通过；真实 Godot/MCP smoke 通过，包含失败 Unit 的日志权限/分类、真实源文件漂移拒绝、固定 FPS 时钟以及原有 Editor 操作。
- GreyRanger 副本：工具窄 Unit **6/6、25 断言**通过；真实点击场景报告 fixed_step_throughput / 60 Hz，点击与禁用/顶部按钮检查通过。
- 最终插件/CLI 修订后的 `campaign-expansion`：**PASSED，9/9**，170.721 秒；129 项单元测试、4,968 断言（包含 6 项/25 断言工具回归）。MCP 文本 4,865 字节，Envelope 与 CLI 报告逐字段一致，初始 progress 指纹与最终报告一致。
- 当前 `gameplay`，保持 **240 秒**设置：**PASSED，16/16**，158.724 秒。历史首场景 `campaign-input` 5.600 秒完成；当前路径不再复现超时。复制 29.859 ms、输入验证 31.954 ms、导入 1,516.146 ms、移除快照 37.653 ms；首场景子进程 5,512.724 ms。这里是当前 14 场景配置，不是 11 月 4 日历史源码的根因证明。
- 最终 `expansion-soak-short`，保持 210 秒超时：**PASSED**。项目墙钟 152.005 秒、预热 2 秒、采样 150.005 秒；20,689 帧全部保留并与 CSV 行数一致，预算通过。P95 14.724 ms、P99 17.659 ms、最大 20.590 ms；2 次战斗、1 次行军、4 次存读档。项目自测控制成本 422.038 ms。工具探针单独报告墙钟 152.715 秒、模拟 349.433 秒和约 2.288 比率，未混淆两者窗口；97,318 字节 stdout 对应 602 字节 MCP 文本。
- 上述整合 0 skipped、0 blocked；Doctor、visual、benchmark、export 未配置。短持续验证来自独立 scenario，不记作已配置 benchmark 或长测认证。
- 文档收尾后的原工作区 `fast`：**PASSED，2/2**，48.912 秒；123 项项目单元测试、4,943 断言，0 skipped/blocked。Doctor/scenario/visual/benchmark/export 未配置。精确结果在 `gdeck-revision2-workspace-fast-response.json`。
- 早期扩展 smoke 把 HOME 放在测试源码目录内，失败时 Godot 日志触发了真实 plan_drift；已把隔离 HOME 移到源码树外，原断言失败恢复为 FAILED。全新验证副本第一次直接 Unit 缺类缓存而不完整；结构化 check 完成导入/缓存准备后窄 Unit 通过。两项属于验证夹具/准备过程，失败记录不当作成功。
- 本轮不放宽预算、超时或异常帧保留规则。事件流式落盘/有界存储、持久任务、900 秒以上新版本长测和 Windows/Linux 清理/导出仍未验收。历史 gameplay 超时须以同名 profile、240 秒设置单列结果；当前配置通过也不等于复原了 11 月 4 日的源码与根因。

原始请求/响应、失败、对照及最终源文件清单在 GreyRanger 忽略的 `.gdeck/reports/gdeck-revision2-*`。`gdeck-revision2-validation-copy.json` 记录初始副本输入，`gdeck-revision2-final-source-manifest.json` 记录本轮源码哈希。归档保持原字节、原项目路径和原执行绑定，不能自动绑定到后续并行编辑后的项目。

上轮结束时，原项目临时扫描器已按原字节恢复；只保留 QA 点击修复、新增点击回归/配置和验证说明。新插件与工具 Unit 留在独立验证副本；没有覆盖并行录制配置/项目设置改动。当时尚未更新全局安装或现有 MCP 会话，也未提交或推送 Git。

## 发布与安装验证

按用户后续授权提交、推送修订，并将已提交源码安装到全局 MCP 目录。保留旧安装完整备份；首次部署包版本为 1.6.5，以 Git 提交和 MCP schema 2 构建指纹标识修订。通过新建的已安装 SDK MCP 会话同步 GreyRanger 插件、运行点击窄回归、fast 与 campaign-expansion，并记录源码与已安装文件哈希。具体部署提交、构建指纹和验证结果续写 GreyRanger 的 `docs/tooling/gdeck-revision-validation-2026-11-06.md`。


## 1.6.6 版本同步

按用户要求将本次反馈修订发布版本升级至 1.6.6。主包、MCP 包和 lockfile、plugin.cfg、插件入口、Editor Bridge、runtime probe、Unit 报告版本及当前版本文档一并同步；旧测试报告与历史补丁的 1.6.5 标识保持其原始事实。全局安装和 GreyRanger 项目插件/配置通过已安装 MCP 的事务更新，安装后版本一致性与 fast 结果记入 GreyRanger 验证文档。
