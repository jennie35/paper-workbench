# 接口说明

除健康检查和登录外，所有业务接口都需要 `Authorization: Bearer <session_token>`。令牌仅保存在浏览器会话中，模型密钥不会从配置接口返回。

| 方法与路径 | 用途 |
| --- | --- |
| `GET /health` | 基础健康状态，不返回配置 |
| `POST /api/login` | `{password}` 换取 12 小时令牌 |
| `GET /api/settings` | 返回配置状态、模型名称、实际 `storage_root` 和 `preflight:{ready,checked_at}`，隐藏密钥及内部配置指纹；保存目录只对已登录管理员开放 |
| `PUT /api/settings` | 保存 `{base_url,api_key,text_model,vision_model,openalex_key}`；同一 API 来源下空密钥保留旧值，更换来源须填新密钥 |
| `POST /api/preflight` | 实际检查外部技能、原生工具与文本/图像能力并登记当前配置的就绪状态；会调用模型 |
| `GET /api/workspace/status` | 返回 `active_job:null` 或 `{id,project_id,stage,status}`，用于定位实例内唯一运行批次 |
| `GET, POST /api/projects` | 课题列表；创建 `{name,goal,scope?}`，旧版仅传名称和目标仍可用 |
| `DELETE /api/projects/{id}` | 删除课题、批次、范围参考和论文关联；活动任务返回 409。保留实例主台账与连续编号；`cleanup_pending` 报告未清理的参考文件 |
| `PUT /api/projects/{id}/scope` | 保存课题研究配置；字段见下文，`storage_root` 始终由后台实际 DATA_DIR 覆盖 |
| `GET /api/projects/{id}/references` | 参考资料元数据列表：`id,filename,pages,sha256,role`；不含正文或服务器路径 |
| `POST /api/projects/{id}/references` | multipart `file` 上传范围参考 PDF；同课题相同文件指纹复用记录并返回 `reused:true` |
| `POST /api/projects/{id}/infer-scope` | 根据课题和参考资料生成可编辑范围，不自动覆盖 |
| `POST /api/projects/{id}/jobs` | `{count:5}`，返回任务 ID；允许 1–20 |
| `GET /api/projects/{id}/jobs` | 批次记录、检查点、候选和缺额；候选可带实际保存的临时 `analysis` 投影，不改写检查点或增加精读完成数 |
| `GET /api/jobs/{id}` | 当前状态与检查点 |
| `GET /api/jobs/{id}/synthesis` | 读取已保存的跨论文综合，未生成时后台返回 `null`；不发起模型调用 |
| `POST /api/jobs/{id}/synthesis` | 对已停止批次显式生成或重试综合；使用该批范围与当前课题关联记录，会调用所配置的模型（无可用论文时只返回资料不足） |
| `POST /api/jobs/{id}/cancel` | 请求在下一检查点停止 |
| `POST /api/jobs/{id}/retry` | 从已保存阶段恢复整个批次，沿用原范围和当前模型配置；已完成论文不重复登记 |
| `GET /api/jobs/{id}/candidates/{index}` | 候选题录、未核验分析、阅读记录及资产可得性 |
| `GET /api/jobs/{id}/candidates/{index}/pdf` | 下载已取得的候选全文，仍需鉴权 |
| `GET /api/jobs/{id}/candidates/{index}/source` | 正文来源块定位；可用 `?page=1` 筛选 PDF 页 |
| `GET /api/jobs/{id}/candidates/{index}/assets/{filename}` | 已取得的原页图片或分析者绘制的流程图 |
| `POST /api/jobs/{id}/candidates/{index}/pdf` | multipart `file` 补充候选正文；保存上传标识、文件名和时间，不改变核验状态；活跃任务期间不可替换 |
| `GET /api/projects/{id}/papers` | 当前课题的论文及分析；包含批次关联 |
| `GET /api/papers/{number}` | 实例范围的论文记录 |
| `GET /api/papers/{number}/assets/{filename}` | 经过登录验证的原始页面或流程图 |
| `GET /api/projects/{id}/export?kind=html` | 导出 zip；另支持 `markdown` 和 `json` |

## 数据约定

以上表格描述私人后台。静态在线模式由浏览器适配器执行同名操作，使用本机 IndexedDB 而不调用私人后台：报告编号为 `D001` 等，`verified` 始终为 false。`analysis.source_basis` 区分 `fulltext`（实际提取的 PDF 文字）和 `abstract`，`source_blocks`、`source_metadata`、`coverage` 保存实际发送的来源和读取范围。浏览器另支持 `GET /api/papers/{id}/source` 读取已保存来源文字。批次的 `reports_generated`、`fulltext_reports`、`abstract_reports`、`report_shortfall` 描述新增报告，复用论文不计新增；它们不代表完整精读或原图核验。在线删除同样保留共享台账和编号，但没有服务器文件清理字段。

一个实例只有一个管理员。课题间共用论文身份和连续编号，通过课题关联保存适用性说明。`R001` 等为显示编号，数据库以整数和事务计数器保存，不用列表长度计算。

`preflight.ready` 只表示当前保存配置的最近一次接口检查通过。`checked_at` 为检查结果时间，未检查或配置改变时为 `null`。配置改变或检查失败会撤销原就绪状态；旧检查的迟到结果不会把新配置标为可用。保存配置本身不调用模型，手动预检可选；批次启动时自动预检。

API 来源按协议、主机和有效端口判断。同来源修改模型名称可留空 `api_key` 保留旧密钥；切换来源而未提交新密钥会拒绝保存，避免把原供应商凭据发送到新地址。OpenAlex 密钥留空仍保留原值。

题录保留标题、作者、DOI、发表日期、年份、期刊、URL、规范化标题、分析日期、状态、全文可得性、证据核验、版本、技能模式与笔记路径。日期为来源记录，不混同论文年份和分析日期。

分析包含 `summary`、`scientific_question`、设计字段、证据卡、行动卡、原图记录、阅读覆盖及核验状态。`verified` 只能由完成正文/原图/结构校验的服务端流程设置。`structural_validation=norman_native_passed` 是工具校验状态，不是科学真实性认证。

## 课题研究配置

完整研究逻辑见 [RESEARCH.md](RESEARCH.md)。`scope` 保留旧字段，并增加以下配置：

| 字段 | 含义与默认行为 |
| --- | --- |
| `core_question` / `research_question` | 核心科学问题；互为兼容字段，同时提供时以 `core_question` 为准 |
| `research_stage` | 当前研究阶段；可使用 `exploration/design/experiment/validation/writing`，旧记录的中文值仍可读 |
| `research_object`, `application_context` | 研究对象和应用场景 |
| `existing_methods`, `known_resources`, `constraints` | 已有方法/系统、已知设备材料数据资源、约束；空值不表示这些条件已经具备 |
| `reference_materials`, `version_differences` | 资料描述和版本差异；文字中的本地路径不授权服务器任意读取文件 |
| `keywords_zh`, `keywords_en`, `keywords` | 中英文关键词及兼容检索词；当前后台检索词合并去重后最多 20 个 |
| `include`, `exclude`, `inferred` | 纳入、排除范围及是否仍属推定；推定结果须由用户确认 |
| `default_count` | 每次目标篇数，1–20，默认 5；批次省略 `count` 时沿用课题配置，显式提供时以本次请求为准 |
| `output_language` | 输出语言，例如 `zh-CN` 或 `en`；不会因此翻译或更改原文题录 |
| `run_mode` | `manual` 或 `existing-task`；后者只记录对已有任务的预期，不创建、修改或证明存在定时任务 |
| `storage_root` | 实际保存位置，只读；后台返回已配置 DATA_DIR 的绝对路径，不能靠请求字段切换服务器目录 |

`infer-scope` 返回可编辑建议，不直接保存。后台保留用户已确认的核心问题，以及阶段、资源、约束、输出和运行设置；不将模型推定的设备或预算覆盖为已知条件。`storage_root` 不发送给模型。

## 论文报告与原配置

`analysis.research_logic` 包含：`reading_scope`、`storyline`、`study_design`、`design_decisions`、`evidence_review`、`conclusion_layers`、`reading_priorities`、`transfer_insights` 和 `pitfalls`。它与原有 `summary`、`flow_steps`、`evidence`、`actions` 等字段共同组成十一节报告。新后台模型草稿缺少 `research_logic` 时不会登记为完成；旧记录可以继续读取，缺失项显示未记录，不伪造补读结果。

行动卡保留原字段，增加 `question`、`experimental_unit`、`data`、`confounds`、`criteria_basis`、`prerequisites`、`stopping_criteria` 和 `status:'pending'`。动作都是建议，不能因生成或导出变成已实施实验。来源块、证据 ID 和行动 ID 分别检查其实际存在性。标为作者说明的设计理由必须绑定非空正文来源块；分析者重建的理由需明确标识。

新分析保存 `analysis.project_context:{project_id,scope_snapshot}`，记录生成报告时的科学配置。后来更改课题不会把新设备、新资源或新方案追写成此前已经实施的条件；复用报告仍保留适用性待评估提示。旧记录没有快照时，原条件属于未知，不能用当前配置倒填。

题录新增或保留 `volume`、`issue`、`pages`、`issue_year`、`online_date`、`print_date`、`publication_dates`、`publication_date_precision` 及日期状态。`first_publication_date_status:'earliest_source_record'` 表示可区分的来源日期中最早者，仍不是对首次发表的独立认证。月份不补写具体日；年份不补写月份。部分日期区间重叠而无法确定顺序时，`first_publication_date` 留空，已知日期继续保留于 `publication_date`。

## 跨论文综合

新批次结束时，后台尝试将当前课题已有登记论文与新增论文一起综合；综合失败不撤销已保存的单篇成果。后台最多向模型提供最近 30 篇登记记录，并在超出时明确说明覆盖范围。浏览器适配器使用课题关联报告的限长字段，并记录实际 `context_coverage`；两种模式的完成数与证据强度不能混同。

综合保存到 `job.checkpoint.synthesis`：

```text
schema_version, status, created_at, scope_snapshot, record_ids
supports[{record_ids,claim,reason}]
conflicts[{record_ids,claim,possible_causes,needed_evidence}]
judgement_changes[{record_ids,before,after,reason}]
priority_actions[{record_id,action_id,reason,scientific_value,evidence_gap,feasibility,validation_cost}]
route_decisions[{route,decision:hold|need_evidence|abandon,reason,record_ids}]
limitations[]
```

支持或冲突条目至少关联两篇实际记录；优先行动最多三项，只能引用真实论文/行动编号组合，未经课题适用性重评的复用建议不能因此升级。来源与字段检查只排除不合法引用，不证明分析判断正确。没有冲突证据或既往判断时不应填造内容。

后台综合状态包括 `insufficient_evidence`、`partial`、`completed`、`failed`；浏览器还会记录 `running`、`cancelled`、`unavailable` 等界面状态。读取 GET 不计费；POST、自动批末综合和接口预检可能产生供应商模型费用。`run_mode` 只是配置；点击启动的批次记录实际 `trigger_source:'manual'`，后台位于检查点字段，浏览器也在批次顶层保留此值。

## 长期保存与导出

后台在 DATA_DIR 内保留唯一 canonical PDF、来源映射和图片。验证后准备的日期视图位于 `YYYY-MM-DD/RNNN/`，含 `reading-note.md`、`evidence.json`、`record.json` 及 `source/reference.json`、`assets/reference.json`。引用指向 DATA_DIR 下的 canonical 资料，不复制整套缓存或原始图片；笔记使用相对链接。新视图先在 DATA_DIR 内 `.staging` 准备，只有完整视图才转入日期目录；已有不同来源的目录不会被覆盖。

`analysis.artifact_dir` 继续定位 canonical 资料；`analysis.long_term_dir` 和题录的 `note_path` 指向日期视图。导出是用户显式操作，不能将静态网页发布解释为私人资料自动上 GitHub。外部技能及其二进制不随仓库或研究资料导出。

后台 JSON 导出现在返回 `schema_version:2` 的课题包，包含 `project`、`references`、`papers`、`jobs`，即使尚无完成精读也保留候选草稿、检索、缺额及已保存综合。需要旧论文数组的调用方可使用 `?kind=json&legacy=true`。Markdown/HTML ZIP 中保留 `papers.json`，新增相同课题包 `research.json` 与 `project.md`；HTML 首页提供四个本地视图和关键词、日期、主题、优先级筛选，不请求模型。候选的原 PDF/原图二进制不包含于包内，来源缺口仍保留。

登记数据库失败时，仅将本次未登记的日期视图移入主目录内 `.registration-recovery-<随机ID>/`，避免占住回滚后的编号；保留规范来源、原笔记和用户批注。若数据库已实际提交则保留对应视图，不误回收已登记编号。恢复目录用于人工核对，不自动作为完成论文或新研究登记。

任务状态为 queued、running、completed、failed、cancelled。completed 表示批次结束，可能仍有缺额；结束统计位于 `checkpoint.actual`、`checkpoint.shortfall`、`checkpoint.pending_verification`，不能仅凭 completed 宣称完成目标数量。运行中可读取 `checkpoint.completed`、`checkpoint.reused` 和候选状态统计进度，结束统计字段可能尚未产生。

候选状态独立于论文登记：pending、excluded、duplicate、no_fulltext、unverified、completed、reused。只在最终校验后进行正式登记。全文不足的候选可以补充 PDF，未核验资料不会混进已完成论文列表。

补充全文成功后，响应及对应 `checkpoint.candidates[index]` 保存 `fulltext_uploaded:true`、`uploaded_filename` 和 `fulltext_uploaded_at`（ISO 时间）。文件名仅保留基本名称；这些字段不意味着身份或原图核验通过，也不增加已完成数量。最终替换前会重新检查任务状态；若上传期间有批次开始执行，返回 409 并保留旧正文与草稿。

原生证据文件遵循外部技能的 `schema_version=1`：paper、claims、evidence、links、branches、actions 和必要的 action_status。来源块 ID 必须来自实际提取的 source_map；不能通过提供一个未获取的 URL 冒充已核验。

错误码：400 配置、资料或模型检查失败；401 会话无效；404 资源不存在；409 活跃批次冲突、检查期间配置改变或记录已变化；413 文件过大；422 请求字段无效；503 队列不可用。模型服务的 HTTP 429 经固定中文说明区分可识别的额度或消费上限与请求频率限制；未知错误码不猜测。提供方响应正文、原始错误消息和内部配置指纹不会直接返回，以防包含敏感配置。
