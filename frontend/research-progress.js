// Counts are completed reports. Timing is measured work, never fabricated stage percentages.
const active=new Set(['queued','running']);
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const nonnegative=value=>Number.isFinite(Number(value))?Math.max(0,Number(value)):0;
const timestamp=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))?Date.parse(value):null;
export function formatDuration(milliseconds){
  if(milliseconds==null||!Number.isFinite(milliseconds))return '—';
  const seconds=Math.floor(Math.max(0,milliseconds)/1000),minutes=Math.floor(seconds/60),hours=Math.floor(minutes/60);
  return hours?`${hours}小时${minutes%60}分`:minutes?`${minutes}分${seconds%60}秒`:`${seconds}秒`;
}
export function batchProgress(job,{completed,now=Date.now()}={}){
  const cp=job?.checkpoint||{},requested=nonnegative(job?.requested),rows=Array.isArray(cp.candidates)?cp.candidates:[];
  const target=requested>0?requested:rows.length||null;
  const recorded=completed??job?.core_reports??cp.core_reports??cp.actual??(Array.isArray(cp.completed)?cp.completed.length:0);
  const count=requested>0?nonnegative(recorded):rows.filter(row=>row.status==='completed').length;
  const done=target==null?count:Math.min(target,count),timing=cp.run_timing;
  const runStarted=timestamp(timing?.run_started_at),running=active.has(job?.status),clockActive=running&&timing?.running===true&&runStarted!=null;
  const runElapsed=clockActive?Math.max(0,now-runStarted):timing?nonnegative(timing.run_elapsed_ms):null;
  const measured=timing&&(typeof timing.elapsed_ms==='number'&&Number.isFinite(timing.elapsed_ms)||clockActive);
  const elapsed=measured?nonnegative(timing.elapsed_ms)+(clockActive?runElapsed:0):null;
  const baseline=timing&&typeof timing.run_initial_completed==='number'&&Number.isFinite(timing.run_initial_completed)?nonnegative(timing.run_initial_completed):null;
  const newReports=baseline==null?0:Math.max(0,done-baseline),remaining=target==null?null:Math.max(0,target-done);
  const eta=clockActive&&requested>0&&remaining>0&&newReports>0&&runElapsed>0?runElapsed/newReports*remaining:null;
  const elapsedText=elapsed==null?'耗时记录准备中':formatDuration(elapsed);
  let etaText;
  if(job?.status==='completed')etaText=remaining>0?'本次已结束':'已完成';
  else if(!running)etaText=({'waiting_sources':'等待补充资料','cancelled':'已停止','failed':'本次已中断'})[job?.status]||'未运行';
  else if(job?.status==='queued')etaText='等待开始执行';
  else if(target!=null&&done>=target)etaText='正在收尾';
  else if(requested===0)etaText='指定资料逐项处理';
  else etaText=eta==null?'本次完成首篇后估算':`约 ${formatDuration(Math.ceil(eta/1000)*1000)}`;
  return {target,done,running,clockActive,elapsedMs:elapsed,runElapsedMs:runElapsed,etaMs:eta,elapsedText,etaText,
    percent:target==null?null:Math.round(done/target*100),stage:String(job?.stage|| (job?.status==='queued'?'等待执行':'等待进度更新')),
    countText:target==null?'指定资料处理中':requested>0?`已生成 ${done}/${target} 篇正文报告`:`已处理 ${done}/${target} 份指定资料`};
}
export function batchProgressHtml(job,options){
  const view=batchProgress(job,options),known=view.target!=null;
  const note=view.running?'剩余时间按本次已完成速度估算，全文获取及模型响应会影响耗时。':job.status==='completed'?'本批报告已保存，可查看详细分析。':'已保存实际进度；恢复后会重新估算剩余时间。';
  return `<section class="batch-progress ${view.running?'is-working':''}" aria-label="批次分析进度"><div class="batch-progress-heading"><strong>${esc(view.countText)}</strong>${known?`<span>${view.percent}%</span>`:''}</div><progress class="batch-progress-track" aria-label="${job.requested>0?'正文报告完成进度':'指定资料完成进度'}" ${known?`max="${view.target}" value="${view.done}" aria-valuetext="${esc(view.countText)}"`:''}></progress><div class="batch-progress-stage" role="status"><span class="batch-progress-activity" aria-hidden="true"></span>当前阶段：${esc(view.stage)}</div><div class="batch-progress-times"><span>已用时间 <strong data-progress-elapsed>${esc(view.elapsedText)}</strong></span><span>预计剩余 <strong data-progress-eta>${esc(view.etaText)}</strong></span></div><p class="batch-progress-note">${note}</p></section>`;
}
export function updateBatchProgressTimes(root,job,options){
  const view=batchProgress(job,options);
  for(const [selector,value] of [['[data-progress-elapsed]',view.elapsedText],['[data-progress-eta]',view.etaText]]){
    const node=root?.querySelector(selector);if(node)node.textContent=value;
  }
  return view;
}
