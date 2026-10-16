# 接口说明

除健康检查和登录外，所有业务接口都需要 `Authorization: Bearer <session_token>`。令牌仅保存在浏览器会话中，模型密钥不会从配置接口返回。

| 方法与路径 | 用途 |
| --- | --- |
| `GET /health` | 基础健康状态，不返回配置 |
| `POST /api/login` | `{password}` 换取 12 小时令牌 |
| `GET /api/settings` | 返回配置状态和模型名称，隐藏密钥 |
| `PUT /api/settings` | 保存 `{base_url,api_key,text_model,vision_model,openalex_key}`；空密钥保留旧值 |
| `POST /api/preflight` | 检查外部技能、原生工具与文本/图像能力 |
| `GET, POST /api/projects` | 课题列表；创建 `{name,goal}` |
| `PUT /api/projects/{id}/scope` | 保存科学问题、关键词、纳入与排除范围及推定状态 |
| `POST /api/projects/{id}/references` | multipart `file` 上传范围参考 PDF |
| `POST /api/projects/{id}/infer-scope` | 根据课题和参考资料生成可编辑范围，不自动覆盖 |
| `POST /api/projects/{id}/jobs` | `{count:5}`，返回任务 ID；允许 1–20 |
| `GET /api/projects/{id}/jobs` | 批次记录、检查点、候选和缺额 |
| `GET /api/jobs/{id}` | 当前状态与检查点 |
| `POST /api/jobs/{id}/cancel` | 请求在下一检查点停止 |
| `POST /api/jobs/{id}/retry` | 从已保存阶段重试，已完成论文不重复登记 |
| `POST /api/jobs/{id}/candidates/{index}/pdf` | multipart `file` 补充候选正文，运行中的任务不可替换 |
| `GET /api/projects/{id}/papers` | 当前课题的论文及分析；包含批次关联 |
| `GET /api/papers/{number}` | 实例范围的论文记录 |
| `GET /api/papers/{number}/assets/{filename}` | 经过登录验证的原始页面或流程图 |
| `GET /api/projects/{id}/export?kind=html` | 导出 zip；另支持 `markdown` 和 `json` |

## 数据约定

一个实例只有一个管理员。课题间共用论文身份和连续编号，通过课题关联保存适用性说明。`R001` 等为显示编号，数据库以整数和事务计数器保存，不用列表长度计算。

题录保留标题、作者、DOI、发表日期、年份、期刊、URL、规范化标题、分析日期、状态、全文可得性、证据核验、版本、技能模式与笔记路径。日期为来源记录，不混同论文年份和分析日期。

分析包含 `summary`、`scientific_question`、设计字段、证据卡、行动卡、原图记录、阅读覆盖及核验状态。`verified` 只能由完成正文/原图/结构校验的服务端流程设置。`structural_validation=norman_native_passed` 是工具校验状态，不是科学真实性认证。

任务状态为 queued、running、completed、failed、cancelled。completed 表示批次结束，可能仍有缺额；读取 `actual`、`shortfall`、`pending_verification`，不能仅凭 completed 宣称完成目标数量。

候选状态独立于论文登记：pending、excluded、duplicate、no_fulltext、unverified、completed。只在最终校验后进行正式登记。全文不足的候选可以补充 PDF，未核验资料不会混进已完成论文列表。

原生证据文件遵循外部技能的 `schema_version=1`：paper、claims、evidence、links、branches、actions 和必要的 action_status。来源块 ID 必须来自实际提取的 source_map；不能通过提供一个未获取的 URL 冒充已核验。

错误码：401 会话无效；404 资源不存在；409 活跃批次冲突；413 文件过大；422 请求字段无效；503 队列不可用。提供方响应正文不会直接返回，以防包含敏感配置。

