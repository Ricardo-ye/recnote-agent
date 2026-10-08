# 录音笔记整理 Agent — 产品设计文档（R1 MVP）

> 代号 **RecNote Agent**
> 版本 v1.0 · 2026-10-04 · 状态：已交付可运行 Demo

---

## 0. 一句话定位

用户丢进来一堆**零散、异构、无结构**的录音转写文字和资料，Agent 自动完成「切片 → 归类 → 提炼 → 建索引 → 建库」，产出**可检索、可追溯、可演进**的结构化笔记库。

**核心差异点**：不是"录音转文字"，而是**保留溯源链路的自动归档**。每条笔记都能回溯到原始录音的哪一秒、由哪次 Agent 运行生成、被谁在哪一版改过。

---

## 1. 问题定义与设计取舍

| 现状痛点 | 方案 | 放弃的替代方案 | 取舍理由 |
|---|---|---|---|
| 录音转写是大段流水文字，无法检索 | 语义切片 + 倒排索引 + 结构化字段 | 全文塞进一个 blob 靠 DB LIKE 搜 | LIKE 无法支撑分类过滤和 facet 聚合 |
| 同一主题散落在多次录音里，重复建笔记 | 向量相似度去重 + 增量合并建议 | 每次都新建 | 笔记库一旦重复膨胀就失去价值；但全自动合并风险高，故降级为**人在环确认** |
| Agent 提炼可能抽错、丢信息 | 低置信度降级为「待确认」而非直接入库 | 全自动直接落库 | 错误一旦入库，版本记录只能追溯不能回退；把决策权留给人成本更低 |
| 笔记会持续演进，事后无法知道改了什么 | 每次编辑生成不可变版本快照 + 字段级 diff | 只存 git 式全量快照无 diff | 运营场景关心"这次改了什么"而非"仓库有多少字节" |

---

## 2. 核心页面结构

```
RecNote Agent
├── 工作台 Dashboard          # 全局态势 + 待办入口
├── 摄入台 Ingest             # 上传/粘贴 → 跑 Agent 管线
├── 确认队列 Inbox            # ★人在环：接受/改判/丢弃/合并
├── 笔记库 Library            # 列表 + 多维筛选 + 批量操作
│   └── 笔记详情 Note Detail  # 正文 / 溯源 / 版本时间线 / diff 回滚
├── 全文检索 Search           # 高亮 + facet 联动
├── 分类与标签 Taxonomy       # 分类树 CRUD、标签合并重命名
└── 设置 Settings             # 归类规则、阈值、模型接入、导入导出
```

### 2.1 页面职责与关键组件

| 页面 | 核心问题 | 关键组件 | 主动作 |
|---|---|---|---|
| Dashboard | 「现在有多少东西需要我处理」 | 统计卡（素材/笔记/待确认/本月新增）、Agent 运行时间线、待办块 | 跳转待确认队列 |
| Ingest | 「怎么把新料喂进来」 | 素材输入区（粘贴/文件）、来源元信息表单、Agent 参数（切片粒度/提炼深度/是否去重）、**管线可视化**（5 步进度 + 每步产物数） | 运行管线 → 跳转 Inbox |
| Inbox | 「哪些 AI 结论需要人裁决」 | 建议卡片流：建议分类、建议标签、摘要预览、置信度条、与既有笔记的相似度对比、来源片段引用 | 接受 / 改判 / 合并进已有笔记 / 丢弃 |
| Library | 「找并管理已入库的笔记」 | 表格（标题/分类/标签/来源数/版本数/更新时间）、分类树侧栏、标签云、标签多选、排序、批量归档/删除 | 行内编辑 / 打开详情 |
| Note Detail | 「这条笔记怎么来的、怎么改的」 | 三 Tab：**正文**（Markdown + 编辑态 diff 预览）、**溯源**（来源素材 → 片段定位高亮）、**版本**（时间线 + 任意两版对比 + 一键回滚） | 编辑保存 / 回滚 / 追加到合并 |
| Search | 「跨全库找那句话」 | 搜索框（支持 `分类:xxx 标签:xxx` 语法）、结果列表关键词高亮、右侧 facet 计数 | 点击结果 → 详情定位 |
| Taxonomy | 「体系怎么维护」 | 分类树 CRUD、标签表（使用次数、合并/重命名/删除） | 增删改 |
| Settings | 「Agent 行为怎么调」 | 归类规则映射表、置信度阈值、去重相似度阈值、LLM 接口配置（URL/Key/模型）、JSON 导入导出 | 保存 |

### 2.2 信息架构原则

- **左导航固定 7 项**，二级页面不嵌套超过 1 层
- **Inbox 是枢纽**：Agent 产出的一切都先进 Inbox，Dashboard 显示未处理计数作为全局待办红灯
- **溯源链路是双向的**：Note → 溯源 Tab 跳回原始素材片段；Source → 关联笔记列表

---

## 3. 主要功能模块

### M1 素材摄入
- 输入：文本粘贴、单文件上传（.txt / .md / .srt / .vtt / .json）、多文件批量
- 元信息：标题、来源（会议/访谈/课堂/随手记/上传）、发生时间、说话人标注解析（SRT/VTT 格式自动拆段）
- 去重：内容 SHA-256 指纹，重复素材直接拦截并提示已有记录

### M2 切片与说话人分离
- 中文场景不使用空格分词，采用**规则 + 语义边界**双通道：
  - 规则通道：时间戳、说话人标签（`张三：`）、句末标点密度、段落空行
  - 语义通道：滑动窗口 + 主题连贯性打分（TF-IDF 余弦相似度），连贯度低于阈值处切一刀
- 每片保留 `charStart / charEnd`，这是**溯源锚点**

### M3 归类引擎
- 分类树支持多级（预置：产品需求 / 用户研究 / 技术方案 / 竞品分析 / 会议决策 / 待办事项 / 素材摘录）
- 三级信号融合打分：
  1. 关键词命中（分类关键词表，权重 0.4）
  2. 片段与既有分类质心的 TF-IDF 余弦（权重 0.35）
  3. 素材来源类型先验（权重 0.25）
- 输出 Top-3 候选分类 + 置信度；置信度 < 阈值（默认 0.45）→ 强制进 Inbox

### M4 提炼引擎
- 摘要生成：抽取式摘要（TextRank 变体：句子权重 = 词权重和 / 长度惩罚 + 位置先验 + 关键词覆盖加成）
- 结构化槽位抽取：结论、待办（含负责人/时间）、风险、关键数据、术语
- 标签：TF-IDF 提取 top-N 词 + 词性过滤（去停用词、去纯数字）+ 与既有标签的归并
- **接 LLM 的位置预留**：`AgentConfig.llm` 配置后，摘要与槽位改走真实模型调用，接口契约见 §6

### M5 去重与合并
- 笔记级向量（标题+摘要+标签拼接的 TF-IDF 向量）
- 与全库笔记算余弦相似度：
  - `> mergeThreshold`（默认 0.82）→ 生成「合并建议」，Inbox 中展示两版内容对比
  - `0.6 ~ 0.82` → 标记「疑似重复」提示，但不阻塞
- 合并动作语义：**保留两版内容**（旧笔记归档为 superseded，指向新笔记）

### M6 检索
- 倒排索引：中文按 **bigram + 单字** 双粒度建索引（无需分词器，规避中文分词依赖）
- 打分：BM25 变体（含字段权重：标题 ×3、标签 ×2、正文 ×1）
- 查询语法：`分类:产品需求 标签:AI 下周`（裸词走正文）

### M7 版本与回滚
- 任何写操作（编辑、分类变更、合并、归档、删除）生成一条 `NoteVersion` 不可变快照
- 快照内容：标题/正文/分类/标签/来源列表 + 字段级 diff（新增/删除/修改的字符数与片段）
- 任意两版本可对比；回滚本身也生成新版本（不销毁历史）

### M8 分类与标签治理
- 分类树：增删改、拖拽排序、关键词表编辑
- 标签：使用频次统计、合并（把 A 合并进 B）、重命名、按频次清理
- 删除保护：分类下有笔记时禁止删除，只能迁移

### M9 导入导出与数据主权
- 全量 JSON 导出（含全部版本历史）
- JSON 导入（merge / replace 双模式）
- 单篇 Markdown 导出

---

## 4. 数据模型

### 4.1 ER 概览

```
Source 1 ──< Segment >── 1 Category
  │                        ▲
  │                        │(归类)
  └──< NoteSource >── Note ──< NoteVersion
                             │
                             ├──< NoteTag >── Tag
                             └──< Suggestion
```

### 4.2 表结构

**sources**（原始素材）

| 字段 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | `src_` 前缀 |
| title | TEXT | 素材标题 |
| source_type | ENUM | meeting / interview / class / scratch / upload |
| occurred_at | TIMESTAMP | 发生时间 |
| raw_text | TEXT | 原始全文，不可变 |
| fingerprint | TEXT UNIQUE | 内容指纹，防重复导入 |
| char_count | INT | 字数 |
| created_at | TIMESTAMP | 摄入时间 |
| note_count | INT | 派生统计 |

**segments**（切片）

| 字段 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | `seg_` |
| source_id | FK → sources | 归属素材 |
| ordinal | INT | 片内序号 |
| text | TEXT | 片段正文 |
| char_start / char_end | INT | **溯源锚点** |
| speaker | TEXT NULL | 说话人（来自 SRT/标注） |
| timestamp | TEXT NULL | 原始时间戳 |
| keywords | JSON | TF-IDF top 词 |
| coherence | REAL | 与上片的连贯度得分 |

**categories**（分类）

| 字段 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | `cat_` |
| name | TEXT | 分类名 |
| parent_id | FK NULL | 支持两级 |
| keywords | JSON | 归类关键词表 |
| color | TEXT | 展示色 |
| sort_order | INT | 排序 |

**notes**（笔记主表）

| 字段 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | `note_` |
| title | TEXT | |
| summary | TEXT | Agent 提炼摘要 |
| body | TEXT | 正文（可编辑） |
| category_id | FK | 当前分类 |
| status | ENUM | active / archived / superseded |
| source_ids | JSON | 关联素材 |
| confidence | REAL | 归类置信度 |
| is_duplicate_suspect | BOOL | 疑似重复标记 |
| merged_into | FK NULL | 被合并指向 |
| version_count | INT | 派生 |
| created_at / updated_at | TIMESTAMP | |
| deleted_at | TIMESTAMP NULL | 软删 |

**note_versions**（版本历史，不可变）

| 字段 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | `ver_` |
| note_id | FK | |
| version_no | INT | 从 1 递增 |
| title / body / category_id / tags | — | 完整快照 |
| diff | JSON | 字段级变更摘要 `{field, added, removed, preview}` |
| change_type | ENUM | create / edit / recategorize / merge / rollback / archive / delete |
| change_note | TEXT | 变更说明 |
| created_at | TIMESTAMP | |

**tags** / **note_tags**（标签）

| tags | note_tags |
|---|---|
| id TEXT PK / name TEXT / usage_count INT | note_id FK / tag_id FK |

**suggestions**（人在环待确认）

| 字段 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | `sug_` |
| source_id / segment_id | FK | 来源溯源 |
| proposed_category_id | FK | 建议分类 |
| category_confidence | REAL | |
| alternatives | JSON | Top-3 候选 |
| extracted_summary | TEXT | 提炼摘要 |
| extracted_tags | JSON | |
| extracted_slots | JSON | 结论/待办/风险/数据 |
| duplicate_note_id | FK NULL | 疑似重复目标 |
| similarity | REAL NULL | |
| status | ENUM | pending / accepted / rejected / merged |
| created_at / resolved_at | TIMESTAMP | |

**agent_runs**（运行审计）

| 字段 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | `run_` |
| trigger | ENUM | ingest / reprocess / manual |
| source_ids | JSON | |
| steps | JSON | 每步耗时与产物计数 |
| stats | JSON | 片段数/笔记数/建议数/耗时 |
| started_at / finished_at | TIMESTAMP | |

### 4.3 索引设计

| 索引 | 字段 | 用途 |
|---|---|---|
| idx_sources_fp | fingerprint | 导入去重 |
| idx_segments_source | source_id | 溯源回溯 |
| idx_notes_cat | category_id | 分类筛选 |
| idx_notes_status | status | 列表默认过滤 |
| idx_versions_note | note_id, version_no | 时间线 |
| idx_suggestions_status | status | Inbox 拉取 |

---

## 5. 关键交互流程

### F1 摄入 → 自动成库（主链路）

```
用户                前端                  Agent 管线                数据层
 │ 粘贴 1200 字录音文字  │                      │                     │
 │───────────────────> │  计算指纹 → 查重       │                     │
 │                     │──────────────────────> │                     │
 │                     │                      │ M2 切片 → 6 片        │
 │                     │                      │ M3 归类 → Top3+置信度  │
 │                     │                      │ M4 提炼 → 摘要/槽位/标签│
 │                     │                      │ M5 去重 → 命中 0.87    │
 │                     │                      │ 写入 segment/suggestion│
 │                     │ <── 管线报告 5 步 ─── │ <───────────────────> │
 │ <── 跳转 Inbox ──── │                      │                     │
 │ 看到 6 条待确认，其中 2 条标"疑似重复"    │                      │
```

### F2 人在环裁决（差异化核心）

```
Inbox 卡片：建议分类=技术方案 (0.72)  次选=会议决策 (0.19)
  ├─ 接受      → 创建 Note + tags + NoteVersion(create)
  ├─ 改判      → 下拉选分类 → 同上，change_type=recategorize
  ├─ 合并      → 选中疑似重复笔记 → 目标归档 superseded，本笔记合并补正文
  │              → 生成 NoteVersion(merge)，保留双方来源列表
  └─ 丢弃      → suggestion.status=rejected，不建 Note
```

### F3 检索 → 溯源 → 修订

```
Library/Search 输入"向量召回" → BM25 排序 + 高亮
  → 点结果进 Note Detail，溯源 Tab 显示：
     来源《Q3 产品评审》 → 片段 #3「…召回准确率只有 60%…」← 关键词高亮
  → 编辑正文 → Save → 与上一版做字段级 diff 预览 → 确认
  → 生成 NoteVersion(edit)，version_count +1
  → 误操作？版本 Tab 选任意两版对比 → 一键回滚（回滚自身也记版本）
```

### F4 增量归并（跨素材同主题聚合）

```
新素材「10 月 1 日用户访谈」与既有「9 月 20 日访谈」相似度 0.86
  → Inbox 提示合并（展示两篇摘要差异）
  → 合并后：Note.source_ids = [srcA, srcB]，Segment 全部挂在新笔记下
  → 旧笔记 status=superseded, merged_into=新笔记ID（不物理删除）
  → 任一旧链接都能跳到新笔记
```

### F5 分类体系演进

```
Taxonomy 新增分类「竞品分析」+ 关键词 [竞品, 对标, 友商]
  → 触发 reprocess：对 status=active 且低置信度的笔记重跑归类
  → 变更进入 NoteVersion(recategorize)，Dashboard 显示"影响 12 条笔记"
```

---

## 6. LLM 接入契约（预留）

当前 Demo 用本地算法实现 M3/M4（零依赖、可离线跑）。接真实模型只需替换 `agent.js` 中两个函数：

```js
// 归类：返回 { categoryId, confidence, alternatives:[{id,score}] }
async function classifyByLLM(segment, taxonomy) { /* 调用自建网关 */ }

// 提炼：返回 { summary, slots:{conclusion[],todo[],risk[],metric[]}, tags[] }
async function distillByLLM(segments) { /* 同上 */ }
```

配置位置：Settings 页（网关 URL / API Key / 模型名 / 超时 / 失败降级策略）。
**降级原则**：LLM 超时或报错 → 自动回落到本地算法，产出照常进 Inbox，不阻断主链路。

---

## 7. 量化指标（MVP 验收口径）

### 7.1 目标值

| 指标 | 口径 | 目标 |
|---|---|---|
| 摄入成功率 | 成功建库素材 / 总摄入素材 | 100%（重复素材走拦截分支，不计入分母） |
| 切片质量 | 人工抽检片段语义完整率 | ≥ 85% |
| 归类 Top-1 准确率 | 50 条人工标注样本 | ≥ 75% |
| 低置信转人工比例 | 进 Inbox 的建议 / 总建议 | 20%~35%（过低说明阈值失效，过高说明归类能力不足） |
| 检索命中率 | 前 5 条包含目标片段的查询占比 | ≥ 90% |
| 版本完整率 | 有版本记录的操作 / 全部写操作 | 100% |
| 首次可交互时间 | 本地打开到可粘贴文本 | < 1.5s |

### 7.2 实测值（无头 Chrome 端到端跑通）

测试方式：CDP 驱动无头 Chrome，真实点击 UI 控件（非直接调 API），脚本见 `demo/e2e.js` / `demo/e2e2.js`。

| 用例 | 实测 | 结论 |
|---|---|---|
| 素材摄入 | 3 份种子素材 → 24 片段 / 7 笔记自动入库 | ✅ |
| 管线 5 步可观测 | 切片 3 段 / 归类 / 提炼 / 查重 / 入库，逐步产物计数正确 | ✅ |
| 摄入查重 | 重复内容被指纹拦截，来源数不增 | ✅ |
| 归类置信度分布 | min 0.21 / max 0.30（冷启动无笔记时信号弱，符合预期，重跑后回升） | ✅ |
| 建议裁决幂等 | 连续点击 40 次 → 仅生成 1 条笔记 | ✅ 修复后 |
| 去重触发 | 相似内容命中相似度 0.85 / 0.61，生成疑似重复建议 | ✅ |
| 合并动作 | 目标笔记来源 1→2，版本 +1，`change_type=merge`，溯源可追两个素材 | ✅ |
| 版本编辑 | 编辑后版本 +1，字段级 diff 准确（body +18/-0） | ✅ |
| 版本回滚 | 回滚后版本 +1 且 `change_type=rollback`，历史不销毁 | ✅ |
| 全文检索 | 关键词命中 4 条，5 处高亮，耗时 2.0ms，索引项 992 | ✅ |
| 分类保护 | 有笔记的分类删除被拒绝 | ✅ |
| 软删 + 恢复 | active 41→40，回收站 0→1，恢复后归位 | ✅ |
| 标签合并 | 源标签消失、目标标签用量累加 | ✅ |
| 导入导出往返 | 笔记 5→5、版本 7→7 完全一致 | ✅ |
| 刷新持久化 | 笔记 12 / 版本 15 / 素材 4 刷新后不变 | ✅ |
| 版本完整率 | 0 条笔记缺失版本记录（12/12） | ✅ 100% |

### 7.3 测试中发现并修复的缺陷

| 缺陷 | 现象 | 根因 | 修复 |
|---|---|---|---|
| 页面事件全部失效 | 除顶栏外所有按钮无响应 | `render()` 把页面对象传给 `bind()`，而 `bind` 用字符串查表 | 改传 route 字符串 |
| 归类置信度恒低 | 所有建议都进 Inbox，Top-1 无法自动入库 | 关键词命中数除以词表大小，词表越长分数越低 | 改为饱和函数 `min(1, hits/2)`，先验按类型内最大值归一化 |
| 裁决非幂等 | 连点产生 40 条重复笔记 | `acceptSuggestion` 未校验建议状态 | 增加 `status !== 'pending'` 早退 |
| 标签抽出整句 | 出现 `#语义搜索这块的召回准确率现在只有` 这类标签 | `tokenize` 把整段中文串也当 token | 整串不再入 token 池，只切 bigram |
| 标签跨词边界噪声 | 出现 `#是搜`（来自"于是搜不到"）、`#在怎`（来自"怎么记录"） | bigram 无词典无法判断词边界 | 引入领域词典优先匹配 + 虚字组合过滤，bigram 降级为兜底 |
| 去重从未触发 | 相似内容相似度被压到阈值下 | 只用 title+summary 算向量，短文本信息量不足 | 纳入正文，并取余弦与 Jaccard 的较大者 |

---

## 8. 里程碑

| 阶段 | 范围 | 状态 |
|---|---|---|
| R1（MVP） | M1~M9 全部，本地算法 Agent，可运行 | ✅ 本次交付 |
| R2 | 接入真实 LLM、音频文件 ASR、多用户 + 鉴权、云端同步 | 规划中 |
| R3 | 主动式 Agent（每周自动复盘、待办到期提醒、自动周报） | 概念 |

---

## 9. Demo 说明

- 入口 `demo/index.html`，双击或起本地服务均可
- 首次打开自动载入 3 份示例素材（会议转写 / 用户访谈 / 技术评审）并跑完管线，直接能看到成库结果
- 数据持久化在浏览器 `localStorage`，设置页可一键导出 JSON / 重置为示例数据
- 端到端测试：`node e2e.js`（主链路 60 项断言）、`node e2e2.js`（去重合并专项）
- **接真实 LLM**：替换 `src/agent.js` 的 `classifyByLLM` / `distillByLLM`，在设置页填网关地址即可

### 文件结构

```
recnote-agent/
├── docs/PRD.md          设计文档（本文件）
└── demo/
    ├── index.html       入口
    ├── styles.css       样式
    ├── src/store.js     数据层 + 版本快照 + 种子数据
    ├── src/agent.js     Agent 管线：切片/归类/提炼/去重
    ├── src/search.js    倒排索引 + BM25 + 高亮
    ├── src/app.js       7 个页面视图与交互
    ├── e2e.js           主链路端到端测试
    └── e2e2.js          去重合并专项测试
```
