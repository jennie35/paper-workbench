// Derived presentation data only: a finished batch is not necessarily a full batch.
export const activeStatuses = new Set(['queued', 'running']);
export const needsEvidence = new Set(['pending', 'no_fulltext', 'unverified']);

export function summarizeBatch(job) {
  const checkpoint = job.checkpoint || {};
  const candidates = checkpoint.candidates || [];
  const complete = (checkpoint.completed || []).length;
  const reused = (checkpoint.reused || []).length;
  const count = status => candidates.filter(item => item.status === status).length;
  return {
    target: job.requested, complete, reused, total: candidates.length,
    missingFulltext: count('no_fulltext'), unverified: count('unverified'),
    excluded: count('excluded'), pending: count('pending'),
    shortfall: Math.max(0, job.requested - complete),
    active: activeStatuses.has(job.status),
    full: job.status === 'completed' && complete >= job.requested,
    diagnostics: [...new Set(checkpoint.diagnostics || [])],
  };
}

export function batchOutcome(job) {
  const result = summarizeBatch(job);
  if (result.active) return job.status === 'queued' ? '等待开始' : '正在检索与分析';
  if (job.status === 'failed') return '任务中断，进度已保留';
  if (job.status === 'cancelled') return '任务已取消，进度已保留';
  return result.full ? `已完成 ${result.complete} 篇精读` : `批次结束，仍缺 ${result.shortfall} 篇精读`;
}

export function candidateMatches(candidate, filter, query = '') {
  if (filter === 'needs' && !needsEvidence.has(candidate.status)) return false;
  if (filter !== 'all' && filter !== 'needs' && candidate.status !== filter) return false;
  const haystack = [candidate.title, candidate.doi, candidate.abstract, ...(candidate.authors || [])].join(' ').toLocaleLowerCase();
  return !query.trim() || haystack.includes(query.trim().toLocaleLowerCase());
}

export function paperIdsForBatch(job) {
  return new Set([...(job?.checkpoint?.completed || []), ...(job?.checkpoint?.reused || [])]);
}
