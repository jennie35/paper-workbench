# 部署与运维

## 需要准备的内容

- 可写入的 GitHub 仓库和 Pages。
- 可运行 Docker Compose 的服务器与后端 HTTPS 域名。
- 文本和图像模型 API，支持 OpenAI 兼容的 chat completions 格式。
- 可选：外部 `norman-paper-reading` 技能目录。
- 仅使用可选Norman原生工具时：Linux Docker需Windows/macOS桥接。基础正文报告使用内置工具。

未准备好后端时，Pages 仍可作为不产生 API 开销的合成演示。部署者维护服务，浏览器用户不安装软件。

## 配置与启动

复制 `.env.example` 为 `.env`。管理员口令至少 16 字符，推荐随机生成 24 字符以上；数据库口令使用随机字母数字，避免 URL 特殊字符。生成加密密钥：

```sh
python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```

`ALLOWED_ORIGINS` 填 `https://用户名.github.io`，不要填仓库子路径。多个来源用逗号分隔，不用 `*`。本地开发可加 `http://localhost:8080`。

基础Compose不挂载第三方技能。可选Norman设置 `NORMAN_SKILL_HOST_PATH`，使用 `docker compose -f compose.yaml -f compose.norman.yaml up -d --build` 只读挂载。`NORMAN_BRIDGE_URL` 是桥接服务的 HTTPS 根地址，`NORMAN_BRIDGE_TOKEN` 在后端和桥接服务两侧必须一致。不要提交任何真实配置。

```sh
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 api worker
```

API 只绑定服务器 `127.0.0.1:8000`。在已有反向代理中将后端域名转发到该端口；允许至少 55 MB 请求体，长请求读取超时设为 600 秒。示例 Nginx location：

```nginx
location / {
    client_max_body_size 55m;
    proxy_read_timeout 600s;
    proxy_pass http://127.0.0.1:8000;
    proxy_set_header Host $host;
}
```

TLS 证书由部署者使用现有证书管理工具配置。不要开放数据库或 Redis 公网端口，不运行多个 API 或 worker 副本；首版按单实例设计。

## 原生引擎桥接

在拥有外部技能的 Windows/macOS 节点上安装本项目后端依赖。设置：

```text
NORMAN_SKILL_PATH=<本机外部技能绝对路径>
NORMAN_BRIDGE_TOKEN=<至少32字符的随机令牌>
DATA_DIR=<本项目独立数据目录>
```

不要在桥接进程设置 `NORMAN_BRIDGE_URL`。从 `backend/` 运行：

```sh
python -m uvicorn app.bridge:app --host 127.0.0.1 --port 8010
```

通过受控制的 HTTPS 反向代理提供该服务。桥接接口只允许 extract、render、validate 三种固定操作，拒绝任意命令参数和越界归档路径。输入工作目录在请求结束后清理，不保留副本；原文、来源映射和分析文件会传输到该节点，节点应由部署者自己控制。

桥接请求支持较大的原始页面图像；反向代理请求体限制建议设为 110 MB。桥接令牌只在服务器环境中配置，不进入前端。

Windows/macOS 上直接运行后端时可省略桥接地址，使用本机原生引擎。RQ 生产 worker 使用 Linux Docker；不要假定默认 fork worker 可直接运行在 Windows。

## 首次使用

1. 访问 Pages，连接后端并使用管理员口令登录。
2. 首页创建一个与真实私人资料无关的测试课题，确认研究范围。已有课题可点「进入课题」，结果与批次均在课题内容中查看。
3. 配置模型基础地址、当前供应商密钥及文本、视觉模型名称。同一 API 来源下可留空密钥保留原值，更换供应商时须填写新密钥；旧值不会返回浏览器。
4. 可选「保存并检查接口」，先保存当前内容再实际读取校验图片；这会调用模型并可能产生费用。「仅保存配置」不调用模型。开始批次时也会自动预检，不必先手动检查。
5. 在课题中选择「开始检索与分析」，设置目标数量为 1，核对模型与资料发送范围后启动。通过「分析批次与结果」查看进度，再阅读文献、候选与草稿。
6. 检查一篇公开可得全文的真实分析：来源身份、原图、证据定位、行动边界、导出文件。一篇真实验收通过后，再运行默认五篇。接口费用由用户的模型供应商计算，本项目不预估未发生的开销。

接口检查结果绑定当前保存的配置。配置改变或检查失败后，不再显示旧配置已通过；任务启动时的预检仍以实际接口能力为准。一个实例同时执行一个分析批次，其他课题可查看该任务入口。

## 持久化与恢复

PostgreSQL、Redis 和研究文件各有独立命名卷。普通容器重启不会清除数据。不要使用会删除命名卷的清理选项。

备份时先停止新批次并等待当前任务结束，再停止 API/worker。分别备份数据库、研究文件卷、Redis 队列卷及 `.env`。加密密钥必须与数据库一起保留，否则无法恢复已加密 API 配置。数据库可使用：

```sh
docker compose exec -T db pg_dump -U workbench -Fc workbench > workbench.dump
```

在 PowerShell 中避免用旧版文本重定向保存二进制数据库备份，可在容器内写文件再 `docker compose cp`。

恢复时在停止 API/worker 的情况下，还原数据库、文件和队列卷，恢复相同 `.env`，再启动服务。确认课题数、编号和资产可读取；重新检查 API 配置与技能能力后恢复批次。

worker 超时或异常退出后，RQ 尝试恢复任务；重试耗尽时网页会显示失败，检查点保留。Redis 暂不可用不会将正在运行的任务误判为可重复执行。取消在当前网络调用结束后的检查点生效，最长受模型/引擎超时限制。

## 运行边界

- 来源站点可能限流、要求订阅或不提供可用 PDF；系统报告实际篇数，不承诺每次找到五篇。
- 扫描或加密 PDF、超过限制的文件需要先处理；首版不包含 OCR。
- 模型可以犯错。已模型核验仍需研究者判断，不等于实验复现。
- 首版使用单管理员令牌登录，令牌有效期 12 小时。需要强制结束全部会话时轮换加密密钥，同时重新保存 API 配置。
- 管理员口令由环境配置，重启应用使新口令生效；旧登录令牌仍会存活到过期，或通过轮换加密密钥失效。
- Pages 与后端跨域时，请确认 HTTPS、CORS origin、供应商兼容接口和桥接连接均可达。


新版正文完成标准、扫描识别、中文导入、模型缓存与OpenAlex内容预算见[正文与图谱说明](CORE-READING.md)。
