/**
 * dsh-qq-bridge · 记忆库（阶段 2，2026-10-17）
 *
 * 为什么要它：原先"值得记的事"只写进 `pending-notes.md` 的**待审区**，
 * 而待审区**不注入提示词** ⇒ 抽了没人读，模型永远只记得最近 20 轮。
 * 这里把"写入 → 衰减 → 召回 → 注入"整条链闭合，且**不额外调模型**（打分是纯数学）。
 *
 * 三层（照抄 generative_agents / Memory Bank 的思路，不是乱定的）：
 *   kind='core'    关系、约定、雷区、称呼   —— 永不衰减（每人 3~5 条就够，别滥）
 *   kind='event'   某天做过/说过什么        —— 半衰期 23 小时
 *   kind='chatter' 闲聊                     —— 半衰期 6 小时（默认不写，留着备用）
 *
 * 打分：`score = 0.5*recency + 3*relevance + 2*importance`（归一化后）
 *   —— 斯坦福那套的权重就是 [0.5, 3, 2]：**"相关"比"新"重要**。
 *   她现在"只记得最近"的病根就在只有 recency，没有 relevance。
 *
 * 复习增强：被召回一次 hits+1，有效半衰期 ×(1+hits) —— 像人一样，
 * 提过的事记得更久（Memory Bank 的 retention bump）。
 *
 * ⚠️ 这个模块**不读写 memory.json**（那是会话原文），只管长期记忆库。
 */

import fs from 'node:fs'

const HALFLIFE_H = { chatter: 6, event: 23, core: Infinity }
const MAX_ITEMS = 2000
const MAX_TEXT = 120

/** 去掉空白/标点/符号，只留"字"——判断两句是不是同一件事用 */
function norm(s) {
  const t = String(s || '')
  try { return t.replace(/[\s\p{P}\p{S}]/gu, '') } catch { return t.replace(/\s+/g, '') }
}

function bigrams(s) {
  const m = new Map()
  for (let i = 0; i < s.length - 1; i++) {
    const k = s.slice(i, i + 2)
    m.set(k, (m.get(k) || 0) + 1)
  }
  return m
}

/** Dice 系数（字符二元组）：中文短句不依赖分词，也没有 embedding 成本 */
export function sim(a, b) {
  const x = norm(a)
  const y = norm(b)
  if (!x || !y) return 0
  if (x === y) return 1
  if (x.length < 2 || y.length < 2) return 0
  const ma = bigrams(x)
  const mb = bigrams(y)
  let inter = 0
  let total = 0
  for (const [k, v] of ma) {
    total += v
    const w = mb.get(k) || 0
    if (w > 0) inter += Math.min(v, w)
  }
  for (const v of mb.values()) total += v
  return total > 0 ? (2 * inter) / total : 0
}

export function loadStore(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (j && Array.isArray(j.items)) return j
  } catch {}
  return { v: 1, items: [] }
}

/** 原子写（tmp + rename）。返回 '' 表示成功，否则返回错误串（调用方只拿去写日志） */
export function saveStore(file, store) {
  try {
    const tmp = file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(store), 'utf8')
    fs.renameSync(tmp, file)
    return ''
  } catch (e) {
    return String((e && e.message) || e)
  }
}

/**
 * 写一条记忆。重复的（同一人 + 同一句）只加强，不再堆一条。
 * @returns 新条目 | null（重复 / 空文本）
 */
export function addItem(store, o) {
  if (!store || !Array.isArray(store.items)) return null
  const text = String((o && o.text) || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT)
  if (!text) return null
  const qq = String((o && o.qq) || '')
  const group = String((o && o.group) || '')
  const kind = HALFLIFE_H[o && o.kind] !== undefined ? o.kind : 'event'
  const n = norm(text)
  const imp = Math.min(5, Math.max(1, Number(o && o.importance) || 3))
  const at = Number(o && o.at) || Date.now()

  for (const it of store.items) {
    if (it.qq !== qq || it.group !== group || norm(it.text) !== n) continue
    it.hits = (Number(it.hits) || 0) + 1
    it.lastHit = at
    it.importance = Math.max(Number(it.importance) || 3, imp)
    return null
  }

  const item = {
    id: String(at.toString(36)) + Math.random().toString(36).slice(2, 7),
    qq,
    group,
    kind,
    text,
    importance: imp,
    source: String((o && o.source) || 'auto'),
    created: at,
    lastHit: 0,
    hits: 0,
  }
  store.items.push(item)

  // 超量就先扔"非核心 + 不重要 + 最旧"的，核心条目永远留下
  if (store.items.length > MAX_ITEMS) {
    store.items.sort((a, b) =>
      (a.kind === 'core' ? 1 : 0) - (b.kind === 'core' ? 1 : 0) ||
      (Number(a.importance) || 3) - (Number(b.importance) || 3) ||
      (Number(a.created) || 0) - (Number(b.created) || 0))
    store.items = store.items.slice(store.items.length - MAX_ITEMS)
  }
  return item
}

/** 时间衰减（复习增强：hits 越多，有效半衰期越长） */
function recencyOf(it, now) {
  const hl = HALFLIFE_H[it.kind]
  if (!isFinite(hl)) return 1
  const ref = Math.max(Number(it.created) || 0, Number(it.lastHit) || 0)
  const hours = Math.max(0, (now - ref) / 3600000)
  const strength = Math.max(0, Math.min(5, Number(it.hits) || 0))
  return Math.pow(0.5, hours / (hl * (1 + strength)))
}

/**
 * 关键词命中率（BM25 的极简版，对应 mem0 的 "keyword 路"）：
 * 查询里有多大比例的字二元组能在记忆里找到。
 * 和 Dice 的区别：Dice 会被记忆长短稀释，这个只看"查询的词命中多少"，短记忆不吃亏。
 */
function bigramOverlap(q, text) {
  const a = norm(q)
  const b = norm(text)
  if (a.length < 2 || b.length < 2) return 0
  const set = new Set()
  for (let i = 0; i < b.length - 1; i++) set.add(b.slice(i, i + 2))
  let hit = 0
  let total = 0
  for (let i = 0; i < a.length - 1; i++) {
    total++
    if (set.has(a.slice(i, i + 2))) hit++
  }
  return total > 0 ? hit / total : 0
}

/**
 * 召回：只在"同一个人"或"同一个群"的记忆里找。
 * 跨群不召回是有意的 —— 群里说过的事，另一个群不该知道（真实社交就是这样）。
 */
export function recall(store, o) {
  const opts = o || {}
  const now = Number(opts.now) || Date.now()
  const qq = String(opts.qq || '')
  const group = String(opts.group || '')
  const q = String(opts.text || '')
  const limit = Math.max(1, Math.min(10, Number(opts.limit) || 2))
  const minScore = Number.isFinite(Number(opts.minScore)) ? Number(opts.minScore) : 0.15
  // kinds：只在这些层里找。"话题勾连"要用它排除 chatter —— 否则每条新消息都会命中
  // 自己刚写进去的 chatter，变成每次都触发判断（2026-10-17 实测 score 1.14 就是这个）。
  const kinds = Array.isArray(opts.kinds) && opts.kinds.length > 0
    ? new Set(opts.kinds.map((x) => String(x)))
    : null
  if (!store || !Array.isArray(store.items) || store.items.length === 0) return []

  const out = []
  for (const it of store.items) {
    const sameQQ = !!qq && it.qq === qq
    const sameGroup = !!group && it.group === group
    if (!sameQQ && !sameGroup) continue
    if (kinds && !kinds.has(String(it.kind))) continue
    const rec = recencyOf(it, now)
    const rel = q ? sim(q, it.text) : 0
    // ★ ③ 多路检索（搬 mem0）：语义(Dice) + 关键词命中(BM25-lite) + 实体加成
    const kw = q ? bigramOverlap(q, it.text) : 0
    const imp = (Number(it.importance) || 3) / 5
    let score = (0.5 * rec + 3 * rel + 2 * imp) / 5.5
    score += 0.35 * kw           // 关键词路：查询里的词真在记忆里出现过
    if (sameQQ) score += 0.08    // 实体路：关于"当前这个人"的记忆优先
    if (sameQQ && it.kind === 'core') score += 0.05
    if (score < minScore) continue
    out.push({ item: it, score })
  }
  out.sort((a, b) => b.score - a.score)

  // ★ ③ 多样性：最多 1 条 chatter，且不选和已选条目几乎重复的
  const picked = []
  let chatterUsed = 0
  for (const h of out) {
    if (h.item.kind === 'chatter' && chatterUsed >= 1) continue
    if (picked.some((p) => sim(p.item.text, h.item.text) >= 0.85)) continue
    picked.push(h)
    if (h.item.kind === 'chatter') chatterUsed++
    if (picked.length >= limit) break
  }
  return picked
}

/** 命中就+1（复习增强）。返回改动条数，调用方据此决定要不要落盘 */
export function bump(hits, now) {
  let n = 0
  for (const h of hits || []) {
    const it = h && h.item ? h.item : h
    if (!it) continue
    it.hits = (Number(it.hits) || 0) + 1
    it.lastHit = Number(now) || Date.now()
    n++
  }
  return n
}

/** 渲染成注入块。刻意写"不一定准"——允许她记不清，比让她背档案更像人 */
export function renderRecall(hits) {
  if (!Array.isArray(hits) || hits.length === 0) return ''
  const pad = (n) => (n < 10 ? '0' : '') + String(n)
  const lines = hits.map((h) => {
    const it = h.item || h
    const d = new Date(Number(it.created) || 0)
    const day = Number.isFinite(d.getTime()) ? pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' : ''
    return '· ' + day + String(it.text || '')
  })
  return '【你记得的事】（模糊印象，不一定全对；别复述，也别提"我记过"这种东西）\n' + lines.join('\n')
}

/**
 * 一次性解析旧待审区 `pending-notes.md`，把里面已经抽好的条目灌进记忆库。
 * 只用于**空库首次启动**（那 30 条已经积压在那儿、模型从来读不到）。
 */
export function parsePending(text) {
  const out = []
  let curQQ = ''
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim()
    const head = /^##\s*(\d{5,12})\s*$/.exec(line)
    if (head) { curQQ = head[1]; continue }
    const m = /^-\s*\[(\d{4}-\d{2}-\d{2})[^\]]*\]\s*(?:\(([^)]*)\))?\s*(.+)$/.exec(line)
    if (!m || !curQQ) continue
    const t = new Date(m[1] + 'T12:00:00')
    out.push({ qq: curQQ, text: m[3], at: Number.isFinite(t.getTime()) ? t.getTime() : Date.now(), source: m[2] || 'pending' })
  }
  return out
}
