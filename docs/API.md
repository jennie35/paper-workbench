# 接口说明

除健康检查和登录外，所有业务接口都需要 `Authorization: Bearer <session_token>`。令牌仅保存在浏览器会话中，模型密钥不会从配置接口返回。

| 方法与路径 | 用途 |
| --- | --- |
| `GET /health` | 基础健康状态，不返回配置 |
| `POST /api/login` | `{password}` 换取 12 小时令牌 |
| `GET /api/settings` | 返回配置状态、模型名称和 `preflight:{ready,checked_at}`，隐藏密钥及内部配置指纹 |
| `PUT /api/settings` | 保存 `{base_url,api_key,text_model,vision_model,openalex_key}`；同一 API 来源下空密钥保留旧值，更换来源须填新密钥 |
| `POST /api/preflight` | 实际检查外部技能、原生工具与文本/图像能力并登记当前配置的就绪状态；会调用模型 |
| `GET /api/workspace/status` | 返回 `active_job:null` 或 `{id,project_id,stage,status}`，用于定位实例内唯一运行批次 |
| `GET, POST /api/projects` | 课题列表；创建 `{name,goal}` |
| `DELETE /api/projects/{id}` | 删除课题、批次、范围参考和论文关联；活动任务返回 409。保留实例主台账与连续编号；`cleanup_pending` 报告未清理的参考文件 |
| `PUT /api/projects/{id}/scope` | 保存科学问题、关键词、纳入与排除范围及推定状态 |
| `GET /api/projects/{id}/references` | 参考资料元数据列表：`id,filename,pages,sha256,role`；不含正文或服务器路径 |
| `POST /api/projects/{id}/references` | multipart `file` 上传范围参考 PDF；同课题相同文件指纹复用记录并返回 `reused:true` |
| `POST /api/projects/{id}/infer-scope` | 根据课题和参考资料生成可编辑范围，不自动覆盖 |
| `POST /api/projects/{id}/jobs` | `{count:5}`，返回任务 ID；允许 1–20 |
| `GET /api/projects/{id}/jobs` | 批次记录、检查点、候选和缺额；候选可带实际保存的临时 `analysis` 投影，不改写检查点或增加精读完成数 |
| `GET /api/jobs/{id}` | 当前状态与检查点 |
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

任务状态为 queued、running、completed、failed、cancelled。completed 表示批次结束，可能仍有缺额；结束统计位于 `checkpoint.actual`、`checkpoint.shortfall`、`checkpoint.pending_verification`，不能仅凭 completed 宣称完成目标数量。运行中可读取 `checkpoint.completed`、`checkpoint.reused` 和候选状态统计进度，结束统计字段可能尚未产生。

候选状态独立于论文登记：pending、excluded、duplicate、no_fulltext、unverified、completed、reused。只在最终校验后进行正式登记。全文不足的候选可以补充 PDF，未核验资料不会混进已完成论文列表。

补充全文成功后，响应及对应 `checkpoint.candidates[index]` 保存 `fulltext_uploaded:true`、`uploaded_filename` 和 `fulltext_uploaded_at`（ISO 时间）。文件名仅保留基本名称；这些字段不意味着身份或原图核验通过，也不增加已完成数量。最终替换前会重新检查任务状态；若上传期间有批次开始执行，返回 409 并保留旧正文与草稿。

原生证据文件遵循外部技能的 `schema_version=1`：paper、claims、evidence、links、branches、actions 和必要的 action_status。来源块 ID 必须来自实际提取的 source_map；不能通过提供一个未获取的 URL 冒充已核验。

错误码：400 配置、资料或模型检查失败；401 会话无效；404 资源不存在；409 活跃批次冲突、检查期间配置改变或记录已变化；413 文件过大；422 请求字段无效；503 队列不可用。模型服务的 HTTP 429 经固定中文说明区分可识别的额度或消费上限与请求频率限制；未知错误码不猜测。提供方响应正文、原始错误消息和内部配置指纹不会直接返回，以防包含敏感配置。
