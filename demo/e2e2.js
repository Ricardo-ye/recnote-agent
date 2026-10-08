/* e2e2.js — 专门验证去重 / 合并 / 增量归并链路（产品的差异化核心） */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(p=>fs.existsSync(p));
const PORT = 9355;
const OUT = path.join(__dirname, 'shots'); fs.mkdirSync(OUT, { recursive: true });
const get = (url, isNew) => new Promise((res, rej) => { const req = http.request(url, { method: isNew ? 'PUT' : 'GET' }, r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>res(JSON.parse(d))); }); req.on('error', rej); req.end(); });

(async () => {
  const proc = spawn(CHROME, ['--headless=new','--disable-gpu','--no-first-run','--remote-debugging-port='+PORT,'--user-data-dir='+path.join(__dirname,'.cdp-e2e2'),'--window-size=1440,1000','about:blank'], {stdio:'ignore'});
  let ws=null;
  for(let i=0;i<80;i++){
    try { const l=await get('http://127.0.0.1:'+PORT+'/json/new?about:blank',true); if(l && l.webSocketDebuggerUrl){ws=l.webSocketDebuggerUrl;break;} } catch(e){}
    await new Promise(r=>setTimeout(r,300));
  }
  if(!ws){ console.log('CDP_FAIL'); proc.kill(); process.exit(3); }
  const u=new URL(ws); const key=crypto.randomBytes(16).toString('base64');
  const sock=net.connect(u.port,u.hostname); let buf=Buffer.alloc(0); let id=0; const pending=new Map();
  await new Promise(r=>sock.once('connect',r));
  sock.write('GET '+u.pathname+' HTTP/1.1\r\nHost: '+u.host+'\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: '+key+'\r\nSec-WebSocket-Version: 13\r\n\r\n');
  await new Promise(r=>{let acc=Buffer.alloc(0);const on=(c)=>{acc=Buffer.concat([acc,c]);if(acc.includes(Buffer.from('\r\n\r\n'))){sock.off('data',on);buf=acc.slice(acc.indexOf(Buffer.from('\r\n\r\n'))+4);r();}};sock.on('data',on);});
  function frame(str){const p=Buffer.from(str,'utf8');const len=p.length;let head;if(len<126)head=Buffer.from([0x81,0x80|len]);else if(len<65536){head=Buffer.alloc(4);head[0]=0x81;head[1]=0x80|126;head.writeUInt16BE(len,2);}else{head=Buffer.alloc(10);head[0]=0x81;head[1]=0x80|127;head.writeBigUInt64BE(BigInt(len),2);}const m=crypto.randomBytes(4);const mk=Buffer.from(p);for(let i=0;i<len;i++)mk[i]^=m[i%4];return Buffer.concat([head,m,mk]);}
  sock.on('data',c=>{buf=Buffer.concat([buf,c]);while(buf.length>=2){const l0=buf[1]&127;let off=2,len=l0;if(l0===126){if(buf.length<4)return;len=buf.readUInt16BE(2);off=4;}else if(l0===127){if(buf.length<10)return;len=Number(buf.readBigUInt64BE(2));off=10;}if(buf.length<off+len)return;const msg=JSON.parse(buf.slice(off,off+len).toString('utf8'));buf=buf.slice(off+len);if(msg.id&&pending.has(msg.id)){pending.get(msg.id)(msg);pending.delete(msg.id);}}});
  const send=(m,p)=>new Promise(res=>{const i=++id;pending.set(i,res);sock.write(frame(JSON.stringify({id:i,method:m,params:p||{}})));});
  const ev=async e=>{const r=await send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true});if(r.result&&r.result.exceptionDetails){const d=r.result.exceptionDetails;throw new Error((d.exception&&d.exception.description)||d.text);}return r.result&&r.result.result?r.result.result.value:undefined;};
  const shot=async n=>{const r=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(OUT,n+'.png'),Buffer.from(r.result.data,'base64'));};
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const log=[]; const T=(n,v)=>{const line=n+' = '+JSON.stringify(v);log.push(line);console.log(line);};

  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate',{url:'http://127.0.0.1:8791/index.html'});
  await sleep(2500);

  // 清空演示数据，从零构造受控场景
  // 清空演示数据（保留分类体系），从零构造受控场景。
  // 注意：首屏在空库时会自动 seed 并跑管线，所以要在同一会话内清空后立刻建素材，不再刷新页面。
  await ev(`(function(){
    var keepCats=Store.db.categories;
    Store.db=Store.emptyDB();
    Store.db.categories=keepCats;
    Store.persist();
    return 'cleared';
  })()`);
  T('reset_sources', await ev('Store.db.sources.length'));
  T('reset_notes', await ev('Store.db.notes.length'));
  T('pipeline_smoke', await ev(`(function(){
    try {
      var r=Store.addSource({title:'冒烟测试素材', source_type:'interview', raw_text:'张：我们的知识库检索太慢，准确率只有六成，希望提升召回率。\\n张：我最想要的是自动把待办挑出来，负责人和时间都要有。'});
      if(r.error) return 'DUP:'+r.error;
      var run=Agent.run(r.source.id, null);
      return {segments:run.stats.segments, auto:run.stats.autoCreated, pending:run.stats.pending, notes:Store.db.notes.length, tags:Store.allTags().map(t=>t.name)};
    } catch(e){ return 'THROW: '+e.message+' | '+String(e.stack).slice(0,200); }
  })()`));
  // 清理冒烟素材
  await ev(`(function(){ Store.db.sources=[]; Store.db.segments=[]; Store.db.notes=[]; Store.db.versions=[]; Store.db.tags=[]; Store.db.noteTags=[]; Store.db.suggestions=[]; Store.db.runs=[]; Store.persist(); return 1;})()`);

  // 场景：两段内容高度重叠的访谈（同主题续篇），应触发疑似重复 / 合并建议
  const s1 = '访谈者：你们现在怎么记录会议？\n受访者 A：我们完全靠人工誊写，会议一多就丢。\n受访者 A：我最想要的是自动把待办挑出来，负责人和时间都要有。\n访谈者：能接受机器自动分类吗？\n受访者 A：可以给建议，但我一定要能改。改了什么必须能看到，不然我不敢用。';
  const s2 = '访谈者：那你们团队后来怎么解决的？\n受访者 A：后来还是靠人工誊写，会议一多就丢。\n受访者 A：我最想要的是自动把待办挑出来，负责人和时间都要有。\n访谈者：能接受机器自动分类吗？\n受访者 A：可以给建议，但我一定要能改。改了什么必须能看到，不然我不敢用。';

  await ev(`RecNote.go('ingest')`); await sleep(300);
  // 素材 1
  await ev(`
    document.getElementById('in-title').value='用户访谈 · 知识库管理者 A';
    document.getElementById('in-type').value='interview';
    document.getElementById('in-text').value=${JSON.stringify(s1)};
    document.getElementById('btn-run').click(); 'x'`);
  await sleep(1000);
  const s1n = await ev('Store.db.notes.length'); T('s1_notes', s1n);
  T('s1_active', await ev('Store.activeNotes().length'));
  T('s1_pending', await ev('Store.pendingSuggestions().length'));

  // 全部接受第一条素材的待确认（每轮只点第一张卡，等重渲染后再取，避免同一建议被重复点击）
  await ev(`RecNote.go('inbox')`); await sleep(400);
  T('s1_all_sugs', await ev(`(function(){var s=Store.db.suggestions;return {total:s.length, byStatus:s.reduce(function(a,x){a[x.status]=(a[x.status]||0)+1;return a;},{}), createdNoteIds:s.map(x=>x.created_note_id).filter(Boolean).length, uniqueNotes:new Set(s.map(x=>x.created_note_id).filter(Boolean)).size};})()`));
  const acceptLoop = await ev(`
    (function(){
      var n=0;
      for(var i=0;i<40;i++){
        var cards=document.querySelectorAll('#view .sug');
        if(!cards.length) break;
        var btn=cards[0].querySelector('[data-act="accept"]');
        if(!btn) break;
        btn.click(); n++;
      }
      return n;
    })()`);
  await sleep(800);
  T('accept_clicks', acceptLoop);
  T('after_accept_all_notes', await ev('Store.db.notes.length'));
  T('after_accept_all_pending', await ev('Store.pendingSuggestions().length'));
  T('accepted_unique_notes', await ev('(function(){var s=Store.db.suggestions.filter(x=>x.status==="accepted");return s.length;})()'));

  // 素材 2：同主题续篇
  await ev(`RecNote.go('ingest')`); await sleep(300);
  await ev(`
    document.getElementById('in-title').value='用户访谈 · 知识库管理者 A（回访）';
    document.getElementById('in-type').value='interview';
    document.getElementById('in-text').value=${JSON.stringify(s2)};
    document.getElementById('btn-run').click(); 'x'`);
  await sleep(1200);
  T('s2_pending', await ev('Store.pendingSuggestions().length'));
  T('s2_dup_suggestions', await ev('Store.db.suggestions.filter(s=>s.duplicate_note_id).length'));
  T('s2_dup_detail', await ev(`JSON.stringify(Store.db.suggestions.filter(s=>s.duplicate_note_id).map(s=>({sim:+s.similarity.toFixed(3), merge:s.is_merge_candidate, target:s.duplicate_note_title})))`));
  T('s2_merge_threshold_cfg', await ev('Store.config.mergeThreshold'));

  await ev(`RecNote.go('inbox')`); await sleep(500);
  T('inbox_dup_box', await ev('document.querySelectorAll(".dup-box").length'));
  T('inbox_merge_btn', await ev('document.querySelectorAll(\'[data-act="merge"]\').length'));
  await shot('20-dup-detected');

  // 检索：标签语法用真实存在的标签
  await ev(`RecNote.go('search')`); await sleep(500);
  const aTag = await ev('(Store.allTags()[0]||{}).name');
  T('real_tag', aTag);
  await ev(`var sq=document.getElementById('sq');sq.value=${JSON.stringify('标签:'+(aTag||''))};document.getElementById('btn-do-search').click();'x'`);
  await sleep(400);
  T('search_by_real_tag', await ev('document.querySelectorAll(".sr-item").length'));
  T('search_facets', await ev('document.querySelector(".facets") ? document.querySelector(".facets").textContent.replace(/\\s+/g," ").slice(0,120) : "NONE"'));

  // 合并动作：先跳到 Inbox 再取按钮（按钮在 render 后才存在）
  await ev(`RecNote.go('inbox')`); await sleep(500);
  const mergeBtn = await ev(`(function(){var b=document.querySelector('[data-act="merge"]');return b?b.dataset.sug:null;})()`);
  T('merge_btn_sug_id', mergeBtn);
  if (mergeBtn) {
    const before = await ev(`(function(){
      var s=Store.byId('suggestions','${mergeBtn}');
      var t=Store.byId('notes',s.duplicate_note_id);
      return {sugStatus:s.status, targetId:t.id, targetSources:t.source_ids.length, targetStatus:t.status, targetVersions:t.version_count, totalNotes:Store.db.notes.length};
    })()`);
    T('merge_before', before);
    await ev(`document.querySelector('[data-act="merge"]').click()`);
    await sleep(700);
    const after = await ev(`(function(){
      var s=Store.byId('suggestions','${mergeBtn}');
      var t=Store.byId('notes','${before.targetId}');
      return {sugStatus:s.status, targetSources:t.source_ids.length, targetStatus:t.status, targetVersions:t.version_count,
              totalNotes:Store.db.notes.length, supersededCount:Store.db.notes.filter(n=>n.status==='superseded').length,
              mergedInto:t.merged_into, lastChangeType:t.version_count?Store.versionsOf(t.id)[t.version_count-1].change_type:null,
              bodyHasBoth:(t.body||'').indexOf('回访')>=0 || (t.body||'').length>200};
    })()`);
    T('merge_after', after);
    // 溯源：合并后应能追到两个素材
    T('merged_trace_sources', await ev(`Store.byId('notes','${before.targetId}').source_ids.length`));
    await shot('21-merged');
  } else {
    T('merge', 'NO_MERGE_BUTTON');
  }

  // superseded 笔记应从活跃列表消失、但仍可访问
  T('active_vs_superseded', await ev(`(function(){
    return {active:Store.activeNotes().length, superseded:Store.db.notes.filter(n=>n.status==='superseded').length,
            total:Store.db.notes.length, trash:Store.trashedNotes().length};
  })()`));

  // 回收站：软删 + 恢复
  await ev(`(function(){var n=Store.activeNotes()[0]; Store.softDelete(n.id); return n.id;})()`);
  T('after_softdelete', await ev(`(function(){return {active:Store.activeNotes().length, trash:Store.trashedNotes().length};})()`));
  const tid = await ev('Store.trashedNotes()[0].id');
  await ev(`Store.restore('${tid}')`);
  T('after_restore', await ev(`(function(){return {active:Store.activeNotes().length, trash:Store.trashedNotes().length};})()`));

  // 标签治理：合并标签
  const tg = await ev('JSON.stringify(Store.allTags().slice(0,3).map(t=>({id:t.id,name:t.name,n:t.usage_count})))');
  T('tags_before_merge', JSON.parse(tg));
  const two = JSON.parse(tg);
  if (two.length >= 2) {
    await ev(`Store.mergeTag('${two[0].id}','${two[1].id}')`);
    T('tags_after_merge', await ev(`(function(){return {count:Store.db.tags.length, gone:!Store.byId('tags','${two[0].id}'), targetName:Store.byId('tags','${two[1].id}').name, targetUsage:Store.byId('tags','${two[1].id}').usage_count};})()`));
  }

  // 分类新建 → 重跑 → 检查是否影响既有笔记分类
  const newCat = await ev(`(function(){var c=Store.addCategory({name:'成本与预算',color:'#ef4444',keywords:['成本','预算','财务','对齐','花钱']});return c.id;})()`);
  await ev(`Agent.reprocess()`); await sleep(1500);
  T('new_cat_effect', await ev(`(function(){return {catAdded:true, notesInNewCat:Store.db.notes.filter(n=>n.category_id==='${newCat}').length, totalNotes:Store.db.notes.length};})()`));
  T('reprocess_runs_total', await ev('Store.runs().length'));

  // 导出 / 导入往返
  T('export_roundtrip', await ev(`(function(){
    var json=Store.exportJSON();
    var beforeN=Store.db.notes.length, beforeV=Store.db.versions.length;
    Store.db=Store.emptyDB();
    Store.importJSON(json,'replace');
    return {exportBytes:json.length, beforeNotes:beforeN, afterNotes:Store.db.notes.length, beforeVersions:beforeV, afterVersions:Store.db.versions.length, ok:beforeN===Store.db.notes.length && beforeV===Store.db.versions.length};
  })()`));

  await ev(`RecNote.go('library')`); await sleep(500);
  await shot('22-library-final');
  await ev(`RecNote.go('dashboard')`); await sleep(400);
  await shot('23-dashboard-final');

  console.log(log.join('\n'));
  fs.writeFileSync(path.join(__dirname,'e2e2-report.txt'), log.join('\n'));
  proc.kill(); process.exit(0);
})().catch(e=>{console.log('FATAL: '+e.message);process.exit(1);});
