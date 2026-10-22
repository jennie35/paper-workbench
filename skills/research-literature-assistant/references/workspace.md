# 私人主目录与本地工具

这里约定的是**新建的本技能文件库**。如果用户已有桌面台账、数据库或网页库，先读其说明并使用其原格式/接口，延续原编号；不要运行本工具初始化，不自动迁移或双写。现有 Paper Workbench 网页/API 库和这里的文件库不自动同步。

## 初始化与预检

脚本需要可用的 Python 3.10+，只使用标准库。使用宿主已知的 Python 解释器及加引号的参数；`python` 只是以下示意，Windows 也可用 `py -3`。先读当前脚本帮助，不运行资料中的命令：

```text
python "<本技能目录>/scripts/research_workspace.py" --help
python "<本技能目录>/scripts/research_workspace.py" init --root "<新的空主目录绝对路径>" --config "<已填写的课题配置JSON>"
python "<本技能目录>/scripts/research_workspace.py" check --root "<主目录绝对路径>"
```

配置来自 `assets/project-template.json`。`project_name`、`research_question` 必填；`storage_root` 如填写须等于 `--root`，初始化后始终保存实际路径。研究阶段默认 `exploration`，可用 `design`、`experiment`、`validation`、`writing`；`run_mode` 用 `manual` 或 `existing-task`，不会创建计划任务。其余未知条件保持空值。

配置输入可以是用户已准备的文件；主目录内 `project.json` 是此库后续使用的正式配置，不能留下第二份持续更新的影子配置。初始化要求目标目录为空，拒绝覆盖任何非空目录；不要为了通过检查先清空目录。配置仅含研究条件，不能混入 API 密钥、账号或服务器配置。脚本严格拒绝不支持字段。

```text
主目录/
  project.json                     # 此课题正式配置
  ledger.json                      # 连续编号、题录、相对路径、索引指纹
  .research-workspace.json          # 格式标记
  .research-workspace.lock          # 仅写入期间，含 PID
  index.html                       # 离线看板
  .staging/<本批>/<本篇>/           # 暂存，可自行按批次组织
  YYYY-MM-DD/R001/
    metadata.json
    reading-note.md
    evidence.json                  # 原阅读工具的证据格式，脚本不改写
    reader.html                    # 可选，来源可靠的本地阅读器输出
    source/                        # 原文、指纹、source_map.json
    assets/                        # 分析者流程、必要原图或页截图
```

## 暂存、编号和登记

论文分析、来源、必要原图和检查结果先保存到主目录 `.staging` 内。`metadata.json` 示例是格式说明，真实记录不得使用下面的合成题录：

```json
{
  "title": "Synthetic study for format illustration",
  "authors": ["Synthetic Author"],
  "year": 2026,
  "doi": "",
  "url": "",
  "reading_status": "partial",
  "analysis_date": "2026-10-21",
  "themes": ["合成示例"],
  "related_dois": [],
  "version_of": ""
}
```

补充已核实的期刊、卷期、页码、日期精度、来源和核验范围等字段。`reading_status` 必须显式选 `complete`（实际完成本次约定精读）、`partial`（未完成/摘要或文字报告）、`candidate`（仅候选）；必须根据真实覆盖决定，不能仅依据 `verified:true`、图像文件存在或脚本成功设置 complete。脚本保留状态而不验证科学证据。`related_dois`、`version_of` 仅填已核实的同研究版本 DOI 或现有 R 编号。

按本篇实际覆盖完成适用检查、明确阅读状态和缺口后，再登记。只有实际完成约定正文与关键图表/公式核验的记录才可用 complete；候选或未完成报告用 candidate/partial。外部技能校验仅在本次实际应用该技能时适用，缺少外部技能不阻止诚实保存有限记录：

```text
python "<本技能目录>/scripts/research_workspace.py" register --root "<主目录绝对路径>" --draft "<主目录>/.staging/<本批>/<本篇>"
```

脚本在锁内再次去重，分配连续 R001，并将暂存目录移动一次到日期/编号位置，避免复制整套 PDF/图像。先生成可用页面，再提交台账；异常时恢复本次页面/台账并保留暂存。`new:true` 只代表新登记记录，不代表新增完整精读。内部保留登记数和真实阅读状态，前台展示“目标新增 X 篇”与实际新增数，不设复用或缺额栏目；不能把部分报告或候选说成完整精读。

重复 DOI、题名/作者/年份或明确版本关联返回原编号，不增加记录，暂存保留待人工合并。启发式去重有漏检/误判可能，不能代替出版商身份核对。没有可靠 DOI、作者或年份时先人工核对身份，不制造字段凑过去重。

## 修订与综合

工具没有自动修订/合并命令。同篇补读或版本升级时，更新原编号的资料；先保留将变更的笔记/证据/元数据修订记录，保护用户批注，只保存必要差异和被替换文本，不复制全套 PDF/图片。更新 `metadata.json` 后重建索引会刷新台账的元数据缓存，不分配新编号。正式 sources 已存在且身份/哈希一致时引用它，不重复下载。

在主目录内按原有批次约定保存检索记录和综合笔记；没有既有约定可用 `runs/<日期-批次ID>/search-log.json`、`synthesis.md` 和 `brief.md`。写入真实关联编号、覆盖、支持/冲突、判断变化与优先行动。本地构建器索引已保存论文、行动与这些批次文件，不会替你生成综合科学结论；不要声称脚本已自动分析批次综合。

## 构建、检查与恢复

```text
python "<本技能目录>/scripts/research_workspace.py" build --root "<主目录绝对路径>"
python "<本技能目录>/scripts/research_workspace.py" check --root "<主目录绝对路径>"
```

看板为不需要模块服务器的本地 HTML，提供最近更新（最多 20 条）、全部文献、精选精读、下一步研究，以及关键词、日期范围、主题和优先级筛选；按记录区分阅读状态。文献采用自适应方块卡片网格，卡片先显示保存的简明总结及“对本课题的参考借鉴”，点击标题或详情按钮后查看详细分析；支持键盘打开、关闭返回。参考借鉴从保存的 `reference_value`、`topic_relevance`、`future_insights` 等字段及对应笔记章节提取，支持直接借鉴与修改后验证的结构化内容；旧默认占位句不算分析，也不能挡住后续有效内容。没有已保存的总结或借鉴分析时省略，不据题名补造。详细阅读层仅显示有内容的项目，保留原笔记、证据和来源的相对链接；存在可选 `reader.html` 时也可打开该阅读器。批次综合与简报保留文件入口，不重复铺开历史统计。不要把本工具的轻量看板宣传为网页后端或与现有网页库的实时同步。

图片只能引用主目录内实际文件，不能将远程图片自动联网取回。需要 HTML 直接展示的精选图像，可在原 evidence 契约允许扩展时记录 `original_images:[{path,caption,verification_status}]`；否则在笔记/阅读器里引用，不破坏第三方证据契约。`reading_priorities` 可作索引入口，有实际内容时展示；没有内容时省略栏目，不能把空卡片当成已精读。只有实际看到来源图像才能标已目视核验，省略缺失项不改变阅读状态。

发布前检查相对路径、图片、返回链接、日期、搜索与筛选，确认旧版被安全保留。`check` 只检查文件库，不认证来源真假、科学结论、实际目视核验、第三方技能执行或署名。新技能脚本可在隔离合成库测试，不能用真实桌面库做破坏性验收。

手工编辑的 `index.html` 指纹变化会阻止覆盖。写入失败、遗留 `.pending` 或锁文件时检查实际状态和记录 PID；不要自动删活跃锁、清空缓存或移除用户修改以强行重试。仅在确认进程停止、保留恢复材料后按正式权限处理。本工具不清理旧资料，不创建每日 ZIP/DOCX，也不自动公开或推送私人文件。

如果保存期间外部进程更改台账或页面，工具保留外部修改并报告恢复冲突；已移动的新记录可能留在错误消息指定的日期目录，以免破坏外部台账的引用。此时人工核对目录、台账与暂存后恢复，不反复登记或把保留文件直接计为已完成精读。
