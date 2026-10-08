/* search.js — 倒排索引 + BM25 变体检索 + 关键词高亮
 * 中文用 bigram + 单字双粒度，无需分词器依赖。
 */
(function (global) {
  'use strict';

  const FIELD_WEIGHT = { title: 3, tags: 2, body: 1, summary: 1.2 };

  function buildIndex(notes) {
    const docs = [];
    notes.forEach((n) => {
      const fields = {
        title: n.title || '',
        tags: (Store.tagsOf(n.id) || []).join(' '),
        summary: n.summary || '',
        body: n.body || ''
      };
      const tf = {};
      Object.keys(fields).forEach((f) => {
        Agent.tokenize(fields[f]).forEach((t) => {
          const k = t + '|' + f;
          tf[k] = (tf[k] || 0) + 1;
        });
      });
      let len = 0;
      Object.keys(fields).forEach((f) => { len += Object.keys(tf).filter((k) => k.endsWith('|' + f)).reduce((a, k) => a + tf[k], 0) * FIELD_WEIGHT[f]; });
      docs.push({ id: n.id, note: n, tf: tf, len: len || 1, fields: fields });
    });
    const df = {};
    docs.forEach((d) => { Object.keys(d.tf).forEach((k) => { df[k] = (df[k] || 0) + 1; }); });
    const avgLen = docs.reduce((s, d) => s + d.len, 0) / Math.max(1, docs.length);
    return { docs: docs, df: df, N: Math.max(1, docs.length), avgLen: avgLen };
  }

  const K1 = 1.4, B = 0.72;

  function bm25(index, queryTerms) {
    const scores = {};
    index.docs.forEach((d) => {
      let s = 0;
      queryTerms.forEach((qt) => {
        Object.keys(d.tf).forEach((k) => {
          const [t, f] = k.split('|');
          if (t !== qt) return;
          const tf = d.tf[k];
          const n = index.df[k] || 0;
          const idf = Math.log(1 + (index.N - n + 0.5) / (n + 0.5));
          s += FIELD_WEIGHT[f] * idf * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + B * d.len / index.avgLen)));
        });
      });
      if (s > 0) scores[d.id] = s;
    });
    return scores;
  }

  /** 查询语法：分类:xxx 标签:xxx 其余为裸词 */
  function parseQuery(raw) {
    const q = { text: '', category: null, tag: null, terms: [] };
    const parts = String(raw || '').match(/(分类|标签):[^\s]+|[^\s]+/g) || [];
    const bare = [];
    parts.forEach((p) => {
      if (p.indexOf('分类:') === 0) q.category = p.slice(3);
      else if (p.indexOf('标签:') === 0) q.tag = p.slice(3);
      else bare.push(p);
    });
    q.text = bare.join(' ');
    q.terms = Agent.tokenize(q.text);
    return q;
  }

  function highlight(text, terms) {
    if (!text) return '';
    const uniq = Array.from(new Set(terms.filter((t) => t.length >= 1))).sort((a, b) => b.length - a.length);
    if (!uniq.length) return escapeHtml(text);
    let re;
    try { re = new RegExp(uniq.map(escapeRe).join('|'), 'gi'); } catch (e) { return escapeHtml(text); }
    return escapeHtml(text).replace(re, (m) => '<mark>' + m + '</mark>');
  }

  function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /** 主入口：返回 [{note, score, snippet}] */
  function search(rawQuery, pool) {
    const notes = pool || Store.activeNotes();
    const q = parseQuery(rawQuery);
    let filtered = notes;
    if (q.category) filtered = filtered.filter((n) => Store.categoryName(n.category_id) === q.category || n.category_id === q.category);
    if (q.tag) filtered = filtered.filter((n) => (Store.tagsOf(n.id) || []).some((t) => t.toLowerCase() === q.tag.toLowerCase()));
    if (!q.terms.length) {
      return filtered.map((note) => ({ note, score: 0, snippet: escapeHtml((note.summary || note.body || '').slice(0, 120)) }));
    }
    const index = buildIndex(filtered);
    const scores = bm25(index, q.terms);
    return Object.keys(scores)
      .map((id) => {
        const doc = index.docs.find((d) => d.id === id);
        return { note: doc.note, score: scores[id], snippet: makeSnippet(doc.fields, q.terms) };
      })
      .sort((a, b) => b.score - a.score);
  }

  function makeSnippet(fields, terms) {
    const order = ['body', 'summary', 'title'];
    for (let i = 0; i < order.length; i++) {
      const t = fields[order[i]] || '';
      if (!t) continue;
      const pos = findFirst(t, terms);
      if (pos < 0) continue;
      const start = Math.max(0, pos - 30);
      return (start > 0 ? '…' : '') + highlight(t.slice(start, start + 140), terms) + (t.length > start + 140 ? '…' : '');
    }
    return escapeHtml((fields.title || '').slice(0, 80));
  }

  function findFirst(text, terms) {
    const lower = text.toLowerCase();
    let best = -1;
    terms.forEach((t) => {
      const p = lower.indexOf(t.toLowerCase());
      if (p >= 0 && (best < 0 || p < best)) best = p;
    });
    return best;
  }

  /** Facet 统计 */
  function facets(notes) {
    const cat = {}, tag = {};
    notes.forEach((n) => {
      const cn = Store.categoryName(n.category_id);
      cat[cn] = (cat[cn] || 0) + 1;
      (Store.tagsOf(n.id) || []).forEach((t) => { tag[t] = (tag[t] || 0) + 1; });
    });
    return {
      category: Object.keys(cat).map((k) => ({ name: k, count: cat[k] })).sort((a, b) => b.count - a.count),
      tag: Object.keys(tag).map((k) => ({ name: k, count: tag[k] })).sort((a, b) => b.count - a.count)
    };
  }

  global.Search = { buildIndex, search, parseQuery, highlight, facets, escapeHtml, bm25 };
})(window);
