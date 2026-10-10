# Harness 交互追踪（dsh-harness-trace）

版本：1.0

持续追踪本地 DeepSeek Harness 调用 LLM 的全过程，供开发者研究 harness 与模型的真实交互。
**不依赖任何其他插件**：全部数据来自 Harness 自身的事件契约。

## 追踪了什么

| 内容                           | 来源                                                                          |
| ---------------------------- | --------------------------------------------------------------------------- |
| 完整提示词（发往模型的原始消息、系统提示词、各插件注入） | `llm/stream` 的冻结请求 + `session/event` 的 `system/message`、`developer/message` |
| 提示词由谁贡献（每段出处）                | `system-prompt/assemble`                                                    |
| 用户输入、模型回复、推理过程               | `session/event`                                                             |
| 工具调用与结果（含失败）                 | `session/event` 的 `tool/call`、`tool/result`                                 |
| 本地文件读写                       | 从 `read`/`write`/`edit`/`glob`/`grep` 等工具调用归类并汇总                            |
| 联网搜索与抓取                      | 从 `web_search`/`web_fetch` 归类并汇总                                            |
| 技能加载、命令执行                    | 从 `skill`、`pwsh`/`bash` 等归类并汇总                                              |
| Token 用量与结束原因                | `assistant/message` 的 `usage`、`llm/stream` 的 `finish`                       |

数据按「**轮次 → 步骤**」依时间顺序拼接成一条时间线，并附会话概览、文件访问汇总、联网活动汇总、技能加载汇总。

以下为标签栏内看板示例图![](https://github.com/oihai/dsh-harness-trace/blob/main/images/afgnb.png)

## 产出与命名

- 位置：**该会话对应的工作区内** `<工作区>/harness-trace/`（工作区不可写时回退到 `~/.dsh/harness-trace/out/`），也可以在设置中自定义文件夹名称
- 命名：**序号 + 时间**，如 `0001-20261010-040951.md`
- 例如示例工作区`<工作区>\harness-trace\0001-20261010-060328.md`
- 一次会话一个文件，后续轮次持续追加（整体重写）

## 界面

安装后界面入口：

- **侧边栏面板入口** — 审阅页：左侧会话列表，右侧按轮次/步骤展开的时间线；可切换查看 Markdown 源码、手动写入、自动刷新。
- <img src="https://github.com/oihai/dsh-harness-trace/blob/main/images/34fdgag.png" title="" alt="" width="190">
- **设置 → Harness 交互追踪** — 全部配置项。
- <img src="https://github.com/oihai/dsh-harness-trace/blob/main/images/7856io.png" title="" alt="" width="104">
- **会话内「追踪」标签** — 只看当前会话。![](https://github.com/oihai/dsh-harness-trace/blob/main/images/nvkm14.png)
- **会话头部快捷按钮** — 显示追踪状态，可一键暂停/开始与写入。

四个入口都可单独开关，并可各自调整位置序号。

## 配置

UI 改动即时生效；也可直接编辑配置文件（路径见审阅页底部，或设置页）：

- **采集项**：系统提示词、提示词装配来源、发往模型的完整请求、用户输入、模型回复、推理过程、工具调用、工具结果、文件读写、联网、技能、命令执行、Token 用量。

- **详细程度**：摘要 / 标准 / 完整；单条正文上限（字符）。

- **原始请求**：仅在变化时 / 每次都写 / 不记录；最多消息数；总预算（超出部分折叠为一行）。

- **去重**：系统提示词与提示词装配在同一步骤重复出现时省略重复正文（关闭后文件会显著变大）。

- **追踪范围**：全部 / 仅所选 / 除所选；可勾选具体会话与工作区；可排除子代理会话。

- **输出**：子目录名、写入时机（每轮 / 每步 / 仅手动）、合并延迟。

- **入口位置**：四个入口的开关与序号。
  
  <img src="https://github.com/oihai/dsh-harness-trace/blob/main/images/7856io.png" title="" alt="" width="266">
  
  ## 与浏览器的通信

插件自建顶层通道在 Desktop 组合下不会被服务。因此宿主在共享 `/api` 通道上注册**精确 Fetch 路由**`/api/harness-trace`，浏览器用`connection.rpc.call('/api', 'harness-trace', { method, payload })` 调用。该插件仅在桌面版中完成测试

## 说明

- 只读监听：不修改任何请求内容，`llm/stream` 监听器原样透传所有 chunk。
- 系统提示词只记录**真正进入请求的那一份**，不在插件侧重新拼装。
- 安装为 `link:` 指向工作区源码，因此改工作区文件即改插件（宿主半改动后需重新加载才生效）。
