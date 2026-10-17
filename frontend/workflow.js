const nonempty = value => typeof value === 'string' && value.trim().length > 0;

/** Compare service endpoints without confusing API paths or default ports. */
export function apiOrigin(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const url = new URL(value.trim());
    return ['http:', 'https:'].includes(url.protocol) ? url.origin : '';
  } catch {
    return '';
  }
}

export function configurationComplete(settings) {
  return Boolean(settings?.configured === true && settings?.has_api_key === true
    && nonempty(settings.base_url) && nonempty(settings.text_model) && nonempty(settings.vision_model));
}

export function scopeConfirmed(project) {
  const scope = project?.scope;
  return Boolean(project && scope?.inferred === false
    && (nonempty(scope.research_question)
      || (Array.isArray(scope.keywords) && scope.keywords.some(nonempty))));
}

/** A single next action for the workspace, including jobs in other projects. */
export function workflowState({demo = true, project = null, settings = null, activeJob = null} = {}) {
  const connected = !demo;
  const hasProject = connected && Boolean(project);
  const hasScope = hasProject && scopeConfirmed(project);
  const hasModels = connected && configurationComplete(settings);
  let modelDescription = '填写服务商的接口地址、密钥和准确模型名。';
  if (hasModels) {
    modelDescription = settings.preflight?.ready === true
      ? '配置完整，最近一次能力检查已通过；分析开始时会自动复查。'
      : '配置完整；分析开始时自动检查文本、图像和阅读技能，无需另做付费检查。';
  }
  const steps = [
    {key:'connection', label:'连接私人服务', complete:connected,
      description:connected ? '已进入私人研究空间，资料保存在此服务。' : '先连接保存论文并运行分析的私人服务。'},
    {key:'project', label:'创建或选择课题', complete:hasProject,
      description:hasProject ? `当前课题：${project.name || '未命名课题'}` : '输入课题名称，可选上传参考 PDF。'},
    {key:'scope', label:'确认研究范围', complete:hasScope,
      description:hasScope ? '研究问题或关键词已由你确认，可继续修改。' : '检查研究问题、关键词及纳入排除条件，确认后保存。'},
    {key:'model', label:'配置模型接口', complete:hasModels, description:modelDescription},
  ];
  let action, title, description;
  if (connected && activeJob) {
    action = 'active';
    title = '查看正在进行的分析';
    description = '此研究空间已有一批任务。先查看进度或取消任务，再开始下一批。';
  } else if (!connected) {
    action = 'connect';
    title = '连接你的研究空间';
    description = '当前为示例演示。连接私人服务后即可保存课题、论文并运行分析。';
  } else if (!hasProject) {
    action = 'create';
    title = '创建第一个课题';
    description = '从课题名称或参考 PDF 开始，先确定本次研究的范围。';
  } else if (!hasScope) {
    action = 'scope';
    title = '确认课题范围';
    description = '当前范围尚未确认。检查问题和关键词，避免检索偏离研究目标。';
  } else if (!hasModels) {
    action = 'settings';
    title = '完成模型配置';
    description = '补齐接口地址、密钥、文本与视觉模型名，保存后即可开始分析。';
  } else {
    action = 'batch';
    title = '开始检索与分析';
    description = '研究范围和模型已配置。下一步确认篇数与资料发送范围，再启动任务。';
  }
  return {action, title, description, steps};
}
