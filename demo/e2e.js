/* e2e.js — 用 CDP 驱动无头 Chrome 跑通端到端链路 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
].find(p => fs.existsSync(p));

const URL_APP = 'http://127.0.0.1:8791/index.html';
const PORT = 9333;
const OUT = path.join(__dirname, 'shots');
fs.mkdirSync(OUT, { recursive: true });

const get = (url, isNew) => new Promise((res, rej) => {
  const req = http.request(url, { method: isNew ? 'PUT' : 'GET' }, r => {
    let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d)));
  });
  req.on('error', rej); req.end();
});

(async () => {
  if (!CHROME) { console.log('NO_CHROME'); return; }
  const proc = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + path.join(__dirname, '.cdp-profile'),
    '--window-size=1440,1000', 'about:blank'
  ], { stdio: 'ignore' });

  // 等 CDP 就绪
  let ws = null;
  for (let i = 0; i < 60; i++) {
    try { const list = await get('http://127.0.0.1:' + PORT + '/json/new?about:blank', true); if (list.webSocketDebuggerUrl) { ws = list.webSocketDebuggerUrl; break; } } catch (e) {}
    await new Promise(r => setTimeout(r, 300));
  }
  if (!ws) { console.log('CDP_FAIL'); proc.kill(); return; }

  // 极简 WebSocket 客户端
  const net = require('net');
  const crypto = require('crypto');
  const u = new URL(ws);
  const key = crypto.randomBytes(16).toString('base64');
  const sock = net.connect(u.port, u.hostname);
  let buf = Buffer.alloc(0); let id = 0; const pending = new Map();
  await new Promise(r => sock.once('connect', r));
  sock.write('GET ' + u.pathname + ' HTTP/1.1\r\nHost: ' + u.host + '\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ' + key + '\r\nSec-WebSocket-Version: 13\r\n\r\n');
  await new Promise(r => { let acc = Buffer.alloc(0); const on = (c) => { acc = Buffer.concat([acc, c]); if (acc.includes(Buffer.from('\r\n\r\n'))) { sock.off('data', on); buf = acc.slice(acc.indexOf(Buffer.from('\r\n\r\n')) + 4); r(); } }; sock.on('data', on); });

  function frame(str) {
    const payload = Buffer.from(str, 'utf8');
    const len = payload.length;
    let head;
    if (len < 126) head = Buffer.from([0x81, 0x80 | len]);
    else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 0x80 | 126; head.writeUInt16BE(len, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(len), 2); }
    const mask = crypto.randomBytes(4);
    const masked = Buffer.from(payload); for (let i = 0; i < len; i++) masked[i] ^= mask[i % 4];
    return Buffer.concat([head, mask, masked]);
  }
  sock.on('data', c => {
    buf = Buffer.concat([buf, c]);
    while (buf.length >= 2) {
      const len0 = buf[1] & 127; let off = 2, len = len0;
      if (len0 === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len0 === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (buf.length < off + len) return;
      const msg = JSON.parse(buf.slice(off, off + len).toString('utf8'));
      buf = buf.slice(off + len);
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    }
  });
  const send = (method, params) => new Promise(res => { const i = ++id; pending.set(i, res); sock.write(frame(JSON.stringify({ id: i, method, params: params || {} }))); });
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.result.data, 'base64'));
  };
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate', { url: URL_APP });
  await sleep(2200);

  const log = [];
  const T = (name, val) => { const line = name + ' = ' + JSON.stringify(val); log.push(line); console.log(line); };

  // 1) 首屏 + 种子数据是否自动跑管线
  T('dashboard_title', await evalJs('document.getElementById("page-title").textContent'));
  T('stats', await evalJs('Array.from(document.querySelectorAll(".stat-v")).map(e=>e.textContent)'));
  // 2) 首屏已自动跑管线（首次打开）
  T('boot_runs', await evalJs('Store.runs().length'));
  T('boot_segments', await evalJs('Store.db.segments.length'));
  T('boot_notes', await evalJs('Store.db.notes.length'));
  T('boot_pending', await evalJs('Store.pendingSuggestions().length'));
  T('boot_dup', await evalJs('Store.db.suggestions.filter(s=>s.duplicate_note_id).length'));
  T('boot_conf_dist', await evalJs(`(function(){
    var ds=Store.db.suggestions.map(s=>s.category_confidence);
    return {min:Math.min.apply(null,ds).toFixed(2), max:Math.max.apply(null,ds).toFixed(2),
            aboveThreshold:ds.filter(d=>d>=Store.config.minConfidence).length, total:ds.length};
  })()`));
  T('boot_categories_used', await evalJs('JSON.stringify(Array.from(new Set(Store.db.notes.map(n=>Store.categoryName(n.category_id)))))'));
  await shot('01-dashboard');

  // 3) 重跑全部素材（幂等性 + 审计记录）
  await evalJs('RecNote.go("ingest")'); await sleep(400);
  T('ingest_sources_listed', await evalJs('document.querySelectorAll("#src-list tbody tr").length'));
  await evalJs('document.getElementById("btn-run-all").click()'); await sleep(2500);
  T('after_reprocess_runs', await evalJs('Store.runs().length'));
  T('reprocess_segments', await evalJs('Store.db.segments.length'));
  T('reprocess_notes', await evalJs('Store.db.notes.length'));
  T('reprocess_pending', await evalJs('Store.pendingSuggestions().length'));
  await shot('02-ingest');

  // 3) 摄入新素材（走 doRun 异步路径）
  await evalJs(`
    document.getElementById('in-title').value='客户访谈 · 运营负责人';
    document.getElementById('in-type').value='interview';
    document.getElementById('in-text').value='访谈者：你们现在的记录方式是什么？\\n受访者 R3：我们靠人工誊写，会议一多就丢。\\n受访者 R3：我最想要的是自动把待办挑出来，负责人和时间都要有。\\n访谈者：能接受机器自动分类吗？\\n受访者 R3：可以给建议，但我一定要能改。改了什么必须能看到，不然我不敢用。';
    document.getElementById('btn-run').click();
    'clicked'
  `);
  await sleep(1200);
  T('new_source_ingested', await evalJs('Store.db.sources.length'));
  T('pipe_steps_done', await evalJs('document.querySelectorAll(".ps.done").length'));
  T('pipe_report', await evalJs('document.querySelector("#pipe .pipe-summary") ? document.querySelector("#pipe .pipe-summary").textContent.replace(/\\s+/g," ") : "NONE"'));
  await shot('03-pipeline');

  // 4) 重复内容拦截
  await evalJs(`
    document.getElementById('in-text').value='访谈者：你们现在的记录方式是什么？\\n受访者 R3：我们靠人工誊写，会议一多就丢。\\n受访者 R3：我最想要的是自动把待办挑出来，负责人和时间都要有。\\n访谈者：能接受机器自动分类吗？\\n受访者 R3：可以给建议，但我一定要能改。改了什么必须能看到，不然我不敢用。';
    document.getElementById('btn-run').click(); 'x'
  `);
  await sleep(900);
  T('dup_guard_sources', await evalJs('Store.db.sources.length'));

  // 5) 确认队列
  await evalJs('RecNote.go("inbox")'); await sleep(500);
  T('inbox_cards', await evalJs('document.querySelectorAll(".sug").length'));
  T('inbox_bar', await evalJs('document.querySelector(".inbox-bar") ? document.querySelector(".inbox-bar").textContent.replace(/\\s+/g," ") : "NONE"'));
  T('has_dup_box', await evalJs('document.querySelectorAll(".dup-box").length'));
  T('has_slots', await evalJs('document.querySelectorAll(".slot").length'));
  await shot('04-inbox');

  // 6) 裁决：接受一条 / 改判一条 / 丢弃一条
  const before = await evalJs('Store.db.notes.length');
  await evalJs('document.querySelector(\'[data-act="accept"]\').click()'); await sleep(400);
  T('after_accept', { before, after: await evalJs('Store.db.notes.length') });
  T('accepted_note_has_version', await evalJs('(function(){var s=Store.db.suggestions.filter(function(x){return x.status==="accepted" && x.created_note_id;}).pop(); if(!s) return "NO_ACCEPTED_SUG"; var v=Store.versionsOf(s.created_note_id); return {noteId:s.created_note_id, versionCount:v.length, firstType:v[0] && v[0].change_type, tags:(Store.tagsOf(s.created_note_id)||[]).length};})()'));

  const recatExists = await evalJs('!!document.querySelector(\'[data-recat]\')');
  if (recatExists) {
    await evalJs(`
      var s=document.querySelector('[data-recat]');
      s.value=s.options[2].value;
      s.dispatchEvent(new Event('change')); 'ok'
    `);
    await sleep(400);
  }
  T('after_recategorize', await evalJs('Store.db.notes.length'));
  T('recat_version_type', await evalJs('(function(){var s=Store.db.suggestions.filter(function(x){return x.status==="accepted" && x.created_note_id;}).pop(); if(!s) return "NONE"; var v=Store.versionsOf(s.created_note_id); return v[v.length-1].change_type;})()'));

  const hasReject = await evalJs('!!document.querySelector(\'[data-act="reject"]\')');
  if (hasReject) { await evalJs('document.querySelector(\'[data-act="reject"]\').click()'); await sleep(350); }
  T('rejected_count', await evalJs('Store.db.suggestions.filter(s=>s.status==="rejected").length'));

  // 7) 合并建议
  const mergeInfo = await evalJs(`(function(){
    var m=document.querySelector('[data-act="merge"]');
    if(!m) return 'NO_MERGE_CANDIDATE';
    var sugId=m.dataset.sug;
    var s=Store.byId('suggestions',sugId);
    return {sugId:sugId, target:s.duplicate_note_id, sim:s.similarity};
  })()`);
  T('merge_candidate', mergeInfo);
  if (typeof mergeInfo === 'object') {
    const t0 = await evalJs(`(function(){var s=Store.byId('suggestions','${mergeInfo.sugId}');return {status:s.status, keepStatus:Store.byId('notes','${mergeInfo.target}').status, keepSources:Store.byId('notes','${mergeInfo.target}').source_ids.length};})()`);
    await evalJs('document.querySelector(\'[data-act="merge"]\').click()'); await sleep(500);
    const t1 = await evalJs(`(function(){var s=Store.byId('suggestions','${mergeInfo.sugId}');return {status:s.status, keepStatus:Store.byId('notes','${mergeInfo.target}').status, keepSources:Store.byId('notes','${mergeInfo.target}').source_ids.length, keepVersions:Store.versionsOf('${mergeInfo.target}').length};})()`);
    T('merge_before', t0); T('merge_after', t1);
  }
  await shot('05-inbox-after');

  // 8) 笔记库 + 筛选
  await evalJs('RecNote.go("library")'); await sleep(500);
  T('library_rows', await evalJs('document.querySelectorAll(".lib-table tbody tr").length'));
  T('library_cat_items', await evalJs('document.querySelectorAll("[data-fcat]").length'));
  await evalJs('document.querySelectorAll("[data-fcat]")[1].click()'); await sleep(400);
  T('after_cat_filter', await evalJs('document.querySelectorAll(".lib-table tbody tr").length'));
  await shot('06-library');
  await evalJs("RecNote.state.libFilter.cat=null;RecNote.state.libFilter.q='';RecNote.render()"); await sleep(300);

  // 9) 笔记详情：正文 / 溯源 / 版本
  const noteId = await evalJs('(Store.activeNotes()[0]||{}).id || null');
  T('active_notes_for_detail', await evalJs('Store.activeNotes().length'));
  T('all_note_statuses', await evalJs('JSON.stringify(Store.db.notes.map(n=>n.status))'));
  T('sources_count', await evalJs('Store.db.sources.length'));
  T('segments_count', await evalJs('Store.db.segments.length'));
  if (!noteId) {
    log.push('ABORT: no active notes left after in-box actions — dumping state');
    console.log(log.join('\n'));
    await shot('99-abort');
    proc.kill(); process.exit(2);
  }
  await evalJs('RecNote.go("note","' + noteId + '")'); await sleep(450);
  T('detail_title', await evalJs('document.getElementById("page-title").textContent'));
  T('detail_has_summary', await evalJs('!!document.querySelector(".sum-v")'));
  T('detail_body_len', await evalJs('document.querySelector(".note-body").textContent.length'));
  await shot('07-note-body');

  await evalJs('document.querySelector(\'[data-tab="trace"]\').click()'); await sleep(350);
  T('trace_src_blocks', await evalJs('document.querySelectorAll(".src-block").length'));
  T('trace_segments', await evalJs('document.querySelectorAll(".seg.compact").length'));
  await shot('08-note-trace');

  await evalJs('document.querySelector(\'[data-tab="version"]\').click()'); await sleep(350);
  T('version_rows', await evalJs('document.querySelectorAll(".ver").length'));
  await shot('09-note-version');

  // 10) 编辑 → diff 预览 → 保存 → 版本 +1
  const vBefore = await evalJs('Store.versionsOf("' + noteId + '").length');
  await evalJs(`
    document.getElementById('btn-edit').click();
    document.getElementById('ed-body').value = document.getElementById('ed-body').value + '\\n\\n补充：本次已与财务对齐成本口径。';
    document.getElementById('ed-note').value = '补充成本口径';
    document.getElementById('btn-ed-preview').click();
    document.getElementById('btn-ed-save').click(); 'ok'
  `);
  await sleep(600);
  T('edit_version_growth', { vBefore, vAfter: await evalJs('Store.versionsOf("' + noteId + '").length') });
  T('last_change_note', await evalJs('(function(){var v=Store.versionsOf("'+noteId+'");return v[v.length-1].change_note;})()'));
  T('last_diff', await evalJs('JSON.stringify((function(){var v=Store.versionsOf("'+noteId+'");return v[v.length-1].diff;})())'));

  // 11) 回滚（历史不可销毁）
  await evalJs('document.querySelector(\'[data-tab="version"]\').click()'); await sleep(300);
  const rbInfo = await evalJs(`(function(){var b=document.querySelector('[data-rb]');return b?b.dataset.rb:'NONE';})()`);
  T('rollback_button_version', rbInfo);
  T('confirm_override', await evalJs('window.confirm=function(){return true}; "patched"'));
  if (rbInfo !== 'NONE') {
    const nBefore = await evalJs('Store.versionsOf("' + noteId + '").length');
    await evalJs('document.querySelector(\'[data-rb]\').click()'); await sleep(500);
    T('rollback_result', { vBefore: nBefore, vAfter: await evalJs('Store.versionsOf("' + noteId + '").length') });
    T('rollback_last_type', await evalJs('(function(){var v=Store.versionsOf("'+noteId+'");return v[v.length-1].change_type;})()'));
  }

  // 12) 检索
  await evalJs('RecNote.go("search")'); await sleep(450);
  T('search_initial_hits', await evalJs('document.querySelectorAll(".sr-item").length'));
  await evalJs(`
    var sq=document.getElementById('sq');
    sq.value='召回';
    document.getElementById('btn-do-search').click(); 'ok'
  `);
  await sleep(400);
  T('search_recall_hits', await evalJs('document.querySelectorAll(".sr-item").length'));
  T('search_has_mark', await evalJs('document.querySelectorAll("mark").length'));
  T('search_meta', await evalJs('document.querySelector(".inbox-bar").textContent.replace(/\\s+/g," ")'));
  await shot('10-search');

  // 13) 查询语法
  await evalJs(`var sq=document.getElementById('sq');sq.value='标签:索引';document.getElementById('btn-do-search').click();'ok'`);
  await sleep(350);
  T('search_tag_syntax', await evalJs('document.querySelectorAll(".sr-item").length'));
  await evalJs(`var sq=document.getElementById('sq');sq.value='分类:技术方案';document.getElementById('btn-do-search').click();'ok'`);
  await sleep(350);
  T('search_cat_syntax', await evalJs('document.querySelectorAll(".sr-item").length'));

  // 14) 分类与标签治理
  await evalJs('RecNote.go("taxonomy")'); await sleep(400);
  T('taxonomy_cats', await evalJs('document.querySelectorAll("[data-cat-edit]").length'));
  T('taxonomy_tags', await evalJs('document.querySelectorAll("[data-tag-rename]").length'));
  T('taxonomy_keywords_shown', await evalJs('document.querySelectorAll(".cat-row .kw i").length'));
  // 删分类保护
  await evalJs('window.confirm=function(){return true};document.querySelector("[data-cat-del]").click()');
  await sleep(300);
  T('cat_delete_protected', await evalJs('Store.db.categories.length'));
  await shot('11-taxonomy');

  // 15) 设置页
  await evalJs('RecNote.go("settings")'); await sleep(400);
  T('settings_fields', await evalJs('document.querySelectorAll(".fl input,.fl select").length'));
  T('settings_about', await evalJs('document.querySelector(".about").textContent.replace(/\\s+/g," ")'));
  await shot('12-settings');

  // 16) 刷新持久化
  const snapshotBefore = await evalJs('JSON.stringify({n:Store.db.notes.length,v:Store.db.versions.length,s:Store.db.sources.length})');
  await send('Page.navigate', { url: URL_APP }); await sleep(2000);
  T('persist_after_reload', { before: JSON.parse(snapshotBefore), after: JSON.parse(await evalJs('JSON.stringify({n:Store.db.notes.length,v:Store.db.versions.length,s:Store.db.sources.length})')) });

  // 17) 版本完整率
  T('version_coverage', await evalJs(`(function(){
    var writes=0;
    Store.db.suggestions.filter(s=>s.status==='accepted'||s.status==='merged').forEach(function(s){writes++;});
    return {resolved_suggestions:writes, notes:Store.db.notes.length, versions:Store.db.versions.length,
            notes_without_version:Store.db.notes.filter(n=>Store.versionsOf(n.id).length===0).length};
  })()`));

  console.log(log.join('\n'));
  fs.writeFileSync(path.join(__dirname, 'e2e-report.json'), log.join('\n'));
  proc.kill();
  process.exit(0);
})().catch(e => { console.log('FATAL: ' + e.message + '\n' + e.stack); process.exit(1); });
