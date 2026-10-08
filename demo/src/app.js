/* app.js — 视图层：SPA 路由 + 7 个页面渲染与交互 */
(function () {
  'use strict';

  const S = Store, A = Agent, SE = Search;
  const $ = (sel, root) => (root || document).querySelector(sel);
  const h = SE.escapeHtml;
  const state = { route: 'dashboard', noteId: null, noteTab: 'body', libFilter: { cat: null, tags: [], q: '' }, trash: false };

  /* ---------------- 工具 ---------------- */
  function toast(msg, kind) {
    const w = $('#toasts');
    const el = document.createElement('div');
    el.className = 'toast ' + (kind || 'ok');
    el.textContent = msg;
    w.appendChild(el);
    setTimeout(() => { el.className += ' fading'; }, 2600);
    setTimeout(() => el.remove(), 3000);
  }

  function openModal(html) { $('#modal').innerHTML = html; $('#modal-mask').classList.add('show'); }
  function closeModal() { $('#modal-mask').classList.remove('show'); $('#modal').innerHTML = ''; }
  $('#modal-mask').addEventListener('click', (e) => { if (e.target.id === 'modal-mask') closeModal(); });

  function fmtTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  const TYPE_LABEL = { meeting: '会议', interview: '访谈', class: '课堂', scratch: '随手记', upload: '上传' };
  const CHANGE_LABEL = { create: '创建', edit: '编辑', recategorize: '改判', merge: '合并', rollback: '回滚', archive: '归档', delete: '删除' };

  function catPill(catId) {
    return '<span class="pill cat-pill" style="--c:' + S.categoryColor(catId) + '">' + h(S.categoryName(catId)) + '</span>';
  }
  function tagPill(t) { return '<span class="pill tag-pill">#' + h(t) + '</span>'; }
  function confBar(v) {
    const pct = Math.round(v * 100);
    const cls = v >= 0.7 ? 'high' : v >= 0.45 ? 'mid' : 'low';
    return '<span class="conf"><span class="conf-bar ' + cls + '" style="width:' + pct + '%"></span><em>' + pct + '%</em></span>';
  }

  /* ---------------- 路由 ---------------- */
  const PAGES = {
    dashboard: { title: '工作台', desc: '全局态势与待办入口', render: renderDashboard },
    ingest: { title: '摄入台', desc: '喂入零散录音文字与资料，Agent 自动成库', render: renderIngest },
    inbox: { title: '确认队列', desc: '人在环：接受 / 改判 / 合并 / 丢弃 Agent 建议', render: renderInbox },
    library: { title: '笔记库', desc: '已归档笔记的管理与筛选', render: renderLibrary },
    search: { title: '全文检索', desc: '倒排索引 + BM25 打分，支持 分类: 标签: 语法', render: renderSearchPage },
    taxonomy: { title: '分类与标签', desc: '体系维护与演化', render: renderTaxonomy },
    settings: { title: '设置', desc: 'Agent 行为参数与数据主权', render: renderSettings }
  };

  function go(route, noteId) {
    state.route = route;
    if (noteId) { state.noteId = noteId; state.noteTab = 'body'; }
    if (route !== 'note') state.noteId = noteId || state.noteId;
    document.querySelectorAll('.nav-item').forEach((el) => el.classList.toggle('active', el.dataset.route === route));
    render();
    window.scrollTo(0, 0);
  }
  $('#nav').addEventListener('click', (e) => { const it = e.target.closest('.nav-item'); if (it) go(it.dataset.route); });

  function render() {
    const pending = S.pendingSuggestions().length;
    const badge = $('#badge-inbox');
    badge.textContent = pending;
    badge.style.display = pending ? '' : 'none';
    $('#engine-state').textContent = '引擎：' + (S.config.llm.enabled ? 'LLM (' + S.config.llm.model + ')' : '本地算法');

    if (state.route === 'note' && state.noteId) {
      const n = S.byId('notes', state.noteId);
      if (n) { $('#page-title').textContent = '笔记详情'; $('#page-desc').textContent = n.title; }
      $('#topbar-actions').innerHTML = '<button class="btn ghost" id="btn-back-lib">← 返回笔记库</button>';
      $('#view').innerHTML = renderNoteDetail(n);
      bindNoteDetail(n);
      return;
    }
    const p = PAGES[state.route] || PAGES.dashboard;
    $('#page-title').textContent = p.title;
    $('#page-desc').textContent = p.desc;
    $('#topbar-actions').innerHTML = topActions(state.route);
    bindTopActions(state.route);
    $('#view').innerHTML = p.render();
    bind(state.route);
  }

  function topActions(route) {
    if (route === 'ingest') return '<button class="btn ghost" id="btn-load-demo">载入示例数据</button><button class="btn primary" id="btn-run-all">重跑全部素材</button>';
    if (route === 'library') return '<button class="btn ghost" id="btn-trash">回收站</button><button class="btn primary" id="btn-new-note">＋ 新建笔记</button>';
    if (route === 'settings') return '<button class="btn ghost" id="btn-export">导出 JSON</button><button class="btn primary" id="btn-save-cfg">保存设置</button>';
    if (route === 'taxonomy') return '<button class="btn primary" id="btn-add-cat">＋ 新建分类</button>';
    return '';
  }

  function bindTopActions(route) {
    const on = (id, fn) => { const el = $('#' + id); if (el) el.addEventListener('click', fn); };
    on('btn-load-demo', () => { const n = S.seed(); Agent.reprocess(); toast('已载入 ' + n + ' 份示例素材并完成归类入库'); render(); });
    on('btn-run-all', async () => {
      try {
        const n = S.config.llm.enabled ? await A.reprocessWithLLM() : A.reprocess();
        toast('已重跑 ' + n + ' 份素材的管线' + (S.config.llm.enabled ? '（待确认项已尝试 LLM 增强）' : ''));
        render();
      } catch (err) { toast('重跑失败：' + (err.message || err), 'err'); }
    });
    on('btn-export', exportJson);
    on('btn-save-cfg', saveSettings);
    on('btn-trash', () => { state.trash = !state.trash; render(); });
    on('btn-new-note', () => newNoteDialog());
    on('btn-add-cat', () => catDialog());
    on('btn-back-lib', () => go('library'));
  }

  /* ================= 工作台 ================= */
  function renderDashboard() {
    const notes = S.activeNotes();
    const pending = S.pendingSuggestions();
    const sources = S.db.sources;
    const month = new Date().toISOString().slice(0, 7);
    const monthNew = notes.filter((n) => (n.created_at || '').slice(0, 7) === month).length;
    const fa = SE.facets(notes);
    const runs = S.runs().slice(0, 5);

    const cards = [
      { k: '原始素材', v: sources.length, s: '累计摄入 ' + sources.reduce((a, x) => a + x.char_count, 0).toLocaleString() + ' 字', go: 'ingest' },
      { k: '结构化笔记', v: notes.length, s: '本月新增 ' + monthNew, go: 'library' },
      { k: '待人工确认', v: pending.length, s: pending.length ? 'Agent 有 ' + pending.length + ' 条建议等你裁决' : '队列已清空', go: 'inbox', warn: pending.length > 0 },
      { k: '分类 / 标签', v: S.db.categories.length + ' / ' + S.db.tags.length, s: S.db.versions.length + ' 条版本记录', go: 'taxonomy' }
    ];

    let out = '<div class="stat-grid">' + cards.map((c) =>
      '<div class="stat' + (c.warn ? ' warn' : '') + '" data-go="' + c.go + '"><div class="stat-k">' + c.k + '</div><div class="stat-v">' + c.v + '</div><div class="stat-s">' + h(c.s) + '</div></div>'
    ).join('') + '</div>';

    // 待办块
    out += '<div class="grid-2">';
    out += '<section class="card"><div class="card-h"><h3>待我处理</h3><button class="link" data-go="inbox">全部 →</button></div>';
    if (!pending.length) out += '<div class="empty">确认队列已清空。摄入新材料后，Agent 的低置信建议会出现在这里。</div>';
    else out += '<ul class="todo-list">' + pending.slice(0, 6).map((s) =>
      '<li><div class="tl-main"><div class="tl-t">' + h(s.extracted_title) + '</div><div class="tl-s">建议 ' + h(S.categoryName(s.proposed_category_id)) + ' ' +
      '<span class="conf-inline">' + Math.round(s.category_confidence * 100) + '%</span>' + (s.is_merge_candidate ? ' · <span class="warn-txt">疑似重复 ' + Math.round(s.similarity * 100) + '%</span>' : '') + '</div></div></li>'
    ).join('') + '</ul>';
    out += '</section>';

    out += '<section class="card"><div class="card-h"><h3>分类分布</h3><button class="link" data-go="taxonomy">治理 →</button></div>';
    if (!fa.category.length) out += '<div class="empty">还没有笔记。</div>';
    else {
      const max = fa.category[0].count;
      out += '<ul class="bar-list">' + fa.category.map((c) =>
        '<li><span class="bl-name">' + h(c.name) + '</span><span class="bl-track"><span class="bl-fill" style="width:' + Math.round(c.count / max * 100) + '%"></span></span><span class="bl-n">' + c.count + '</span></li>'
      ).join('') + '</ul>';
    }
    out += '</section></div>';

    // Agent 运行时间线
    out += '<section class="card"><div class="card-h"><h3>Agent 运行记录</h3></div>';
    if (!runs.length) out += '<div class="empty">尚未运行过管线，去摄入台试试。</div>';
    else out += '<div class="table-wrap"><table class="table"><thead><tr><th>时间</th><th>素材</th><th>切片</th><th>自动入库</th><th>待确认</th><th>疑似重复</th><th>耗时</th></tr></thead><tbody>' +
      runs.map((r) => {
        const src = S.getSource(r.source_ids[0]);
        return '<tr><td class="dim">' + fmtTime(r.started_at) + '</td><td>' + h(src ? src.title : '（已删除）') + '</td><td>' + r.stats.segments +
          '</td><td class="ok-txt">' + r.stats.autoCreated + '</td><td class="' + (r.stats.pending ? 'warn-txt' : 'dim') + '">' + r.stats.pending +
          '</td><td class="dim">' + r.stats.duplicates + '</td><td class="dim">' + r.stats.durationMs + 'ms</td></tr>';
      }).join('') + '</tbody></table></div>';
    out += '</section>';
    return out;
  }

  /* ================= 摄入台 ================= */
  function renderIngest() {
    let out = '<div class="grid-2">';
    out += '<section class="card"><div class="card-h"><h3>投入新素材</h3></div>' +
      '<div class="form">' +
      '<label class="fl">素材标题<input id="in-title" placeholder="例：Q4 产品评审会 · 转写" /></label>' +
      '<div class="row2">' +
      '<label class="fl">来源类型<select id="in-type">' +
      Object.keys(TYPE_LABEL).map((k) => '<option value="' + k + '">' + TYPE_LABEL[k] + '</option>').join('') +
      '</select></label>' +
      '<label class="fl">发生时间<input id="in-time" type="datetime-local" value="' + new Date(Date.now() - 8 * 3600e3).toISOString().slice(0, 16) + '" /></label>' +
      '</div>' +
      '<label class="fl">原始文字（支持 SRT/VTT 带时间戳格式）<textarea id="in-text" rows="10" placeholder="把零散的录音转写文字直接粘进来…"></textarea></label>' +
      '<label class="fl">或上传文件<input type="file" id="in-file" accept=".txt,.md,.srt,.vtt,.json" /></label>' +
      '<div class="row2">' +
      '<label class="fl">切片粒度<select id="in-slice"><option value="hybrid">语义 + 规则（推荐）</option><option value="rule">仅规则边界</option></select></label>' +
      '<label class="fl">提炼句数<input id="in-sum" type="number" min="1" max="6" value="' + S.config.summarySentences + '" /></label>' +
      '</div>' +
      '<div class="form-actions"><button class="btn primary" id="btn-run">运行 Agent 管线</button><button class="btn ghost" id="btn-clear">清空</button></div>' +
      '</div></section>';

    out += '<section class="card"><div class="card-h"><h3>管线执行</h3></div><div id="pipe">' +
      '<div class="empty">尚未运行。点击「运行 Agent 管线」查看 5 步执行过程与产物计数。</div></div>' +
      '<div class="pipe-steps">' + ['语义切片', '多信号归类', '结构化提炼', '相似度查重', '写入笔记库'].map((n, i) =>
        '<div class="ps" data-ps="' + (i + 1) + '"><span class="ps-i">' + (i + 1) + '</span><span class="ps-n">' + n + '</span><span class="ps-d"></span></div>').join('') + '</div></section></div>';

    out += '<section class="card"><div class="card-h"><h3>已摄入素材</h3><span class="dim" id="src-count"></span></div><div id="src-list"></div></section>';
    return out;
  }

  function renderSourceList() {
    const sources = S.db.sources;
    $('#src-count').textContent = sources.length + ' 份';
    if (!sources.length) { $('#src-list').innerHTML = '<div class="empty">还没有素材。</div>'; return; }
    $('#src-list').innerHTML = '<div class="table-wrap"><table class="table"><thead><tr><th>标题</th><th>类型</th><th>发生时间</th><th>字数</th><th>片段</th><th>关联笔记</th><th></th></tr></thead><tbody>' +
      sources.map((s) => {
        const segs = S.segmentsOf(s.id).length, nts = S.notesOfSource(s.id).length;
        return '<tr><td><a class="lnk" data-src-view="' + s.id + '">' + h(s.title) + '</a></td><td>' + TYPE_LABEL[s.source_type] +
          '</td><td class="dim">' + fmtTime(s.occurred_at) + '</td><td class="dim">' + s.char_count.toLocaleString() +
          '</td><td class="dim">' + segs + '</td><td>' + nts + '</td><td><button class="btn xs danger" data-src-del="' + s.id + '">删除</button></td></tr>';
      }).join('') + '</tbody></table></div>';
  }

  function bindIngest() {
    const textEl = $('#in-text');
    const fileEl = $('#in-file');
    if (fileEl) fileEl.addEventListener('change', (e) => {
      const f = e.target.files[0];
      if (!f) return;
      const r = new FileReader();
      r.onload = () => { textEl.value = r.result; if (!$('#in-title').value) $('#in-title').value = f.name.replace(/\.[^.]+$/, ''); toast('已读入 ' + f.name); };
      r.readAsText(f, 'utf-8');
    });
    const clear = $('#btn-clear');
    if (clear) clear.addEventListener('click', () => { textEl.value = ''; $('#in-title').value = ''; });
    const run = $('#btn-run');
    if (run) run.addEventListener('click', doRun);
  }

  async function doRun() {
    const text = $('#in-text').value.trim();
    if (!text) { toast('请先粘贴或上传文字内容', 'err'); return; }
    const title = $('#in-title').value.trim();
    const type = $('#in-type').value;
    const occurred = $('#in-time').value ? new Date($('#in-time').value).toISOString() : S.now();
    S.config.sliceMode = $('#in-slice').value;
    S.config.summarySentences = parseInt($('#in-sum').value, 10) || 3;
    S.saveConfig({ sliceMode: S.config.sliceMode, summarySentences: S.config.summarySentences });

    const res = S.addSource({ title: title, source_type: type, occurred_at: occurred, raw_text: text });
    if (res.error === 'duplicate') { toast('检测到重复内容，已拦截（与《' + res.source.title + '》一致）', 'err'); return; }
    const src = res.source;

    const pipe = $('#pipe');
    pipe.innerHTML = '<div class="empty">运行中…</div>';
    const stepsDone = [];
    const t0 = Date.now();
    const timer = setInterval(() => {
      const el = pipe.querySelector('.empty'); if (el) el.textContent = '运行中… ' + (Date.now() - t0) + 'ms';
    }, 40);

    setTimeout(async () => {
      clearInterval(timer);
      try {
        const execute = S.config.llm.enabled ? A.runWithLLM : A.run;
        const rec = await execute(src.id, (i, name, detail) => {
          stepsDone.push({ i, name, detail });
          const ps = document.querySelector('[data-ps="' + i + '"]');
          if (ps) { ps.classList.add('done'); ps.querySelector('.ps-d').textContent = detail; }
        });
        renderPipeReport(rec, src);
        renderSourceList();
        const llm = rec.stats.llm;
        toast('管线完成：自动入库 ' + rec.stats.autoCreated + ' 条，待确认 ' + rec.stats.pending + ' 条' + (llm ? '，LLM 增强 ' + llm.enriched + ' 条' : ''));
      } catch (err) {
        // 已创建的素材保留，用户可关闭 LLM 后重跑；不删除原始输入以免数据丢失。
        pipe.innerHTML = '<div class="empty">运行失败：' + h(err.message || String(err)) + '</div>';
        toast('管线失败，可检查 LLM 设置后重跑', 'err');
      }
    }, 260);
  }

  function renderPipeReport(rec, src) {
    const st = rec.stats;
    $('#pipe').innerHTML =
      '<div class="pipe-summary">' +
      '<div class="ps-box"><b>' + st.segments + '</b><span>语义片段</span></div>' +
      '<div class="ps-box"><b class="ok-txt">' + st.autoCreated + '</b><span>自动入库</span></div>' +
      '<div class="ps-box"><b class="warn-txt">' + st.pending + '</b><span>待确认</span></div>' +
      '<div class="ps-box"><b>' + st.duplicates + '</b><span>疑似重复</span></div>' +
      '<div class="ps-box"><b>' + st.durationMs + 'ms</b><span>总耗时</span></div>' +
      '</div>' +
      '<div class="dim small">来源：《' + h(src.title) + '》 · 触发方式：' + rec.trigger + '</div>' +
      (st.pending ? '<button class="btn primary sm" id="btn-goto-inbox" style="margin-top:12px">前往确认队列裁决 ' + st.pending + ' 条 →</button>' : '');
    const g = $('#btn-goto-inbox');
    if (g) g.addEventListener('click', () => go('inbox'));
  }

  /* ================= 确认队列 ================= */
  function renderInbox() {
    const list = S.pendingSuggestions();
    if (!list.length) {
      return '<div class="empty big">确认队列已清空。<br/><span class="dim">低置信度分类、疑似重复的 Agent 建议会出现在这里，由你裁决。</span></div>';
    }
    const dupCount = list.filter((s) => s.duplicate_note_id).length;
    let out = '<div class="inbox-bar"><span>共 <b>' + list.length + '</b> 条建议</span><span class="dim">其中 ' + dupCount + ' 条疑似与既有笔记重复</span>' +
      '<span class="spacer"></span><button class="btn ghost sm" id="btn-accept-all">全部接受（高置信）</button></div>';
    out += '<div class="sug-list">' + list.map((s) => {
      const src = S.getSource(s.source_id);
      const alts = (s.alternatives || []).slice(1);
      return '<div class="card sug" data-sug="' + s.id + '">' +
        '<div class="sug-top"><div class="sug-title">' + h(s.extracted_title) + '</div>' + confBar(s.category_confidence) + '</div>' +
        '<div class="sug-meta">来源《' + h(src ? src.title : '已删除') + '》 · 片段 #' + s.segment_ordinal + (s.alternatives ? '' : '') + ' · 建议分类 ' + h(S.categoryName(s.proposed_category_id)) + '</div>' +
        (s.duplicate_note_id ? '<div class="dup-box"><b>疑似重复：</b>《' + h(s.duplicate_note_title) + '》 相似度 ' + Math.round(s.similarity * 100) + '%' + (s.is_merge_candidate ? '（达到合并阈值）' : '') + '</div>' : '') +
        (alts.length ? '<div class="alts">次选：' + alts.map((a) => h(S.categoryName(a.id)) + ' ' + Math.round(a.score * 100) + '%').join(' · ') + '</div>' : '') +
        '<div class="sug-sum">' + h(s.extracted_summary) + '</div>' +
        '<div class="sug-tags">' + (s.extracted_tags || []).map(tagPill).join('') + '</div>' +
        (s.extracted_slots ? slotBlock(s.extracted_slots) : '') +
        '<div class="sug-quote">“' + h(s.segment_text.slice(0, 160)) + (s.segment_text.length > 160 ? '…' : '') + '”</div>' +
        '<div class="sug-actions">' +
        '<button class="btn primary sm" data-act="accept" data-sug="' + s.id + '">接受</button>' +
        '<select class="sel sm" data-recat="' + s.id + '"><option value="">改判为…</option>' +
        S.categories().map((c) => '<option value="' + c.id + '">' + h(c.name) + '</option>').join('') + '</select>' +
        (s.duplicate_note_id ? '<button class="btn warn sm" data-act="merge" data-sug="' + s.id + '">合并进《' + h((s.duplicate_note_title || '').slice(0, 12)) + '…》</button>' : '') +
        '<button class="btn ghost sm" data-act="reject" data-sug="' + s.id + '">丢弃</button>' +
        '<button class="btn ghost sm" data-act="goto-src" data-sug="' + s.id + '">查看原文片段</button>' +
        '</div></div>';
    }).join('') + '</div>';
    return out;
  }

  function slotBlock(slots) {
    const rows = [];
    if (slots.conclusion && slots.conclusion.length) rows.push(['结论', slots.conclusion]);
    if (slots.todo && slots.todo.length) rows.push(['待办', slots.todo]);
    if (slots.risk && slots.risk.length) rows.push(['风险', slots.risk]);
    if (slots.metric && slots.metric.length) rows.push(['数据', slots.metric]);
    if (!rows.length) return '';
    return '<div class="slots">' + rows.map(([k, arr]) =>
      '<div class="slot"><span class="slot-k">' + k + '</span><ul>' + arr.slice(0, 3).map((x) => '<li>' + h(x) + '</li>').join('') + '</ul></div>').join('') + '</div>';
  }

  function bindInbox() {
    document.querySelectorAll('[data-act]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.sug, act = btn.dataset.act;
        const s = S.byId('suggestions', id);
        if (!s) return;
        if (act === 'accept') acceptSuggestion(s, s.proposed_category_id);
        else if (act === 'reject') { S.resolveSuggestion(id, 'rejected'); toast('已丢弃该建议'); render(); }
        else if (act === 'merge') { mergeSuggestion(s); }
        else if (act === 'goto-src') { viewSource(s.source_id, s.segment_id); }
      });
    });
    document.querySelectorAll('[data-recat]').forEach((sel) => {
      sel.addEventListener('change', () => {
        if (!sel.value) return;
        const s = S.byId('suggestions', sel.dataset.recat);
        acceptSuggestion(s, sel.value);
      });
    });
    const aa = $('#btn-accept-all');
    if (aa) aa.addEventListener('click', () => {
      const list = S.pendingSuggestions().filter((s) => s.category_confidence >= 0.7 && !s.duplicate_note_id);
      let done = 0;
      list.forEach((s) => { if (acceptSuggestion(s, s.proposed_category_id, true)) done++; });
      toast('已批量接受 ' + done + ' 条高置信建议');
      render();
    });
  }

  function acceptSuggestion(s, categoryId, silent) {
    // 幂等保护：同一条建议只能被裁决一次。
    // 缺少这一步时，连续点击（渲染未完成 / 用户连点）会为同一条建议重复建笔记。
    if (!s || s.status !== 'pending') return null;
    const near = S.segmentsOf(s.source_id).filter((y) => Math.abs(y.ordinal - s.segment_ordinal) <= 1);
    const body = near.map((a) => a.text).join('\n');
    const note = S.createNote({
      title: s.extracted_title, summary: s.extracted_summary, body: body,
      category_id: categoryId, source_ids: [s.source_id], segment_ids: [s.segment_id],
      confidence: s.category_confidence, tags: s.extracted_tags
    }, s.category_confidence >= S.config.minConfidence ? '人工确认后入库' : '人工改判入库（' + S.categoryName(categoryId) + '）');
    s.created_note_id = note.id;
    S.resolveSuggestion(s.id, 'accepted');
    if (!silent) toast('已入库：' + note.title);
    return note;
  }

  function mergeSuggestion(s) {
    if (!s || s.status !== 'pending' || !s.duplicate_note_id) return;
    const keep = S.byId('notes', s.duplicate_note_id);
    const near = S.segmentsOf(s.source_id).filter((y) => Math.abs(y.ordinal - s.segment_ordinal) <= 1);
    const tmp = { title: s.extracted_title, summary: s.extracted_summary };
    const fresh = S.createNote({
      title: s.extracted_title + '（补充）', summary: s.extracted_summary, body: near.map((a) => a.text).join('\n'),
      category_id: keep.category_id, source_ids: [s.source_id], segment_ids: [s.segment_id],
      confidence: s.category_confidence, tags: s.extracted_tags
    }, '为合并创建的临时笔记');
    S.mergeNotes(keep.id, fresh.id, '合并 Agent 建议：' + s.extracted_title);
    S.db.notes = S.db.notes.filter((n) => n.id !== fresh.id);
    S.db.versions = S.db.versions.filter((v) => v.note_id !== fresh.id);
    S.persist();
    keep.is_duplicate_suspect = false;
    s.created_note_id = keep.id;
    S.resolveSuggestion(s.id, 'merged');
    toast('已合并进《' + keep.title + '》，旧笔记标记为 superseded');
  }

  function viewSource(sourceId, focusSegId) {
    const src = S.getSource(sourceId);
    if (!src) { toast('素材已删除', 'err'); return; }
    const segs = S.segmentsOf(sourceId);
    const notes = S.notesOfSource(sourceId);
    openModal('<div class="modal-h"><h3>' + h(src.title) + '</h3><button class="btn ghost sm" onclick="closeModal()">关闭</button></div>' +
      '<div class="dim small">类型 ' + TYPE_LABEL[src.source_type] + ' · ' + fmtTime(src.occurred_at) + ' · ' + src.char_count + ' 字 · ' + segs.length + ' 片段 · ' + notes.length + ' 条关联笔记</div>' +
      '<div class="seg-list">' + segs.map((g) =>
        '<div class="seg' + (g.id === focusSegId ? ' focus' : '') + '"><div class="seg-h"><span class="seg-o">#' + g.ordinal + '</span>' +
        (g.speaker ? '<span class="pill tag-pill">' + h(g.speaker) + '</span>' : '') + (g.timestamp ? '<span class="dim small">' + h(g.timestamp) + '</span>' : '') +
        '<span class="dim small">连贯度 ' + (g.coherence != null ? g.coherence.toFixed(2) : '—') + '</span></div><div class="seg-t">' + h(g.text) + '</div></div>').join('') +
      '</div>');
  }

  /* ================= 笔记库 ================= */
  function renderLibrary() {
    if (state.trash) {
      const tr = S.trashedNotes();
      let out = '<div class="inbox-bar"><span>回收站 · <b>' + tr.length + '</b> 条</span><span class="spacer"></span><button class="btn ghost sm" id="btn-exit-trash">← 返回笔记库</button></div>';
      out += tr.length ? '<div class="table-wrap"><table class="table"><thead><tr><th>标题</th><th>分类</th><th>删除时间</th><th>版本</th><th></th></tr></thead><tbody>' +
        tr.map((n) => '<tr><td>' + h(n.title) + '</td><td>' + h(S.categoryName(n.category_id)) + '</td><td class="dim">' + fmtTime(n.deleted_at) +
          '</td><td class="dim">' + n.version_count + '</td><td><button class="btn xs" data-restore="' + n.id + '">恢复</button></td></tr>').join('') +
        '</tbody></table></div>' : '<div class="empty">回收站是空的。</div>';
      return out;
    }
    const all = S.activeNotes().concat(Store.db.notes.filter((n) => n.status === 'superseded' && !n.deleted_at));
    const fa = SE.facets(Store.activeNotes());
    const q = state.libFilter.q;
    let list = all;
    if (state.libFilter.cat) list = list.filter((n) => n.category_id === state.libFilter.cat);
    if (state.libFilter.tags.length) list = list.filter((n) => { const t = S.tagsOf(n.id); return state.libFilter.tags.every((x) => t.indexOf(x) !== -1); });
    if (q.trim()) {
      const ids = {};
      SE.search(q, list).forEach((r) => { ids[r.note.id] = r; });
      list = list.filter((n) => ids[n.id]).sort((a, b) => ids[b.note.id].score - ids[a.note.id].score);
    }
    list = list.slice().sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));

    let out = '<div class="lib-layout">';
    out += '<aside class="lib-side">' +
      '<div class="side-h">分类</div>' +
      '<div class="side-item' + (state.libFilter.cat === null ? ' on' : '') + '" data-fcat="">全部 <em>' + Store.activeNotes().length + '</em></div>' +
      S.categories().map((c) => {
        const hit = fa.category.find((x) => x.name === c.name);
        return '<div class="side-item' + (state.libFilter.cat === c.id ? ' on' : '') + '" data-fcat="' + c.id + '"><span class="dot" style="background:' + c.color + '"></span>' + h(c.name) +
          ' <em>' + (hit ? hit.count : 0) + '</em></div>';
      }).join('') +
      '<div class="side-h" style="margin-top:16px">标签</div>' +
      (fa.tag.length ? fa.tag.slice(0, 18).map((t) => '<div class="side-item tag' + (state.libFilter.tags.indexOf(t.name) !== -1 ? ' on' : '') + '" data-ftag="' + h(t.name) + '">#' + h(t.name) + ' <em>' + t.count + '</em></div>').join('') : '<div class="dim small">暂无标签</div>') +
      '</aside>';

    out += '<div class="lib-main">' +
      '<div class="lib-bar"><input id="lib-q" placeholder="在笔记库内检索…" value="' + h(state.libFilter.q) + '" />' +
      '<span class="dim small">命中 ' + list.length + ' 条</span>' +
      (state.libFilter.tags.length ? '<span class="filter-chips">' + state.libFilter.tags.map((t) => '<span class="chip">' + h(t) + '<b data-rmtag="' + h(t) + '">×</b></span>').join('') + '</span>' : '') +
      '</div>';
    out += list.length ? '<div class="table-wrap"><table class="table lib-table"><thead><tr><th>标题</th><th>分类</th><th>标签</th><th>来源</th><th>版本</th><th>更新时间</th></tr></thead><tbody>' +
      list.map((n) => {
        const sup = n.status === 'superseded';
        return '<tr class="' + (sup ? 'superseded' : '') + '" data-note="' + n.id + '">' +
          '<td><a class="lnk">' + h(n.title) + '</a>' + (sup ? ' <span class="pill warn-pill">已合并</span>' : '') + (n.is_duplicate_suspect ? ' <span class="pill warn-pill">疑似重复</span>' : '') + '</td>' +
          '<td>' + catPill(n.category_id) + '</td>' +
          '<td>' + (S.tagsOf(n.id) || []).slice(0, 3).map(tagPill).join(' ') + '</td>' +
          '<td class="dim">' + n.source_ids.length + '</td>' +
          '<td class="dim">' + n.version_count + '</td>' +
          '<td class="dim">' + fmtTime(n.updated_at) + '</td></tr>';
      }).join('') + '</tbody></table></div>'
      : '<div class="empty">没有匹配的笔记。换个筛选条件，或去摄入台添加素材。</div>';
    out += '</div></div>';
    return out;
  }

  function bindLibrary() {
    const q = $('#lib-q');
    if (q) {
      let t = null;
      q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { state.libFilter.q = q.value; render(); const nq = $('#lib-q'); if (nq) { nq.focus(); nq.setSelectionRange(nq.value.length, nq.value.length); } }, 260); });
    }
    document.querySelectorAll('[data-fcat]').forEach((el) => el.addEventListener('click', () => { state.libFilter.cat = el.dataset.fcat || null; render(); }));
    document.querySelectorAll('[data-ftag]').forEach((el) => el.addEventListener('click', () => {
      const t = el.dataset.ftag; const i = state.libFilter.tags.indexOf(t);
      if (i === -1) state.libFilter.tags.push(t); else state.libFilter.tags.splice(i, 1);
      render();
    }));
    document.querySelectorAll('[data-rmtag]').forEach((el) => el.addEventListener('click', (e) => { e.stopPropagation(); state.libFilter.tags = state.libFilter.tags.filter((x) => x !== el.dataset.rmtag); render(); }));
    document.querySelectorAll('[data-note]').forEach((tr) => tr.addEventListener('click', () => go('note', tr.dataset.note)));
    document.querySelectorAll('[data-src-del]').forEach((b) => b.addEventListener('click', () => { if (confirm('删除该素材及其片段与待确认建议？')) { S.removeSource(b.dataset.srcDel); toast('已删除'); renderSourceList(); render(); } }));
    document.querySelectorAll('[data-src-view]').forEach((a) => a.addEventListener('click', () => viewSource(a.dataset.srcView)));
    document.querySelectorAll('[data-restore]').forEach((b) => b.addEventListener('click', () => { S.restore(b.dataset.restore); toast('已恢复'); render(); }));
    const ext = $('#btn-exit-trash');
    if (ext) ext.addEventListener('click', () => { state.trash = false; render(); });
  }

  /* ================= 笔记详情 ================= */
  function renderNoteDetail(n) {
    if (!n) return '<div class="empty">笔记不存在或已删除。</div>';
    const tabs = [['body', '正文'], ['trace', '溯源'], ['version', '版本 (' + n.version_count + ')']];
    let out = '<div class="note-head"><div class="nh-main"><h2>' + h(n.title) + '</h2>' +
      '<div class="nh-meta">' + catPill(n.category_id) + (S.tagsOf(n.id) || []).map(tagPill).join(' ') +
      '<span class="dim small">置信度 ' + Math.round(n.confidence * 100) + '% · 创建 ' + fmtTime(n.created_at) + ' · 更新 ' + fmtTime(n.updated_at) + '</span></div></div>' +
      '<div class="nh-actions"><button class="btn sm" id="btn-edit">编辑</button><button class="btn ghost sm" id="btn-reclass">改分类</button><button class="btn ghost sm" id="btn-del">移入回收站</button></div></div>';

    out += '<div class="tabs">' + tabs.map(([k, l]) => '<div class="tab' + (state.noteTab === k ? ' on' : '') + '" data-tab="' + k + '">' + l + '</div>').join('') + '</div>';

    if (state.noteTab === 'body') {
      out += '<section class="card"><div class="sum-box"><div class="sum-k">Agent 摘要</div><div class="sum-v">' + h(n.summary || '（无）') + '</div></div>' +
        '<div class="note-body">' + renderBody(n.body) + '</div></section>';
    } else if (state.noteTab === 'trace') {
      out += '<section class="card"><div class="card-h"><h3>溯源链路</h3></div>';
      n.source_ids.forEach((sid) => {
        const src = S.getSource(sid);
        if (!src) return;
        const segIds = (n.segment_ids || []).filter((x) => { const g = S.byId('segments', x); return g && g.source_id === sid; });
        out += '<div class="src-block"><div class="src-h"><b>' + h(src.title) + '</b><span class="pill tag-pill">' + TYPE_LABEL[src.source_type] + '</span><span class="dim small">' + fmtTime(src.occurred_at) + '</span>' +
          '<button class="link" data-view-src="' + sid + '">查看完整原文 →</button></div>';
        segIds.forEach((gid) => {
          const g = S.byId('segments', gid);
          if (!g) return;
          out += '<div class="seg compact"><div class="seg-h"><span class="seg-o">片段 #' + g.ordinal + '</span>' + (g.speaker ? '<span class="pill tag-pill">' + h(g.speaker) + '</span>' : '') + '</div><div class="seg-t">' + h(g.text) + '</div></div>';
        });
        out += '</div>';
      });
      if (!n.source_ids.length) out += '<div class="empty">这条笔记是手动创建的，没有来源素材。</div>';
      out += '</section>';
    } else {
      const vers = S.versionsOf(n.id);
      out += '<section class="card"><div class="card-h"><h3>版本时间线</h3><span class="dim small">历史不可销毁，回滚本身也会记一版</span></div>';
      out += '<div class="ver-list">' + vers.slice().reverse().map((v) => {
        const d = (v.diff || []);
        const dTxt = d.length ? d.map((x) => fieldName(x.field) + ' +' + x.added + '/-' + x.removed).join(' · ') : '初始快照';
        return '<div class="ver" data-ver="' + v.version_no + '"><div class="ver-no">v' + v.version_no + '</div><div class="ver-b"><div class="ver-t">' +
          '<span class="chg chg-' + v.change_type + '">' + (CHANGE_LABEL[v.change_type] || v.change_type) + '</span> ' + h(v.change_note || '') + '</div>' +
          '<div class="ver-d dim small">' + fmtTime(v.created_at) + ' · ' + h(dTxt) + '</div></div>' +
          '<div class="ver-a">' + (v.version_no < vers.length ? '<button class="btn xs" data-diff="' + v.version_no + '">对比上一版</button><button class="btn xs ghost" data-rb="' + v.version_no + '">回滚</button>' : '') + '</div></div>';
      }).join('') + '</div></section>';
      out += '<section class="card" id="diff-card" style="display:none"><div class="card-h"><h3>版本对比</h3><button class="link" id="btn-close-diff">收起</button></div><div id="diff-body"></div></section>';
    }
    return out;
  }

  function fieldName(f) { return { title: '标题', body: '正文', summary: '摘要', category_id: '分类', tags: '标签' }[f] || f; }

  function renderBody(text) {
    return String(text || '').split(/\n{2,}/).map((p) => {
      const t = p.trim();
      if (!t) return '';
      if (/^#{1,4}\s/.test(t)) return '<h3>' + h(t.replace(/^#{1,4}\s*/, '')) + '</h3>';
      if (/^[-*]\s/.test(t)) return '<ul>' + t.split('\n').map((l) => '<li>' + h(l.replace(/^[-*]\s*/, '')) + '</li>').join('') + '</ul>';
      return '<p>' + h(t) + '</p>';
    }).join('');
  }

  function bindNoteDetail(n) {
    document.querySelectorAll('[data-tab]').forEach((t) => t.addEventListener('click', () => { state.noteTab = t.dataset.tab; render(); }));
    const ed = $('#btn-edit');
    if (ed) ed.addEventListener('click', () => editDialog(n));
    const rc = $('#btn-reclass');
    if (rc) rc.addEventListener('click', () => reclassDialog(n));
    const del = $('#btn-del');
    if (del) del.addEventListener('click', () => { if (confirm('移入回收站？可在回收站恢复。')) { S.softDelete(n.id); toast('已移入回收站'); go('library'); } });
    document.querySelectorAll('[data-view-src]').forEach((a) => a.addEventListener('click', () => viewSource(a.dataset.viewSrc)));
    document.querySelectorAll('[data-diff]').forEach((b) => b.addEventListener('click', () => showDiff(n, parseInt(b.dataset.diff, 10), parseInt(b.dataset.diff, 10) + 1)));
    document.querySelectorAll('[data-rb]').forEach((b) => b.addEventListener('click', () => {
      const v = parseInt(b.dataset.rb, 10);
      if (!confirm('回滚到 v' + v + '？当前内容会保留为新版本。')) return;
      S.rollback(n.id, v); toast('已回滚到 v' + v); render();
    }));
    const cd = $('#btn-close-diff');
    if (cd) cd.addEventListener('click', () => { $('#diff-card').style.display = 'none'; });
  }

  function showDiff(n, vA, vB) {
    const vers = S.versionsOf(n.id);
    const a = vers.find((x) => x.version_no === vA), b = vers.find((x) => x.version_no === vB);
    if (!a || !b) return;
    const rows = ['title', 'summary', 'category_id', 'tags', 'body'].map((f) => ({ f, d: S.diffField(a, b, f) })).filter((r) => r.d);
    $('#diff-card').style.display = '';
    $('#diff-body').innerHTML = rows.length ? rows.map((r) =>
      '<div class="diff-row"><div class="diff-f">' + fieldName(r.f) + '</div><div class="diff-n"><span class="add">+' + r.d.added + '</span> <span class="rem">-' + r.d.removed + '</span></div>' +
      '<div class="diff-p">' + (r.d.added ? '<ins>' + h(r.d.preview) + '</ins>' : '<del>' + h(r.d.preview) + '</del>') + '</div></div>').join('')
      : '<div class="empty">两个版本内容完全一致。</div>';
  }

  function editDialog(n) {
    const vers = S.versionsOf(n.id);
    const last = vers.slice(-1)[0];
    openModal('<div class="modal-h"><h3>编辑笔记</h3><button class="btn ghost sm" onclick="closeModal()">关闭</button></div>' +
      '<label class="fl">标题<input id="ed-title" value="' + h(n.title) + '" /></label>' +
      '<label class="fl">正文<textarea id="ed-body" rows="14">' + h(n.body) + '</textarea></label>' +
      '<label class="fl">标签（逗号分隔）<input id="ed-tags" value="' + h((S.tagsOf(n.id) || []).join(',')) + '" /></label>' +
      '<label class="fl">变更说明<input id="ed-note" placeholder="例：补充验收指标口径" /></label>' +
      '<div class="form-actions"><button class="btn ghost" id="btn-ed-preview">预览变更</button><button class="btn primary" id="btn-ed-save">保存并记版本</button></div>' +
      '<div id="ed-diff" style="margin-top:12px"></div>');
    const preview = () => {
      const nt = { title: $('#ed-title').value, body: $('#ed-body').value };
      const rows = ['title', 'body'].map((f) => ({ f, d: S.diffField(last, nt, f) })).filter((r) => r.d);
      $('#ed-diff').innerHTML = rows.length ? '<div class="dim small">本次将产生变更：</div>' + rows.map((r) =>
        '<div class="diff-row"><div class="diff-f">' + fieldName(r.f) + '</div><div class="diff-n"><span class="add">+' + r.d.added + '</span> <span class="rem">-' + r.d.removed + '</span></div><div class="diff-p">' + h(r.d.preview) + '</div></div>').join('')
        : '<div class="dim small">与当前版本相比无变化。</div>';
    };
    $('#btn-ed-preview').addEventListener('click', preview);
    $('#btn-ed-save').addEventListener('click', () => {
      const tags = $('#ed-tags').value.split(/[,，]/).map((x) => x.trim()).filter(Boolean);
      S.updateNote(n.id, { title: $('#ed-title').value.trim(), body: $('#ed-body').value, tags: tags }, $('#ed-note').value.trim() || '手动编辑', 'edit');
      closeModal(); toast('已保存，版本 v' + n.version_count); render();
    });
  }

  function reclassDialog(n) {
    openModal('<div class="modal-h"><h3>改分类</h3><button class="btn ghost sm" onclick="closeModal()">关闭</button></div>' +
      '<label class="fl">目标分类<select id="rc-sel">' + S.categories().map((c) => '<option value="' + c.id + '"' + (c.id === n.category_id ? ' selected' : '') + '>' + h(c.name) + '</option>').join('') + '</select></label>' +
      '<div class="form-actions"><button class="btn primary" id="btn-rc-ok">确认改判</button></div>');
    $('#btn-rc-ok').addEventListener('click', () => {
      const cid = $('#rc-sel').value;
      if (cid === n.category_id) { closeModal(); return; }
      const from = S.categoryName(n.category_id);
      S.updateNote(n.id, { category_id: cid }, '分类由「' + from + '」改为「' + S.categoryName(cid) + '」', 'recategorize');
      closeModal(); toast('已改判，版本 v' + n.version_count); render();
    });
  }

  function newNoteDialog() {
    openModal('<div class="modal-h"><h3>新建笔记</h3><button class="btn ghost sm" onclick="closeModal()">关闭</button></div>' +
      '<label class="fl">标题<input id="nn-title" placeholder="笔记标题" /></label>' +
      '<label class="fl">分类<select id="nn-cat">' + S.categories().map((c) => '<option value="' + c.id + '">' + h(c.name) + '</option>').join('') + '</select></label>' +
      '<label class="fl">标签（逗号分隔）<input id="nn-tags" /></label>' +
      '<label class="fl">正文<textarea id="nn-body" rows="10"></textarea></label>' +
      '<div class="form-actions"><button class="btn primary" id="btn-nn-ok">创建</button></div>');
    $('#btn-nn-ok').addEventListener('click', () => {
      const title = $('#nn-title').value.trim();
      if (!title) { toast('标题不能为空', 'err'); return; }
      const tags = $('#nn-tags').value.split(/[,，]/).map((x) => x.trim()).filter(Boolean);
      const n = S.createNote({ title, body: $('#nn-body').value, category_id: $('#nn-cat').value, tags, summary: '', source_ids: [] }, '手动创建');
      closeModal(); toast('已创建'); go('note', n.id);
    });
  }

  /* ================= 检索页 ================= */
  function renderSearchPage() {
    return '<section class="card"><div class="search-hero"><input id="sq" placeholder="搜索笔记…  支持 分类:产品需求  标签:索引  召回" />' +
      '<button class="btn primary" id="btn-do-search">检索</button></div>' +
      '<div class="dim small">语法：<code>分类:名称</code> / <code>标签:名称</code> / 裸词（走正文，标题权重 ×3、标签 ×2）</div>' +
      '<div id="search-out"></div></section>';
  }

  function bindSearch() {
    const doSearch = () => {
      const q = $('#sq').value;
      const t0 = performance.now();
      const res = SE.search(q, Store.activeNotes());
      const ms = (performance.now() - t0).toFixed(1);
      const fa = SE.facets(res.map((r) => r.note));
      const terms = SE.parseQuery(q).terms;
      const indexSize = (() => { const idx = SE.buildIndex(Store.activeNotes()); return Object.keys(idx.df).length; })();
      let out = '<div class="inbox-bar"><span>命中 <b>' + res.length + '</b> 条 · 耗时 ' + ms + 'ms · 索引项 ' + indexSize + '</span></div>';
      if (fa.category.length) out += '<div class="facets">分类：' + fa.category.map((f) => '<span class="chip dim">' + h(f.name) + ' ' + f.count + '</span>').join('') +
        (fa.tag.length ? ' <span class="dim">|</span> 标签：' + fa.tag.slice(0, 10).map((f) => '<span class="chip dim">#' + h(f.name) + ' ' + f.count + '</span>').join('') : '') + '</div>';
      out += res.length ? res.map((r) =>
        '<div class="sr-item" data-note="' + r.note.id + '"><div class="sr-h"><a class="lnk">' + h(r.note.title) + '</a>' + catPill(r.note.category_id) +
        '<span class="dim small">score ' + r.score.toFixed(2) + '</span></div><div class="sr-s">' + r.snippet + '</div></div>').join('')
        : '<div class="empty">没有命中。试试更短的词，或去掉筛选条件。</div>';
      $('#search-out').innerHTML = out;
      $('#search-out').querySelectorAll('[data-note]').forEach((el) => el.addEventListener('click', () => go('note', el.dataset.note)));
    };
    $('#btn-do-search').addEventListener('click', doSearch);
    $('#sq').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
    doSearch();
  }

  /* ================= 分类与标签 ================= */
  function renderTaxonomy() {
    const notes = S.activeNotes();
    let out = '<div class="grid-2">';
    out += '<section class="card"><div class="card-h"><h3>分类体系</h3><span class="dim small">删除受保护：分类下有笔记时不可删</span></div>' +
      '<div class="cat-list">' + S.categories().map((c) => {
        const cnt = notes.filter((n) => n.category_id === c.id).length;
        return '<div class="cat-row"><span class="dot" style="background:' + c.color + '"></span><b>' + h(c.name) + '</b>' +
          '<span class="dim small">' + cnt + ' 条</span>' +
          '<span class="kw">' + (c.keywords || []).map((k) => '<i>' + h(k) + '</i>').join('') + '</span>' +
          '<button class="btn xs" data-cat-edit="' + c.id + '">编辑</button>' +
          '<button class="btn xs danger" data-cat-del="' + c.id + '">删除</button></div>';
      }).join('') + '</div>' +
      '<button class="btn ghost sm" id="btn-add-cat2" style="margin-top:12px">＋ 新建分类</button></section>';

    const tags = S.allTags();
    out += '<section class="card"><div class="card-h"><h3>标签库</h3><span class="dim small">' + tags.length + ' 个</span></div>' +
      (tags.length ? '<div class="table-wrap"><table class="table"><thead><tr><th>标签</th><th>使用</th><th>操作</th></tr></thead><tbody>' +
        tags.map((t) => '<tr><td>#' + h(t.name) + '</td><td class="dim">' + t.usage_count + '</td><td>' +
          '<button class="btn xs" data-tag-rename="' + t.id + '">重命名</button> ' +
          '<select class="sel xs" data-tag-merge="' + t.id + '"><option value="">合并到…</option>' + tags.filter((x) => x.id !== t.id).map((x) => '<option value="' + x.id + '">#' + h(x.name) + '</option>').join('') + '</select> ' +
          '<button class="btn xs danger" data-tag-del="' + t.id + '">删除</button></td></tr>').join('') + '</tbody></table></div>'
        : '<div class="empty">还没有标签。</div>') + '</section></div>';
    return out;
  }

  function bindTaxonomy() {
    const a2 = $('#btn-add-cat2'); if (a2) a2.addEventListener('click', () => catDialog());
    document.querySelectorAll('[data-cat-edit]').forEach((b) => b.addEventListener('click', () => catDialog(S.byId('categories', b.dataset.catEdit))));
    document.querySelectorAll('[data-cat-del]').forEach((b) => b.addEventListener('click', () => {
      const r = S.removeCategory(b.dataset.catDel);
      if (r.error === 'not_empty') toast('该分类下仍有笔记，请先迁移或改判', 'err');
      else { toast('分类已删除'); render(); }
    }));
    document.querySelectorAll('[data-tag-rename]').forEach((b) => b.addEventListener('click', () => {
      const t = S.byId('tags', b.dataset.tagRename);
      const nn = prompt('新的标签名：', t.name);
      if (nn == null) return;
      if (S.renameTag(t.id, nn.trim())) { toast('已重命名'); render(); } else toast('重名或无效', 'err');
    }));
    document.querySelectorAll('[data-tag-merge]').forEach((s) => s.addEventListener('change', () => {
      if (!s.value) return;
      if (S.mergeTag(s.dataset.tagMerge, s.value)) { toast('已合并标签'); render(); }
    }));
    document.querySelectorAll('[data-tag-del]').forEach((b) => b.addEventListener('click', () => {
      if (!confirm('删除该标签？笔记本身不受影响。')) return;
      S.removeTag(b.dataset.tagDel); toast('已删除标签'); render();
    }));
  }

  function catDialog(cat) {
    const c = cat || { name: '', color: '#4f6ef7', keywords: [] };
    openModal('<div class="modal-h"><h3>' + (cat ? '编辑分类' : '新建分类') + '</h3><button class="btn ghost sm" onclick="closeModal()">关闭</button></div>' +
      '<label class="fl">名称<input id="ct-name" value="' + h(c.name) + '" /></label>' +
      '<label class="fl">展示色<input id="ct-color" type="color" value="' + c.color + '" /></label>' +
      '<label class="fl">归类关键词（逗号分隔，归类信号权重 0.4）<input id="ct-kw" value="' + h((c.keywords || []).join(',')) + '" /></label>' +
      '<div class="form-actions"><button class="btn primary" id="btn-ct-ok">保存</button></div>' +
      '<div class="dim small" style="margin-top:10px">保存后可用工作台「重跑全部素材」让低置信笔记重新归类。</div>');
    $('#btn-ct-ok').addEventListener('click', () => {
      const name = $('#ct-name').value.trim();
      if (!name) { toast('名称不能为空', 'err'); return; }
      const kw = $('#ct-kw').value.split(/[,，]/).map((x) => x.trim()).filter(Boolean);
      if (cat) S.updateCategory(cat.id, { name, color: $('#ct-color').value, keywords: kw });
      else S.addCategory({ name, color: $('#ct-color').value, keywords: kw });
      closeModal(); toast('已保存分类'); render();
    });
  }

  /* ================= 设置 ================= */
  function renderSettings() {
    const c = S.config;
    return '<div class="grid-2">' +
      '<section class="card"><div class="card-h"><h3>Agent 行为参数</h3></div><div class="form">' +
      '<label class="fl">归类置信度阈值（低于此值强制进确认队列）<input id="cfg-conf" type="number" step="0.01" min="0" max="1" value="' + c.minConfidence + '" /></label>' +
      '<label class="fl">合并阈值（相似度 ≥ 此值生成合并建议）<input id="cfg-merge" type="number" step="0.01" min="0" max="1" value="' + c.mergeThreshold + '" /></label>' +
      '<label class="fl">疑似重复提示阈值<input id="cfg-suspect" type="number" step="0.01" min="0" max="1" value="' + c.suspectThreshold + '" /></label>' +
      '<div class="row2"><label class="fl">切片方式<select id="cfg-slice"><option value="hybrid"' + (c.sliceMode === 'hybrid' ? ' selected' : '') + '>语义 + 规则</option><option value="rule"' + (c.sliceMode === 'rule' ? ' selected' : '') + '>仅规则</option></select></label>' +
      '<label class="fl">语义连贯阈值<input id="cfg-coh" type="number" step="0.01" value="' + c.coherenceThreshold + '" /></label></div>' +
      '<div class="row2"><label class="fl">摘要句数<input id="cfg-sum" type="number" min="1" max="6" value="' + c.summarySentences + '" /></label>' +
      '<label class="fl">标签数量<input id="cfg-tags" type="number" min="1" max="12" value="' + c.topKTags + '" /></label></div>' +
      '</div></section>' +

      '<section class="card"><div class="card-h"><h3>LLM 接入（可选）</h3></div><div class="form">' +
      '<label class="fl inline"><input type="checkbox" id="cfg-llm"' + (c.llm.enabled ? ' checked' : '') + ' /> 启用 LLM 归类与提炼</label>' +
      '<label class="fl">网关 URL<input id="cfg-url" value="' + h(c.llm.url) + '" placeholder="https://your-gateway/v1/chat/completions" /></label>' +
      '<div class="row2"><label class="fl">模型<input id="cfg-model" value="' + h(c.llm.model) + '" /></label><label class="fl">超时(ms)<input id="cfg-timeout" type="number" value="' + c.llm.timeoutMs + '" /></label></div>' +
      '<label class="fl">临时 API Key（仅当前浏览器会话）<input id="cfg-key" type="password" autocomplete="off" placeholder="推荐留空并使用同源服务端网关" /></label>' +
      '<label class="fl inline"><input type="checkbox" id="cfg-fallback"' + (c.llm.fallback ? ' checked' : '') + ' /> 调用失败时回落到本地算法</label>' +
      '<div class="dim small">Key 不写入 localStorage；静态页面不适合直连生产密钥。LLM 只增强待确认建议，绝不绕过人工确认直接写入正式笔记。</div>' +
      '</div></section>' +

      '<section class="card"><div class="card-h"><h3>分层记忆</h3></div><div class="form">' +
      '<label class="fl inline"><input type="checkbox" id="cfg-memory"' + (c.memory.enabled ? ' checked' : '') + ' /> 允许 Agent 检索已保存记忆</label>' +
      '<div class="row2"><label class="fl">默认保留天数<input id="cfg-memory-ttl" type="number" min="0" max="3650" value="' + c.memory.defaultTtlDays + '" /></label>' +
      '<label class="fl">单次最多召回<input id="cfg-memory-max" type="number" min="1" max="20" value="' + c.memory.maxRecall + '" /></label></div>' +
      '<div class="dim small">记忆按会话 / 任务 / 长期偏好分层；到期自动清除。当前保存 ' + (S.db.memories || []).length + ' 条。</div>' +
      '</div></section>' +

      '<section class="card"><div class="card-h"><h3>数据主权</h3></div>' +
      '<div class="form"><div class="dim small">全量数据（含全部版本历史）保存在本机浏览器 localStorage。可导出为 JSON 备份，或导入他人数据。</div>' +
      '<div class="form-actions"><button class="btn ghost" id="btn-import">导入 JSON</button>' +
      '<input type="file" id="imp-file" accept=".json" style="display:none" />' +
      '<button class="btn danger" id="btn-reset">重置为示例数据</button></div></div></section>' +

      '<section class="card"><div class="card-h"><h3>关于</h3></div><div class="about">' +
      '<div><b>RecNote Agent</b> v1.0 · R1 MVP</div>' +
      '<div class="dim small">数据规模：' + S.db.sources.length + ' 素材 / ' + S.db.segments.length + ' 片段 / ' + S.db.notes.length + ' 笔记 / ' + S.db.versions.length + ' 版本 / ' + S.db.suggestions.length + ' 建议</div>' +
      '<div class="dim small">对应设计文档：docs/PRD.md</div></div></section></div>';
  }

  function saveSettings() {
    S.saveConfig({
      minConfidence: parseFloat($('#cfg-conf').value),
      mergeThreshold: parseFloat($('#cfg-merge').value),
      suspectThreshold: parseFloat($('#cfg-suspect').value),
      sliceMode: $('#cfg-slice').value,
      coherenceThreshold: parseFloat($('#cfg-coh').value),
      summarySentences: parseInt($('#cfg-sum').value, 10),
      topKTags: parseInt($('#cfg-tags').value, 10),
      llm: {
        enabled: $('#cfg-llm').checked, url: $('#cfg-url').value.trim(),
        model: $('#cfg-model').value.trim(), timeoutMs: parseInt($('#cfg-timeout').value, 10),
        fallback: $('#cfg-fallback').checked
      },
      memory: {
        enabled: $('#cfg-memory').checked,
        defaultTtlDays: parseInt($('#cfg-memory-ttl').value, 10),
        maxRecall: parseInt($('#cfg-memory-max').value, 10)
      }
    });
    S.setRuntimeApiKey($('#cfg-key').value);
    toast('设置已保存');
    render();
  }

  function exportJson() {
    const blob = new Blob([S.exportJSON()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'recnote-export-' + new Date().toISOString().slice(0, 10) + '.json';
    a.click();
    toast('已导出 JSON');
  }

  function bindSettings() {
    const imp = $('#imp-file');
    $('#btn-import').addEventListener('click', () => imp.click());
    imp.addEventListener('change', (e) => {
      const f = e.target.files[0]; if (!f) return;
      const r = new FileReader();
      r.onload = () => {
        const mode = confirm('点「确定」= 合并模式（保留现有数据）\n点「取消」= 覆盖模式（清空后导入）') ? 'merge' : 'replace';
        try { S.importJSON(r.result, mode); toast('导入成功'); render(); } catch (e) { toast('导入失败：' + e.message, 'err'); }
      };
      r.readAsText(f, 'utf-8');
    });
    $('#btn-reset').addEventListener('click', () => {
      if (!confirm('重置会清空当前所有数据并载入示例素材，确定？')) return;
      S.seed(); Agent.reprocess(); toast('已重置'); render();
    });
  }

  /* ================= 绑定分发 ================= */
  function bind(route) {
    const map = { ingest: bindIngest, inbox: bindInbox, library: bindLibrary, search: bindSearch, taxonomy: bindTaxonomy, settings: bindSettings };
    const f = map[route];
    if (f) f();
    // 通用：data-go 跳转
    document.querySelectorAll('[data-go]').forEach((el) => el.addEventListener('click', () => go(el.dataset.go)));
    if (route === 'dashboard') {
      document.querySelectorAll('[data-src-view]').forEach((a) => a.addEventListener('click', () => viewSource(a.dataset.srcView)));
    }
    if (route === 'ingest') renderSourceList();
  }

  /* ================= 启动 ================= */
  window.closeModal = closeModal;
  // 对外暴露少量句柄：调试、端到端测试、URL 编程跳转
  window.RecNote = {
    go, render, toast, state, viewSource,
    dialogs: { newNote: newNoteDialog, cat: catDialog, edit: editDialog, reclass: reclassDialog }
  };
  S.init();
  // 首次打开：灌入示例素材并自动跑一遍管线，让用户直接看到成库结果
  let firstBoot = false;
  if (S.isEmpty()) { S.seed(); firstBoot = true; }
  if (firstBoot && S.db.sources.length && !S.db.segments.length) {
    try { Agent.reprocess(); } catch (e) { console.warn('初始管线失败', e); }
  }
  window.addEventListener('hashchange', () => {
    const r = location.hash.replace('#', '');
    if (r.indexOf('note/') === 0) go('note', r.slice(5));
    else if (r) go(r);
  });
  const initHash = location.hash.replace('#', '');
  if (initHash.indexOf('note/') === 0) go('note', initHash.slice(5));
  else if (initHash) go(initHash); else go('dashboard');
})();
