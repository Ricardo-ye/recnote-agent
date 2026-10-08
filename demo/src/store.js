/* store.js — 数据层：实体、持久化、版本快照、种子数据
 * 所有写操作必须走 Store.xxx 静态方法，保证 NoteVersion 完整率 100%。
 */
(function (global) {
  'use strict';

  const KEY = 'recnote.db.v1';
  const CFG_KEY = 'recnote.config.v1';

  const uid = (p) => p + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const now = () => new Date().toISOString();

  /* ---------------- 默认分类体系 ---------------- */
  const DEFAULT_CATEGORIES = [
    { id: 'cat_product', name: '产品需求', parent_id: null, color: '#4f6ef7', keywords: ['需求', '功能', '用户故事', '优先级', 'PRD', '验收', '排期', '迭代', '原型'] },
    { id: 'cat_research', name: '用户研究', parent_id: null, color: '#12a594', keywords: ['用户', '访谈', '反馈', '痛点', '调研', '样本', '画像', '可用性'] },
    { id: 'cat_tech', name: '技术方案', parent_id: null, color: '#8e5cf7', keywords: ['架构', '接口', '性能', '数据库', '算法', '部署', '延迟', '并发', '缓存', '方案设计'] },
    { id: 'cat_competitor', name: '竞品分析', parent_id: null, color: '#f59e0b', keywords: ['竞品', '对标', '友商', '市场', '定价', '差异化', 'benchmark'] },
    { id: 'cat_decision', name: '会议决策', parent_id: null, color: '#e5484d', keywords: ['决定', '决议', '结论', '拍板', '下一步', 'owner', '负责人', '截止'] },
    { id: 'cat_todo', name: '待办事项', parent_id: null, color: '#3b82f6', keywords: ['待办', 'TODO', '行动项', '跟进', '完成', '本周内', '下周'] },
    { id: 'cat_quote', name: '素材摘录', parent_id: null, color: '#6b7280', keywords: ['金句', '摘录', '引用', '案例', '数据'] }
  ];

  const DEFAULT_CONFIG = {
    sliceMode: 'hybrid',          // rule | hybrid
    sliceWindow: 3,
    coherenceThreshold: 0.12,
    minConfidence: 0.45,          // 低于此值强制进 Inbox
    mergeThreshold: 0.82,
    suspectThreshold: 0.6,
    topKTags: 5,
    summarySentences: 3,
    // apiKey 不落盘：静态演示页没有安全的密钥存储能力。生产环境应配置同源代理，
    // 令代理从服务端环境变量读取凭据。
    llm: { enabled: false, url: '', apiKey: '', model: 'gpt-4o-mini', timeoutMs: 20000, fallback: true },
    memory: { enabled: true, defaultTtlDays: 90, maxRecall: 5 }
  };

  /* ---------------- 种子数据 ---------------- */
  const SEED_SOURCES = [
    {
      id: 'src_seed_1',
      title: 'Q3 产品评审会 · 转写',
      source_type: 'meeting',
      occurred_at: '2026-09-18T14:00:00.000Z',
      char_count: 0,
      raw_text: [
        '张伟：今天主要过一下 Q3 的需求排期，大家先看文档。',
        '张伟：第一个，语义搜索这块的召回准确率现在只有 60%，太低了。线上投诉主要有两类，一是搜不到已经存在的笔记，二是搜出来的结果完全不相关。',
        '李娜：我补充一下，用户反馈里高频词是"搜不到"和"太慢"。有 23% 的用户反馈说响应超过 3 秒。',
        '张伟：技术那边怎么看？',
        '王强：我们试过把 bigram 换成 embedding，实验室里 recall@10 能到 84%，但线上要接向量库，成本和延迟都要重新评估。',
        '王强：如果先不换检索方案，能做的是在查询上做同义词扩展和结果重排，预计准确率能提到 70% 左右。',
        '张伟：那就这样，本期先做查询扩展加重排，召回从 60% 到 70%，向量方案放到 Q4 评估。',
        '李娜：行，我来写这个改进的验收指标，就定核心搜索成功率 70%。',
        '王强：另外缓存也得加，不然查询扩展会让延迟更难看。',
        '张伟：好，行动项记一下：李娜出验收指标，本周五前。王强加查询缓存，下周三前评审。',
        '张伟：最后说风险，Q4 上向量库的话成本是不确定的，需要提前跟财务对齐。'
      ].join('\n')
    },
    {
      id: 'src_seed_2',
      title: '用户访谈 · 知识库管理者',
      source_type: 'interview',
      occurred_at: '2026-09-20T09:30:00.000Z',
      raw_text: [
        '访谈者：日常你怎么用这个知识库？',
        '受访者 P7：我主要是把开会的转写丢进去，然后自己再整理一遍。说实话整理这一步特别花时间，有时候一段话要反复看两三遍才能分清是需求还是吐槽。',
        '访谈者：那你希望系统帮你做什么？',
        '受访者 P7：我希望它能直接给我分好类，然后告诉我哪几条是要我去做的事。最烦的是待办埋在文字里，要靠我自己一句句捞。',
        '受访者 P7：还有一个问题，我特别怕它删我东西。任何自动整理都必须能撤回，能看到改了什么。',
        '访谈者：分类需要你自己定吗？',
        '受访者 P7：我不想自己定，但又不能全听它的。最好是它给个建议我来点一下确认，这样我知道它是怎么想的。',
        '访谈者：检索呢？',
        '受访者 P7：关键词能搜到就行，但我经常记不清原话，就记得大概是"钱"和"贵"相关的，所以最好能搜个意思。'
      ].join('\n')
    },
    {
      id: 'src_seed_3',
      title: '技术方案评审 · 检索层重构',
      source_type: 'meeting',
      occurred_at: '2026-09-25T16:00:00.000Z',
      raw_text: [
        '王强：先说结论，检索层这次只做倒排索引的字段权重优化，不动存储架构。',
        '王强：架构上，标题命中权重 3 倍，标签 2 倍，正文 1 倍，用 BM25 打分。中文这边不引分词器，用 bigram 加单字双粒度建索引，先规避依赖问题。',
        '陈默：单字索引会不会让索引膨胀得很厉害？',
        '王强：单字只保留高频的 3000 个，低频字丢掉。实测索引大小 2.1MB，比原来大 18%，可以接受。',
        '陈默：延迟呢？',
        '王强：P95 从 340ms 降到 120ms。因为省掉了分词那一步。',
        '王强：风险点是同义表达搜不到，这个我们靠查询扩展解决，但扩展词表需要人工维护。',
        '陈默：那就先上，扩展词表我来整理一版。',
        '王强：好，下一步我出接口设计文档，本周内给大家评审。'
      ].join('\n')
    }
  ];

  /* ---------------- Store ---------------- */
  const Store = {
    db: null,
    config: null,

    init() {
      let raw = null;
      try { raw = localStorage.getItem(KEY); } catch (e) { raw = null; }
      if (raw) {
        try { this.db = JSON.parse(raw); } catch (e) { this.db = null; }
      }
      if (!this.db || !this.db.sources) { this.db = this.emptyDB(); this.persist(); }
      // 向后兼容已有 localStorage 数据。迁移只补缺失集合，绝不重置用户内容。
      if (!Array.isArray(this.db.memories)) this.db.memories = [];
      let cfg = null;
      try { cfg = JSON.parse(localStorage.getItem(CFG_KEY)); } catch (e) { cfg = null; }
      this.config = Object.assign({}, DEFAULT_CONFIG, cfg || {});
      this.config.llm = Object.assign({}, DEFAULT_CONFIG.llm, (cfg && cfg.llm) || {});
      this.config.memory = Object.assign({}, DEFAULT_CONFIG.memory, (cfg && cfg.memory) || {});
      // 旧版可能把 Key 写进配置；读到后立即移出持久化对象，避免继续扩散。
      this.runtimeApiKey = this.config.llm.apiKey || '';
      this.config.llm.apiKey = '';
      this.pruneMemories();
      return this;
    },

    emptyDB() {
      return {
        sources: [],
        segments: [],
        notes: [],
        versions: [],
        tags: [],
        noteTags: [],
        suggestions: [],
        runs: [],
        // 分层记忆：会话/任务/长期偏好均可独立设置过期时间与来源。
        memories: [],
        categories: DEFAULT_CATEGORIES.map((c) => Object.assign({ sort_order: 0 }, c))
      };
    },

    persist() {
      try { localStorage.setItem(KEY, JSON.stringify(this.db)); } catch (e) { console.warn('persist failed', e); }
    },

    saveConfig(patch) {
      this.config = Object.assign({}, this.config, patch);
      this.config.llm = Object.assign({}, DEFAULT_CONFIG.llm, this.config.llm || {});
      this.config.memory = Object.assign({}, DEFAULT_CONFIG.memory, this.config.memory || {});
      this.config.llm.apiKey = ''; // 永不写入 localStorage
      try { localStorage.setItem(CFG_KEY, JSON.stringify(this.config)); } catch (e) { /* ignore */ }
    },

    resetConfig() { this.config = JSON.parse(JSON.stringify(DEFAULT_CONFIG)); this.saveConfig({}); },

    setRuntimeApiKey(apiKey) {
      this.runtimeApiKey = String(apiKey || '').trim();
      // sessionStorage 仅用于刷新前的演示会话；异常时宁可失效也不降级到持久化保存。
      try {
        if (this.runtimeApiKey) sessionStorage.setItem('recnote.runtimeApiKey', this.runtimeApiKey);
        else sessionStorage.removeItem('recnote.runtimeApiKey');
      } catch (e) { /* 受限浏览器可禁用 storage，调用方仍可传入 key */ }
    },

    getRuntimeApiKey() {
      if (this.runtimeApiKey) return this.runtimeApiKey;
      try { return sessionStorage.getItem('recnote.runtimeApiKey') || ''; } catch (e) { return ''; }
    },

    pruneMemories(at) {
      const nowMs = new Date(at || now()).getTime();
      if (!Array.isArray(this.db && this.db.memories)) return 0;
      const before = this.db.memories.length;
      this.db.memories = this.db.memories.filter((m) => !m.expires_at || new Date(m.expires_at).getTime() > nowMs);
      if (before !== this.db.memories.length) this.persist();
      return before - this.db.memories.length;
    },

    remember(input) {
      const item = input || {};
      const scope = ['session', 'task', 'long_term'].includes(item.scope) ? item.scope : 'task';
      const content = String(item.content || '').trim();
      if (!content || content.length > 2000) throw new Error('记忆内容不能为空且不能超过 2000 字符。');
      const ttlDays = Number.isFinite(Number(item.ttlDays)) ? Number(item.ttlDays) : this.config.memory.defaultTtlDays;
      if (ttlDays < 0 || ttlDays > 3650) throw new Error('记忆保留天数必须在 0 到 3650 之间。');
      const created = now();
      const record = {
        id: uid('mem'), scope: scope, content: content,
        tags: Array.isArray(item.tags) ? item.tags.map((x) => String(x).trim()).filter(Boolean).slice(0, 10) : [],
        source_id: item.source_id || null, note_id: item.note_id || null,
        created_at: created,
        expires_at: ttlDays === 0 ? null : new Date(Date.now() + ttlDays * 86400000).toISOString()
      };
      this.db.memories.push(record);
      this.persist();
      return record;
    },

    recallMemories(query, options) {
      this.pruneMemories();
      const q = String(query || '').toLowerCase().trim();
      const max = Math.max(1, Math.min(Number((options || {}).limit) || this.config.memory.maxRecall, 20));
      const scopes = (options || {}).scopes || ['session', 'task', 'long_term'];
      return this.db.memories.filter((m) => scopes.includes(m.scope)).map((m) => {
        const haystack = (m.content + ' ' + (m.tags || []).join(' ')).toLowerCase();
        const score = q ? q.split(/\s+/).filter(Boolean).reduce((n, token) => n + (haystack.includes(token) ? 1 : 0), 0) : 0;
        return Object.assign({ score: score }, m);
      }).filter((m) => !q || m.score > 0).sort((a, b) => b.score - a.score || b.created_at.localeCompare(a.created_at)).slice(0, max);
    },

    forgetMemory(id) {
      const before = this.db.memories.length;
      this.db.memories = this.db.memories.filter((m) => m.id !== id);
      if (before !== this.db.memories.length) this.persist();
      return before !== this.db.memories.length;
    },

    /* ---------- 通用 ---------- */
    byId(coll, id) { return (this.db[coll] || []).find((x) => x.id === id) || null; },

    fingerprint(text) {
      // FNV-1a 32bit 变体，够用的内容指纹
      let h = 0x811c9dc5;
      const s = String(text).replace(/\s+/g, '');
      for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
      }
      return 'fp_' + h.toString(16);
    },

    /* ---------- Source ---------- */
    findByFingerprint(fp) { return this.db.sources.find((s) => s.fingerprint === fp) || null; },

    addSource({ title, source_type, occurred_at, raw_text }) {
      const fp = this.fingerprint(raw_text);
      const dup = this.findByFingerprint(fp);
      if (dup) return { error: 'duplicate', source: dup };
      const src = {
        id: uid('src'),
        title: title || ('未命名素材 ' + (this.db.sources.length + 1)),
        source_type: source_type || 'upload',
        occurred_at: occurred_at || now(),
        raw_text: raw_text,
        fingerprint: fp,
        char_count: raw_text.length,
        created_at: now(),
        note_count: 0
      };
      this.db.sources.push(src);
      this.persist();
      return { source: src };
    },

    removeSource(id) {
      this.db.sources = this.db.sources.filter((s) => s.id !== id);
      this.db.segments = this.db.segments.filter((s) => s.source_id !== id);
      this.db.suggestions = this.db.suggestions.filter((s) => s.source_id !== id);
      const noteIds = this.db.noteTags.filter(() => false); // noop keep lint quiet
      void noteIds;
      this.db.noteTags = this.db.noteTags.filter((nt) => {
        const n = this.byId('notes', nt.note_id);
        return n ? n.source_ids.indexOf(id) !== -1 : false;
      });
      this.db.notes.forEach((n) => { n.source_ids = n.source_ids.filter((x) => x !== id); });
      this.persist();
    },

    getSource(id) { return this.byId('sources', id); },

    segmentsOf(sourceId) { return this.db.segments.filter((s) => s.source_id === sourceId); },

    notesOfSource(sourceId) { return this.db.notes.filter((n) => n.source_ids.indexOf(sourceId) !== -1); },

    /* ---------- Category ---------- */
    categories() { return this.db.categories.slice().sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0)); },

    addCategory({ name, color, keywords, parent_id }) {
      const c = { id: uid('cat'), name: name, parent_id: parent_id || null, color: color || '#6b7280', keywords: keywords || [], sort_order: this.db.categories.length };
      this.db.categories.push(c); this.persist(); return c;
    },

    updateCategory(id, patch) {
      const c = this.byId('categories', id);
      if (!c) return null;
      Object.assign(c, patch);
      this.persist(); return c;
    },

    removeCategory(id) {
      if (this.db.notes.some((n) => n.category_id === id && !n.deleted_at)) {
        return { error: 'not_empty' };
      }
      this.db.categories = this.db.categories.filter((c) => c.id !== id);
      this.persist(); return { ok: true };
    },

    categoryName(id) { const c = this.byId('categories', id); return c ? c.name : '未分类'; },
    categoryColor(id) { const c = this.byId('categories', id); return c ? c.color : '#9ca3af'; },

    /* ---------- Note + Version ---------- */
    /** 字段级 diff：统计增删字符并给出预览 */
    diffField(oldV, newV, field) {
      const a = (oldV && oldV[field] != null) ? String(oldV[field]) : '';
      const b = (newV[field] != null) ? String(newV[field]) : '';
      if (a === b) return null;
      // 极简 LCS 差分：统计公共前缀/后缀之外的替换规模
      let p = 0;
      const maxP = Math.min(a.length, b.length);
      while (p < maxP && a[p] === b[p]) p++;
      let s = 0;
      while (s < Math.min(a.length - p, b.length - p) && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
      const removed = a.slice(p, a.length - s);
      const added = b.slice(p, b.length - s);
      return { field, added: added.length, removed: removed.length, preview: (added.slice(0, 60) || removed.slice(0, 60)) };
    },

    snapshot(note, tagNames) {
      return {
        title: note.title, body: note.body, summary: note.summary,
        category_id: note.category_id, tags: tagNames.slice(),
        source_ids: note.source_ids.slice()
      };
    },

    /** 写入新版本。changeType 决定 change_type 字段。 */
    pushVersion(noteId, changeType, changeNote, changeTypeAlias) {
      const note = this.byId('notes', noteId);
      if (!note) return null;
      const tagNames = this.tagsOf(noteId);
      const snap = this.snapshot(note, tagNames);
      const prev = this.versionsOf(noteId).slice(-1)[0];
      const prevSnap = prev ? { title: prev.title, body: prev.body, summary: prev.summary, category_id: prev.category_id, tags: prev.tags } : null;
      const fields = ['title', 'body', 'summary', 'category_id', 'tags'];
      const diffs = fields.map((f) => this.diffField(prevSnap, snap, f)).filter(Boolean);
      const ver = {
        id: uid('ver'),
        note_id: noteId,
        version_no: (prev ? prev.version_no : 0) + 1,
        title: snap.title, body: snap.body, summary: snap.summary,
        category_id: snap.category_id, tags: snap.tags, source_ids: snap.source_ids,
        diff: diffs,
        change_type: changeType,
        change_note: changeNote || changeTypeAlias || '',
        created_at: now()
      };
      this.db.versions.push(ver);
      note.version_count = this.versionsOf(noteId).length;
      note.updated_at = now();
      this.persist();
      return ver;
    },

    versionsOf(noteId) {
      return this.db.versions.filter((v) => v.note_id === noteId).sort((a, b) => a.version_no - b.version_no);
    },

    createNote(data, changeNote) {
      const note = {
        id: uid('note'),
        title: data.title,
        summary: data.summary || '',
        body: data.body || '',
        category_id: data.category_id,
        status: 'active',
        source_ids: data.source_ids || [],
        segment_ids: data.segment_ids || [],
        confidence: data.confidence != null ? data.confidence : 1,
        is_duplicate_suspect: !!data.is_duplicate_suspect,
        duplicate_of: data.duplicate_of || null,
        merged_into: null,
        version_count: 0,
        created_at: now(), updated_at: now(), deleted_at: null
      };
      this.db.notes.push(note);
      (data.tags || []).forEach((t) => this.linkTag(note.id, t));
      (data.source_ids || []).forEach((sid) => { const s = this.getSource(sid); if (s) s.note_count = this.notesOfSource(sid).length; });
      this.pushVersion(note.id, 'create', changeNote || '由 Agent 管线创建');
      return note;
    },

    updateNote(noteId, patch, changeNote, changeType) {
      const note = this.byId('notes', noteId);
      if (!note) return null;
      Object.assign(note, patch);
      if (patch.tags) {
        this.db.noteTags = this.db.noteTags.filter((nt) => nt.note_id !== noteId);
        patch.tags.forEach((t) => this.linkTag(noteId, t));
      }
      this.pushVersion(noteId, changeType || 'edit', changeNote);
      return note;
    },

    /** 回滚到指定版本；回滚本身也产生新版本，历史不可销毁 */
    rollback(noteId, versionNo) {
      const target = this.versionsOf(noteId).find((v) => v.version_no === versionNo);
      if (!target) return null;
      const note = this.byId('notes', noteId);
      Object.assign(note, { title: target.title, body: target.body, summary: target.summary, category_id: target.category_id });
      this.db.noteTags = this.db.noteTags.filter((nt) => nt.note_id !== noteId);
      (target.tags || []).forEach((t) => this.linkTag(noteId, t));
      this.pushVersion(noteId, 'rollback', '回滚至 v' + versionNo);
      return note;
    },

    softDelete(noteId) {
      const note = this.byId('notes', noteId);
      if (!note) return null;
      note.deleted_at = now();
      note.status = 'archived';
      this.pushVersion(noteId, 'delete', '移入回收站');
      return note;
    },

    restore(noteId) {
      const note = this.byId('notes', noteId);
      if (!note) return null;
      note.deleted_at = null;
      note.status = 'active';
      this.pushVersion(noteId, 'archive', '从回收站恢复');
      return note;
    },

    /** 合并：keep 保留并吸收 drop 的正文与来源，drop 归档指向 keep */
    mergeNotes(keepId, dropId, changeNote) {
      const keep = this.byId('notes', keepId);
      const drop = this.byId('notes', dropId);
      if (!keep || !drop) return null;
      keep.source_ids = Array.from(new Set(keep.source_ids.concat(drop.source_ids)));
      keep.segment_ids = Array.from(new Set((keep.segment_ids || []).concat(drop.segment_ids || [])));
      const body = keep.body + (keep.body && drop.body ? '\n\n---\n\n' : '') + drop.body;
      this.updateNote(keepId, { body: body }, changeNote || ('合并自「' + drop.title + '」'), 'merge');
      drop.status = 'superseded';
      drop.merged_into = keepId;
      drop.updated_at = now();
      this.persist();
      return keep;
    },

    activeNotes() {
      return this.db.notes.filter((n) => !n.deleted_at && n.status === 'active');
    },

    trashedNotes() { return this.db.notes.filter((n) => n.deleted_at); },

    /* ---------- Tag ---------- */
    allTags() { return this.db.tags.slice().sort((a, b) => b.usage_count - a.usage_count); },

    linkTag(noteId, name) {
      const clean = String(name).trim();
      if (!clean) return null;
      let tag = this.db.tags.find((t) => t.name === clean);
      if (!tag) { tag = { id: uid('tag'), name: clean, usage_count: 0 }; this.db.tags.push(tag); }
      if (!this.db.noteTags.some((nt) => nt.note_id === noteId && nt.tag_id === tag.id)) {
        this.db.noteTags.push({ note_id: noteId, tag_id: tag.id });
      }
      tag.usage_count = this.db.noteTags.filter((nt) => nt.tag_id === tag.id).length;
      return tag;
    },

    tagsOf(noteId) {
      return this.db.noteTags.filter((nt) => nt.note_id === noteId)
        .map((nt) => { const t = this.byId('tags', nt.tag_id); return t ? t.name : null; })
        .filter(Boolean);
    },

    renameTag(tagId, newName) {
      const t = this.byId('tags', tagId);
      if (!t) return false;
      const old = t.name; t.name = newName;
      if (this.db.tags.some((x) => x.name === newName && x.id !== tagId)) return false; // 重名
      t.usage_count = this.db.noteTags.filter((nt) => nt.tag_id === tagId).length;
      this.db.notes.forEach((n) => { if (this.tagsOf(n.id).indexOf(old) !== -1) { /* 版本内标签历史保留原名 */ } });
      this.persist(); return true;
    },

    mergeTag(fromId, intoId) {
      const from = this.byId('tags', fromId), into = this.byId('tags', intoId);
      if (!from || !into) return false;
      this.db.noteTags.filter((nt) => nt.tag_id === fromId).forEach((nt) => this.linkTag(nt.note_id, into.name));
      this.db.noteTags = this.db.noteTags.filter((nt) => nt.tag_id !== fromId);
      this.db.tags = this.db.tags.filter((t) => t.id !== fromId);
      into.usage_count = this.db.noteTags.filter((nt) => nt.tag_id === intoId).length;
      this.persist(); return true;
    },

    removeTag(tagId) {
      this.db.noteTags = this.db.noteTags.filter((nt) => nt.tag_id !== tagId);
      this.db.tags = this.db.tags.filter((t) => t.id !== tagId);
      this.persist();
    },

    /* ---------- Suggestion ---------- */
    addSuggestion(s) { this.db.suggestions.push(s); this.persist(); return s; },

    pendingSuggestions() { return this.db.suggestions.filter((s) => s.status === 'pending'); },

    resolveSuggestion(id, status) {
      const s = this.byId('suggestions', id);
      if (!s) return null;
      s.status = status; s.resolved_at = now();
      this.persist(); return s;
    },

    /* ---------- Run ---------- */
    addRun(r) { this.db.runs.push(r); this.persist(); return r; },
    runs() { return this.db.runs.slice().reverse(); },

    /* ---------- 种子 ---------- */
    seed() {
      this.db = this.emptyDB();
      SEED_SOURCES.forEach((s) => {
        const src = Object.assign({}, s);
        src.id = s.id || uid('src');
        src.fingerprint = this.fingerprint(src.raw_text);
        src.char_count = src.raw_text.length;
        src.created_at = now();
        src.note_count = 0;
        this.db.sources.push(src);
      });
      this.persist();
      return this.db.sources.length;
    },

    isEmpty() { return this.db.sources.length === 0 && this.db.notes.length === 0; },

    exportJSON() {
      return JSON.stringify({ exported_at: now(), config: this.config, db: this.db }, null, 2);
    },

    importJSON(text, mode) {
      const parsed = JSON.parse(text);
      const incoming = parsed.db || parsed;
      if (mode === 'replace') { this.db = incoming; }
      else {
        const ids = new Set(this.db.notes.map((n) => n.id));
        (incoming.notes || []).forEach((n) => { if (!ids.has(n.id)) this.db.notes.push(n); });
        const sids = new Set(this.db.sources.map((s) => s.id));
        (incoming.sources || []).forEach((s) => { if (!sids.has(s.id)) this.db.sources.push(s); });
        (incoming.segments || []).forEach((sg) => this.db.segments.push(sg));
        (incoming.versions || []).forEach((v) => this.db.versions.push(v));
        (incoming.tags || []).forEach((t) => { if (!this.db.tags.some((x) => x.name === t.name)) this.db.tags.push(t); });
        (incoming.categories || []).forEach((c) => { if (!this.db.categories.some((x) => x.id === c.id)) this.db.categories.push(c); });
        const mids = new Set((this.db.memories || []).map((m) => m.id));
        (incoming.memories || []).forEach((m) => { if (m && m.id && !mids.has(m.id)) this.db.memories.push(m); });
      }
      if (parsed.config) this.saveConfig(parsed.config);
      if (!Array.isArray(this.db.memories)) this.db.memories = [];
      this.pruneMemories();
      this.persist();
      return true;
    },

    uid: uid, now: now, DEFAULT_CONFIG: DEFAULT_CONFIG
  };

  global.Store = Store;
})(window);
