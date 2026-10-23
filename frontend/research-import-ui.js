const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function importPreviewHtml(records){
  return records.map((record,index)=>{const meta=record.metadata||record.paper||record,possible=record.possible_duplicates||[],warnings=record.warnings||[];return `<label class="import-record"><input type="checkbox" data-import-id="${esc(record.id??record.key??index)}" ${possible.length?'':'checked'}><span><strong>${esc(meta.title)}</strong><small>${esc((meta.authors||[]).join(' · '))} ${esc(meta.year||'')} ${esc(meta.doi||'')} ${record.duplicate?' · 已有记录，将关联或修订':''}</small>${warnings.map(w=>`<small class="import-warning">${esc(w)}</small>`).join('')}${possible.length?`<small class="import-warning">疑似简繁或题名别名重复，请核对后手动勾选：${possible.map(item=>esc(typeof item==='string'?item:item.title||item.paper_id||item.id||JSON.stringify(item))).join('；')}</small>`:''}</span></label>`;}).join('');
}
export function openResearchImport({project,api,showModal,onDone,notify}){
  showModal('IMPORT · 题录与研究库',`<h2>导入文献资料</h2><p>选择 RIS、BibTeX、EndNote XML 或此前导出的浏览器课题 JSON。先核对题录，再确认导入；导入记录不计为本批新增论文。</p><form id="researchImportForm"><label class="outline upload-button">选择题录或研究库文件<input id="researchImportFile" type="file" accept=".ris,.bib,.bibtex,.xml,.json" required></label><p role="status" id="researchImportStatus"></p><div id="researchImportPreview"></div><div class="form-actions"><button class="primary" id="researchImportSubmit" type="submit">读取并预览</button></div></form>`);
  const form=document.getElementById('researchImportForm'),status=document.getElementById('researchImportStatus'),preview=document.getElementById('researchImportPreview'),submit=document.getElementById('researchImportSubmit');let staged=null;
  const selected=()=>[...preview.querySelectorAll('input[data-import-id]:checked')].map(input=>input.dataset.importId);
  document.getElementById('researchImportFile').onchange=()=>{staged=null;preview.replaceChildren();submit.textContent='读取并预览';};
  form.onsubmit=async event=>{
    event.preventDefault();submit.disabled=true;
    try{
      if(!staged){
        const file=document.getElementById('researchImportFile').files[0];if(!file)throw new Error('请选择文件');
        const data=new FormData();data.append('file',file);status.textContent='正在解析题录…';
        staged=await api(`/api/projects/${project.id}/imports/preview`,{method:'POST',body:data});if(!form.isConnected)return;
        const records=staged.records||staged.items||[];
        preview.innerHTML=importPreviewHtml(records);
        status.textContent=`已读取 ${records.length} 条。确认后保存题录；论文 PDF 可在资料面板逐篇添加。`;
        submit.textContent='确认导入所选记录';
      }else{
        const ids=selected();if(!ids.length)throw new Error('至少选择一条记录');
        await api(`/api/projects/${project.id}/imports/confirm`,{method:'POST',body:JSON.stringify({preview_id:staged.preview_id,selected:ids})});
        if(!form.isConnected)return;status.textContent='已保存。可在资料面板补充正文并开始分析。';notify?.('题录已导入，未计为新增分析。');await onDone?.();submit.textContent='导入完成';staged=null;
      }
    }catch(error){if(form.isConnected)status.textContent=error.message;}
    finally{if(form.isConnected)submit.disabled=false;}
  };
}
export function renderImportedSources({container,records=[],project,api,onDone,onAnalyze}){
  container.hidden=!records.length;if(!records.length)return;
  container.innerHTML=`<details class="panel"><summary>导入资料 · ${records.length} 篇待处理论文</summary><p>先逐篇补充论文正文，再选择需要分析的条目。导入与补读不计联网新增。</p>${records.map(record=>`<div class="import-source-row"><label class="import-record"><input type="checkbox" data-import-candidate="${esc(record.id)}"><span><strong>${esc(record.title)}</strong><small>${esc((record.authors||[]).join(' · '))} ${esc(record.year||'')}</small></span></label><label class="outline upload-button">${record.user_pdf_path?'更新正文 PDF':'添加论文正文 PDF'}<input class="sr-only" type="file" accept=".pdf,application/pdf" data-import-pdf="${esc(record.id)}"></label><p role="status" data-import-feedback="${esc(record.id)}"></p></div>`).join('')}<button class="primary" data-analyze-imports>分析所选导入论文</button><p role="status" data-import-analysis-status></p></details>`;
  container.querySelectorAll('[data-import-pdf]').forEach(input=>input.onchange=async()=>{
    const file=input.files[0];if(!file)return;input.disabled=true;const feedback=[...container.querySelectorAll('[data-import-feedback]')].find(el=>el.dataset.importFeedback===input.dataset.importPdf);
    try{const data=new FormData();data.append('file',file);await api(`/api/projects/${project.id}/candidates/${encodeURIComponent(input.dataset.importPdf)}/source`,{method:'POST',body:data});feedback.textContent='正文已保存，尚未调用模型。';input.closest('label').firstChild.textContent='更新正文 PDF';}
    catch(error){feedback.textContent=error.message;}finally{if(input.isConnected)input.disabled=false;}
  });
  container.querySelector('[data-analyze-imports]').onclick=async event=>{
    const button=event.currentTarget,status=container.querySelector('[data-import-analysis-status]');button.disabled=true;
    try{const selected=[...container.querySelectorAll('[data-import-candidate]:checked')].map(input=>input.dataset.importCandidate);if(!selected.length||selected.length>20)throw new Error('请选择1–20篇论文');
      const job=await api(`/api/projects/${project.id}/imports/analyze`,{method:'POST',body:JSON.stringify({selected})});await onDone?.();await onAnalyze?.(job.job_id||job.id);
    }catch(error){if(status.isConnected)status.textContent=error.message;}finally{if(button.isConnected)button.disabled=false;}
  };
}
