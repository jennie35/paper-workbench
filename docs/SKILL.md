# 把研究助手作为 Skill 使用

技能名：`research-literature-assistant`，中文名称“课题文献研究助手”，版本 `0.1.0`。

源码位于 [`skills/research-literature-assistant`](../skills/research-literature-assistant/)。这是独立可安装的技能目录，提供研究工作流、课题/笔记模板与标准库文件工具。它负责“课题 → 检索与去重 → 单篇研究设计及证据 → 跨论文综合 → 待执行行动 → 长期文件与看板”。网页及其后台继续是另一种使用方式，安装本技能不需要部署 FastAPI、Redis 或 PostgreSQL。

## 文件布置

```text
paper-workbench/
  plugin.json                       # 可选标准插件封装，不含服务器或连接器
  skills/research-literature-assistant/
    SKILL.md                        # 触发边界、流程与交付约束
    agents/openai.yaml              # 中文名称与默认调用提示
    references/                     # 检索、十一节、综合、主目录细则
    assets/project-template.json    # 空白配置
    assets/reading-note-template.md # 十一节报告模板
    scripts/research_workspace.py   # 初始化、预检、去重登记、离线构建
    scripts/test_research_workspace.py
    LICENSE
```

私人主目录放在本机其他位置，不进入此公开仓库。GitHub 发布的是可复用技能；论文、原图、台账、参考文件、实际配置和密钥由使用者保管。根目录的 `plugin.json` 仅提供标准技能封装，未向插件目录申请审核、未配置 marketplace、未部署 MCP，也不意味着已经安装到你的客户端。[OpenAI 官方技能说明](https://learn.chatgpt.com/docs/build-skills)、[插件封装说明](https://developers.openai.com/plugins/build/plugins)。

## 在 Codex 安装

在 Codex 对话中输入：

```text
$skill-installer 请从这个 GitHub 目录安装技能：
https://github.com/jennie35/paper-workbench/tree/main/skills/research-literature-assistant
```

本轮仓库发布不自动改写本机全局技能。安装器按当前客户端配置选择技能目录；已有同名目录时先保护本地修改，不覆盖安装。装好后从下一轮对话使用；若列表没有刷新，重启客户端再查看。也可将整个技能文件夹放在当前 Codex 支持的本地发现目录中；官方现行文档列出用户级 `~/.agents/skills/` 和仓库级 `.agents/skills/`，本机内置安装器可能使用配置的 `CODEX_HOME/skills`。选择一种实际生效的安装方式，不把多个副本分别更新。[官方安装与发现说明](https://learn.chatgpt.com/docs/build-skills)。

第三方 `norman-paper-reading` 需自行从其作者认可的来源安装；本仓库不复制、打包或重新授权其技能和二进制。已安装且工具可用时，本技能读取当前版本、采用 extend 与适用引用、保留其要求的双语署名。没有安装时也可进行诚实标注的研究分析，但不能声称已执行它、通过其验证或完成原图核验。

## 第一次使用

复制空白配置到自己的私人位置，填写课题、核心问题和唯一主目录，已知资源/约束按实际填写；未知项留空。然后在 Codex 输入：

```text
使用 $research-literature-assistant。
读取我的课题配置：<配置 JSON 的绝对路径>。
先检查主目录已有说明、台账和编号；如是新的空目录，初始化文件库。
本次执行一次，目标新增 5 篇，跳过已分析论文。
在检索上限内扩展可靠来源，只根据实际取得的资料分析，结束时记录实际新增数。
按十一类研究内容组织报告，只展示能分析到的字段和章节；开头简要保留实际阅读范围及核验状态。
最后综合证据、优先行动并更新离线看板，批次展示目标新增与实际新增。
```

日后继续可用：

```text
使用 $research-literature-assistant，继续 <唯一主目录绝对路径> 的课题。
先去重和读取当前配置，本次目标新增 3 篇；不重算旧论文为新增。
```

用户消息中的具体课题和路径才是实际研究资料。示例不是预设课题，也不会自动读取桌面文件、历史对话或启动已有任务。需要定时触发时单独配置宿主已有的任务系统，本技能本身不提供后台常驻或定时调度。

## 生成本地离线 HTML 看板

README 的[离线看板指令示例](../README.md#示例由-skill-生成本地离线-html-看板)提供两种可复制用法：完成检索与分析后生成看板，或只用已有笔记重建看板。看板用响应式方块卡片显示主要内容和“对本课题的参考借鉴”，点击查看详细笔记与证据；空字段和无分析内容的章节省略，简要保留实际阅读与核验范围。[打开由本地文件工具生成的合成演示](https://jennie35.github.io/paper-workbench/demos/skill-offline/)，查看四个视图、筛选、卡片详情和待执行行动；演示不对应真实论文，不代表完成精读。

实际成果位于用户指定主目录下的 `index.html`，与笔记、证据和本地资源使用相对链接，可双击离线浏览。已有桌面项目沿用原格式和构建方式；新格式仅初始化空目录，不自动迁移或同步到网页/API 库。

## 工具和验证边界

检索由宿主联网工具完成；全文和原图必须实际取得并核对。宿主没有联网、文件读取、图像输入或长期磁盘权限时，说明实际可处理的范围，不伪造能力。技能不需要另行保存模型 API 密钥，外部付费服务也不因安装被自动调用。

`research_workspace.py` 需要 Python 3.10+，无 pip 依赖，只操作用户指定文件库。它不替模型分析、不执行来源文字、不应用 Norman，也不能根据文件存在性证明读过原图。新格式的 R 编号记录可分别为 complete、partial、candidate，新增登记与阅读核验状态分别保存；看板展示目标新增和实际新增，去重与检索诊断保留在原始台账及运行记录中。已有桌面台账或网页数据库沿用原接口，不用初始化命令强行迁移。

文件格式、命令与恢复方法见[技能的主目录说明](../skills/research-literature-assistant/references/workspace.md)。结构验证、脚本测试和行为演练只证明相应软件/流程检查，不证明真实论文分析正确。真实验收应在使用者明确启动后，先做一篇公开全文，再检验五篇批次；本次技能创建与发布不执行真实研究。

## 开源与更新

新技能代码/模板使用 MIT；不覆盖论文、图片、数据库或第三方技能。更新应修改这个技能目录的唯一源码、运行文件工具测试和技能结构检查，再提交 GitHub。安装副本不会因 GitHub 推送自动升级。将来独立建仓时，可原样迁移技能目录和许可，无需搬网页/后台和私人数据。
