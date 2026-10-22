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

export function configurationComplete(settings,mode=settings?.mode) {
  return Boolean(settings?.configured === true && settings?.has_api_key === true
    && nonempty(settings.base_url) && nonempty(settings.text_model)
    && (mode==='direct'||nonempty(settings.vision_model)));
}

export function scopeConfirmed(project) {
  const scope = project?.scope;
  return Boolean(project && scope?.inferred === false
    && (nonempty(scope.research_question)
      || (Array.isArray(scope.keywords) && scope.keywords.some(nonempty))));
}

/** A single next action for the workspace, including jobs in other projects. */
export function workflowState({demo = true, project = null, settings = null, activeJob = null, mode = 'backend'} = {}) {
  const direct=mode==='direct';
  const connected = !demo;
  const hasProject = connected && Boolean(project);
  const hasScope = hasProject && scopeConfirmed(project);
  const hasModels = connected && configurationComplete(settings,mode);
  let modelDescription = '填写服务商的接口地址、密钥和准确模型名。';
  if (hasModels) {
    modelDescription = settings.preflight?.ready === true
      ? '配置完整，最近一次能力检查已通过；分析开始时会自动复查。'
      : '配置完整；分析开始时自动检查文本、图像和阅读技能，无需另做付费检查。';
  }
  if(direct)modelDescription=hasModels?'文本模型已配置；启动后生成基于实际全文文字或摘要的报告。':'填写 API 地址、Key 与文本模型名，Key 仅保留在本页内存。';
  const steps = [
    {key:'connection', label:direct?'浏览器课题库':'连接研究空间', complete:connected,
      description:connected ? direct?'课题和报告保存在当前浏览器。':'已进入私人研究空间，资料保存在此服务。' : '可直接填写模型 API，或选择高级私人后台模式。'},
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
    description = '当前为示例演示。填写模型 API 后可在浏览器中检索文献并生成报告。';
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
    description = direct?'补齐 API 地址、Key 和文本模型名称。':'补齐接口地址、密钥、文本与视觉模型名，保存后即可开始分析。';
  } else {
    action = 'batch';
    title = '开始检索与分析';
    description = direct?'确认篇数与发送资料后生成文献报告，运行时保持本页打开。':'研究范围和模型已配置。下一步确认篇数与资料发送范围，再启动任务。';
  }
  return {action, title, description, steps};
}
