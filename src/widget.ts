export const widgetUri = 'ui://codex-monitor/status-v022.html';
export const widgetMeta = {
  ui: { resourceUri: widgetUri },
  // Codex 0.166 records mcpAppUi only with an explicit display preference.
  'openai/ui': { preferredModelDisplayMode: 'inline' },
};
// Self-contained MCP Apps view. No CDN, external fetch, workload HTML or model messages.
export const widgetHtml = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{color-scheme:light dark;font:14px/1.5 system-ui,sans-serif;color:var(--color-text-primary,light-dark(#19212b,#e8ecf0));background:var(--color-background-primary,light-dark(#fff,#171c22))}
*{box-sizing:border-box}body{margin:0;padding:18px}header,.toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}h1{font-size:17px;margin:0}h2{font-size:14px;margin:18px 0 8px}.muted,small{color:light-dark(#586271,#aab5c5)}.badge{padding:3px 9px;border-radius:20px;background:light-dark(#e8edf5,#293442);font-size:12px}.ok{background:light-dark(#dcf4e9,#193c30)}.warn{background:light-dark(#fff0cc,#4d3820)}.error{background:light-dark(#ffe5e5,#4c2428)}
.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:16px 0}.metric,article{border:1px solid light-dark(#dce2ea,#38414f);border-radius:10px;padding:10px}.metric strong{display:block;font-size:24px;line-height:1.2}.metric span{font-size:12px}.list{display:grid;gap:8px;max-height:270px;overflow:auto}.row{display:flex;justify-content:space-between;gap:8px;align-items:baseline}.label{overflow-wrap:anywhere;min-width:0}.details{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;margin-top:5px}.toolbar{margin-top:16px}button{font:inherit;border:1px solid light-dark(#cbd3df,#536174);border-radius:7px;padding:5px 10px;color:inherit;background:transparent;cursor:pointer}button:focus-visible{outline:2px solid #4b91f1;outline-offset:2px}button:disabled{opacity:.55;cursor:default}#notice{margin:10px 0}#operation{margin-top:12px}#updated{margin-top:10px;font-size:11px}#timeline{max-height:290px}.empty{padding:10px 0}.error-text{color:light-dark(#a92b30,#ff9696)}@media(max-width:420px){body{padding:12px}.metrics{grid-template-columns:repeat(2,1fr)}}
</style></head><body>
<header><h1>Codex Monitor</h1><span class="badge" id="connection">Snapshot</span></header>
<article id="operation" hidden></article><p id="notice" class="muted" role="status">Waiting for a tool result…</p>
<section id="event-card" class="list" aria-label="Triggered workload events" hidden></section>
<section class="metrics" aria-label="Monitor counts" id="counts"></section>
<div id="policy" class="details"></div><h2>Monitors</h2><section id="monitors" class="list"></section>
<div class="toolbar"><h2>State changes</h2><button id="live" disabled>Start live updates</button></div>
<section id="timeline" class="list" aria-label="State change history"></section><div id="updated" class="muted"></div>
<script>
(() => {
  const $ = id => document.getElementById(id);
  const pending = new Map(); let nextId=0, initialized=false, received=false, report=null, thread=null, running=false, wanted=false, disposed=false;
  const clean = value => String(value ?? '—').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,' ').slice(0,500);
  const date = value => typeof value==='number' && Number.isFinite(value) && Math.abs(value)<=8640000000000000 ? new Date(value).toLocaleString() : '—';
  const el = (tag,text,cls) => { const node=document.createElement(tag); if(text!==undefined)node.textContent=clean(text);if(cls)node.className=cls;return node; };
  const notify = (method,params) => window.parent.postMessage({jsonrpc:'2.0',method,params},'*');
  function request(method,params) {
    return new Promise((resolve,reject) => {
      const id=++nextId, timer=setTimeout(()=>{pending.delete(id);reject(Error('Host request timed out'));},35000);
      pending.set(id,{resolve,reject,timer}); window.parent.postMessage({jsonrpc:'2.0',id,method,params},'*');
    });
  }
  function status(text,warning=false) { $('connection').textContent=text; $('connection').className='badge '+(warning?'warn':'ok'); }
  function render(r) {
    if(!r || r.type!=='monitor_report')return;
    report=r; thread=r.thread_id; $('live').disabled=!initialized;
    $('counts').replaceChildren(...[['Active',r.summary.active],['Stopped',r.summary.stopped],['Needs review',r.summary.failed_or_unknown],['Events',r.summary.unhandled_events]].map(([label,n])=>{const box=el('div',undefined,'metric');box.append(el('strong',n),el('span',label));return box;}));
    $('notice').textContent=r.verified?(r.warnings||[]).join(' '):'Saved state only — live supervision is not verified. '+(r.warnings||[]).join(' ');
    const recovery=r.recovery||{};
    $('policy').textContent='Wait: '+clean(r.wait?.state||'none')+' · Recovery: '+clean(recovery.state||'disabled')+(recovery.enabled?' · '+clean(recovery.attempts||0)+' attempts · retry every '+clean((recovery.policy?.retry_interval_ms||0)/1000)+' s · next '+date(recovery.next_retry_at):'');
    const verbose=r.display_mode==='verbose', monitors=(r.monitors||[]).filter(m=>verbose||['armed','starting','stopping','failed','unknown'].includes(m.state));
    $('monitors').replaceChildren(...monitors.map(m=>{const card=el('article'),row=el('div',undefined,'row');row.append(el('strong',m.name,'label'),el('span',m.state,'badge'));card.append(row,el('div','Deadline: '+date(m.deadline)+(m.latest_event?' · '+clean(m.latest_event.event_type):''),'details'));return card;}));
    if(!monitors.length)$('monitors').append(el('div','No active monitors.','muted empty'));
    const changes=(r.changes||[]).filter(c=>verbose||!['starting','sending'].includes(c.state));
    $('timeline').replaceChildren(...[...changes].reverse().slice(0,verbose?128:8).map(c=>{const card=el('article'),row=el('div',undefined,'row');row.append(el('strong',c.name||c.event_type||c.category,'label'),el('span',c.state,'badge'));card.append(row,el('div',(c.previous_state?clean(c.previous_state)+' → ':'')+clean(c.state)+(c.processing?' · '+clean(c.processing):''),'details'),el('small',date(c.at)+' · #'+clean(c.revision)));return card;}));
    if(!r.changes?.length)$('timeline').append(el('div','No recorded state changes.','muted empty'));
    if(r.changes_omitted)$('timeline').append(el('small',r.changes_omitted+' older changes omitted (bounded history).'));
    $('updated').textContent='Updated '+date(r.checked_at)+' · '+clean(r.source)+' · '+clean(r.thread_id);
    notify('ui/notifications/size-changed',{height:Math.ceil(document.documentElement.getBoundingClientRect().height)});
  }
  function receive(result) {
    const view=result?._meta?.monitorView;
    if(view) {
      const card=$('operation');card.hidden=false;card.replaceChildren(el('strong',view.title));
      const data=view.result||{};const details=view.isError?(data.error?.message||data.error||'Request failed'):(data.state|| (data.valid===true?'Validation passed':data.valid===false?'Validation failed':''));
      if(details)card.append(el('div',details,view.isError?'details error-text':'details'));
      if(data.name)card.append(el('div',data.name,'details'));
      const events=$('event-card');events.hidden=view.tool!=='monitor_event';events.replaceChildren();
      if(view.tool==='monitor_event')for(const e of data.events||[]){
        const alert=['watchdog_stalled','monitor_error','monitor_expired'].includes(e.event_type)||(e.event_type==='command_exit'&&e.evidence?.returncode!==0);
        const item=el('article'),row=el('div',undefined,'row');
        row.append(el('strong',e.name||e.monitor_id,'label'),el('span',e.actionable?'Needs review':e.state,'badge '+(alert?'warn':'ok')));
        item.append(row,el('div',clean(e.event_type).replaceAll('_',' ')+(e.evidence?.returncode!==undefined?' · exit '+clean(e.evidence.returncode):''),'details'),el('small','Triggered '+date(e.occurred_at)));
        events.append(item);
      }
      if(view.report)render(view.report);
    }
    if(result?.structuredContent?.type==='monitor_report')render(result.structuredContent);
    if(!received && view?.tool==='monitor_report' && report?.live_updates)wanted=true;
    received=true;
    pump();
  }
  async function pump() {
    if(running||!wanted||!initialized||!thread||document.hidden||disposed)return;
    running=true; $('live').textContent='Pause live updates';
    try {
      while(wanted&&!document.hidden&&!disposed) {
        status('Live');
        const result=await request('tools/call',{name:'monitor_report',arguments:{thread_id:thread,...(report?.live_updates?{after_revision:report.revision,wait_ms:25000}:{})}});
        if(result?.isError)throw Error('Live report unavailable');
        const next=result?.structuredContent;
        if(!next || next.thread_id!==thread)throw Error('Invalid report response');
        render(next);
        if(!next.live_updates){wanted=false;status('Snapshot · reconnect to retry',true);break;}
      }
    } catch(error) {wanted=false;status('Disconnected',true);$('notice').textContent=clean(error.message||'Live updates unavailable.');}
    finally {running=false;$('live').textContent=wanted?'Pause live updates':'Start live updates';}
  }
  $('live').onclick=()=>{wanted=!wanted;if(wanted)pump();else{$('live').textContent='Start live updates';status('Paused');}};
  document.addEventListener('visibilitychange',()=>{if(document.hidden)status('Hidden · updates paused');else pump();});
  window.addEventListener('pagehide',()=>{disposed=true;wanted=false;for(const [id,p]of pending){clearTimeout(p.timer);p.reject(Error('View closed'));pending.delete(id);}});
  window.addEventListener('message',event=>{
    if(event.source!==window.parent)return;const m=event.data;if(!m||m.jsonrpc!=='2.0')return;
    if(m.id!==undefined && pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(m.error):p.resolve(m.result);return;}
    if(m.method==='ui/notifications/tool-result')receive(m.params);
    if(m.method==='ui/notifications/tool-input'){const candidate=m.params?.arguments?.thread_id||m.params?.thread_id;if(!thread&&typeof candidate==='string')thread=candidate;}
    if(m.method==='ui/resource-teardown'){disposed=true;wanted=false;window.parent.postMessage({jsonrpc:'2.0',id:m.id,result:{}},'*');}
  });
  request('ui/initialize',{appInfo:{name:'codex-monitor',version:'0.2.3'},appCapabilities:{},protocolVersion:'2026-01-26'}).then(()=>{
    initialized=true;notify('ui/notifications/initialized',{});$('live').disabled=!thread;pump();
  }).catch(()=>{status('Snapshot only',true);$('notice').textContent='This host does not provide the MCP Apps bridge. Use the native tool result.';});
})();
</script></body></html>`;
