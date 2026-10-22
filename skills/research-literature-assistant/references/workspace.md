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

图片只能引用主目录内实际文件，不能将远程图片自动联网取回。轻量看板的第 7 节仅从合格 `visuals` / `original_images` 重建，不直接展示原笔记中该节的自由文本；原笔记和 evidence.json 保留原样审计。原 evidence 契约允许扩展时，每项保存：

```json
{
  "kind": "figure",
  "locator": "Figure 2, panel A",
  "page": 4,
  "asset_path": "assets/page-4.png",
  "source_path": "source/paper.pdf",
  "image_sha256": "实际图像的SHA256",
  "source_sha256": "实际原文的SHA256",
  "inspection_status": "verified",
  "inspection_method": "visual_tool",
  "inspection_id": "实际工具调用或人工查看日志的引用",
  "inspected_at": "2026-10-22T09:30:00+08:00",
  "explanation": "实际看到的比较、结果、解释与支持边界"
}
```

示例仅说明字段，不能把示例内容作为查看记录。`kind` 可为 figure/table/equation，查看方式可为 manual/visual_tool/vision_model；应用或实际操作者在真实查看后写入记录，不接受文字模型自行认证。来源路径也可由 `sources` 中匹配的实际指纹解析。构建器检查具体编号、正整数页码、带时区的查看时间、记录引用，以及图像/原文的本地路径和 SHA256；文件存在、`verified:true` 或旧版核验标记均不够。原图可点击查看完整文件，保存实际比较、坐标/单位、统计单位、误差及一致性说明；模型方式明确标为未经人工复核。路径/指纹通过只证明文件身份符合保存记录，不证明实际阅读质量或科学结论。

第三方证据契约不允许扩展时保留原生文件，在它支持的笔记/阅读器中记录真实查看依据，不为索引破坏原契约。轻量页面缺少合格记录时省略第 7 节；不删除底层资料，不提高完整精读状态。`reading_priorities` 可作有内容的索引入口，不能把空卡片当成已精读。

用 `flow_steps` 的真实研究步骤生成离线流程图；证据链使用 `evidence:[{id,locator,observation}]`、`claims:[{id,text,evidence_ids}]` 与行动的 `claim_ids` / `evidence_ids`，只画保存的显式关系，不从条目顺序或题名推断关联。图中行动始终标为待执行，未核验图表解释不进入证据链。两种图均注明“分析者绘制，非论文原图”，没有实际步骤或关联则省略。

发布前检查相对路径、图片、返回链接、日期、搜索与筛选，确认旧版被安全保留。`check` 只检查文件库，不认证来源真假、科学结论、实际目视核验、第三方技能执行或署名。新技能脚本可在隔离合成库测试，不能用真实桌面库做破坏性验收。

手工编辑的 `index.html` 指纹变化会阻止覆盖。写入失败、遗留 `.pending` 或锁文件时检查实际状态和记录 PID；不要自动删活跃锁、清空缓存或移除用户修改以强行重试。仅在确认进程停止、保留恢复材料后按正式权限处理。本工具不清理旧资料，不创建每日 ZIP/DOCX，也不自动公开或推送私人文件。

如果保存期间外部进程更改台账或页面，工具保留外部修改并报告恢复冲突；已移动的新记录可能留在错误消息指定的日期目录，以免破坏外部台账的引用。此时人工核对目录、台账与暂存后恢复，不反复登记或把保留文件直接计为已完成精读。
