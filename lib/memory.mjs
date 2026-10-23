// 金鱼记忆：纯函数、零依赖。
//
// 规则只有三条：
//   1. 每条记忆有初始权重，权重按半衰期指数衰减；
//   2. 超过 TTL 直接算忘了（权重归零、检索不返回）；
//   3. 数量有上限，塞满了先淘汰最轻的。
// 刻意不做向量、不做摘要：这是一个「短时便签」，不是知识库。

import { randomUUID } from 'node:crypto';

/** 配置默认值。 */
export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  halfLifeMinutes: 25,
  defaultTtlMinutes: 90,
  maxEntries: 200,
  promptLimit: 5,
  promptOrder: 9070,
  promptMaxChars: 900,
  statePath: null,
});

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const round = (value) => Math.round(value * 1000) / 1000;
const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);

/** 把 config 归一。 */
export function normalizeConfig(raw = {}) {
  const config = { ...DEFAULT_CONFIG, ...(raw && typeof raw === 'object' ? raw : {}) };
  return {
    enabled: config.enabled !== false,
    halfLifeMinutes: Math.max(1, Number(config.halfLifeMinutes) || DEFAULT_CONFIG.halfLifeMinutes),
    defaultTtlMinutes: Math.max(1, Number(config.defaultTtlMinutes) || DEFAULT_CONFIG.defaultTtlMinutes),
    maxEntries: Number.isFinite(Number(config.maxEntries))
      ? Math.max(1, Math.trunc(Number(config.maxEntries)))
      : DEFAULT_CONFIG.maxEntries,
    promptLimit: Number.isFinite(Number(config.promptLimit))
      ? Math.max(0, Math.trunc(Number(config.promptLimit)))
      : DEFAULT_CONFIG.promptLimit,
    promptOrder: isNumber(config.promptOrder) ? config.promptOrder : DEFAULT_CONFIG.promptOrder,
    promptMaxChars: Math.max(200, Number(config.promptMaxChars) || DEFAULT_CONFIG.promptMaxChars),
    statePath: typeof config.statePath === 'string' && config.statePath ? config.statePath : null,
  };
}

/** 空记忆。 */
export function createEmptyState() {
  return { version: 1, entries: [] };
}

/** 洗落盘数据：坏条目直接丢。 */
export function coerceState(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.entries)) return createEmptyState();
  const entries = raw.entries
    .filter((entry) => entry && typeof entry === 'object' && typeof entry.text === 'string' && entry.text.trim())
    .map((entry) => ({
      id: typeof entry.id === 'string' && entry.id ? entry.id : randomUUID().slice(0, 8),
      text: entry.text.slice(0, 2000),
      tags: Array.isArray(entry.tags) ? entry.tags.filter((tag) => typeof tag === 'string').slice(0, 8) : [],
      weight: isNumber(entry.weight) ? clamp(entry.weight, 0.01, 1) : 0.6,
      createdAt: isNumber(entry.createdAt) ? entry.createdAt : Date.now(),
      ttlMinutes: isNumber(entry.ttlMinutes) ? Math.max(1, entry.ttlMinutes) : DEFAULT_CONFIG.defaultTtlMinutes,
      hits: isNumber(entry.hits) ? Math.max(0, Math.trunc(entry.hits)) : 0,
    }));
  return { version: 1, entries };
}

/** 整理标签：去空、去重、小写、限长。 */
export function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  const seen = new Set();
  const result = [];
  for (const tag of tags) {
    if (typeof tag !== 'string') continue;
    const value = tag.trim().toLowerCase().slice(0, 32);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
    if (result.length >= 8) break;
  }
  return result;
}

/** 一条记忆是否过期。 */
export function isExpired(entry, now) {
  return now - entry.createdAt >= entry.ttlMinutes * 60_000;
}

/** 当前权重：初始权重按半衰期衰减，过期归零。 */
export function effectiveWeight(entry, now, config) {
  if (isExpired(entry, now)) return 0;
  const age = Math.max(0, now - entry.createdAt);
  const factor = Math.pow(0.5, age / (config.halfLifeMinutes * 60_000));
  return round(entry.weight * factor);
}

/** 记一条；返回新状态与条目。 */
export function remember(state, input, now, config) {
  const text = typeof input?.text === 'string' ? input.text.trim().slice(0, 2000) : '';
  if (!text) return { state, entry: null };
  const entry = {
    id: randomUUID().slice(0, 8),
    text,
    tags: normalizeTags(input?.tags),
    weight: isNumber(input?.weight) ? clamp(input.weight, 0.01, 1) : 0.6,
    createdAt: now,
    ttlMinutes: isNumber(input?.ttlMinutes) ? clamp(input.ttlMinutes, 1, 10_080) : config.defaultTtlMinutes,
    hits: 0,
  };
  const entries = pruneEntries([...(state.entries ?? []), entry], now, config);
  return { state: { version: 1, entries }, entry };
}

/** 淘汰过期条目，超过上限时先压掉最轻的。 */
export function pruneEntries(entries, now, config) {
  const alive = entries.filter((entry) => !isExpired(entry, now));
  const scored = alive
    .map((entry) => ({ entry, weight: effectiveWeight(entry, now, config) }))
    .sort((left, right) => right.weight - left.weight)
    .slice(0, config.maxEntries)
    .map((row) => row.entry);
  return scored;
}

/** 检索：命中文本/标签越多分越高，最终仍以权重为主。 */
export function recall(state, input, now, config) {
  const query = typeof input?.query === 'string' ? input.query.trim().toLowerCase() : '';
  const limit = Math.max(1, isNumber(input?.limit) ? Math.trunc(input.limit) : config.promptLimit || 5);
  const tokens = query.split(/[\s,，。.!！?？;；:：、]+/).filter(Boolean);
  const scored = (state.entries ?? [])
    .filter((entry) => !isExpired(entry, now))
    .map((entry) => {
      const weight = effectiveWeight(entry, now, config);
      const haystack = `${entry.text} ${entry.tags.join(' ')}`.toLowerCase();
      const matches = tokens.filter((token) => haystack.includes(token)).length;
      const score = tokens.length === 0 ? weight : matches > 0 ? weight * (1 + 0.6 * Math.min(matches, 3)) : 0;
      return { entry, weight, matches, score: round(score) };
    })
    .filter((row) => row.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
  return scored;
}

/** 给检索结果记一次命中（调用方负责落盘）。 */
export function withHits(state, ids) {
  const idSet = new Set(ids);
  return {
    ...state,
    entries: (state.entries ?? []).map((entry) => (idSet.has(entry.id) ? { ...entry, hits: entry.hits + 1 } : entry)),
  };
}

/** 忘掉指定 id 或全部。 */
export function forget(state, input) {
  const entries = state.entries ?? [];
  if (input?.all === true) return { state: createEmptyState(), removed: entries.length };
  const id = typeof input?.id === 'string' ? input.id.trim() : '';
  if (!id) return { state, removed: 0 };
  const kept = entries.filter((entry) => entry.id !== id);
  return { state: { version: 1, entries: kept }, removed: entries.length - kept.length };
}

/** 进系统提示词的文本；没有记忆时返回空串（空段会被组装丢弃）。 */
export function describe(state, now, config) {
  if (config.promptLimit === 0) return '';
  const ranked = (state.entries ?? [])
    .filter((entry) => !isExpired(entry, now))
    .map((entry) => ({ entry, weight: effectiveWeight(entry, now, config) }))
    .filter((row) => row.weight > 0)
    .sort((left, right) => right.weight - left.weight)
    .slice(0, config.promptLimit);
  if (ranked.length === 0) return '';

  const lines = ['[fish-memory] 金鱼记忆：下面这些是你还「记得」的，越往下越淡，没列出来的就是真的忘了。'];
  for (const { entry, weight } of ranked) {
    const minutes = Math.max(0, Math.round((now - entry.createdAt) / 60_000));
    const tags = entry.tags.length > 0 ? ` #${entry.tags.join(' #')}` : '';
    lines.push(`- ${minutes} 分钟前 · w${weight.toFixed(2)} · ${entry.text}${tags}`);
  }
  lines.push('引用它们要自然；不要声称记得没写在这里的事，也不要解释这套机制。');
  const text = lines.join('\n');
  return text.length > config.promptMaxChars ? `${text.slice(0, config.promptMaxChars - 1)}…` : text;
}

/** 工具输出：检索结果。 */
export function formatRecall(rows, now) {
  if (rows.length === 0) return '记忆里没有对得上的东西（金鱼嘛）。';
  const lines = rows.map(({ entry, weight, matches }, index) => {
    const minutes = Math.max(0, Math.round((now - entry.createdAt) / 60_000));
    const tags = entry.tags.length > 0 ? ` #${entry.tags.join(' #')}` : '';
    const hit = matches > 0 ? `，命中 ${matches}` : '';
    return `${index + 1}. [id=${entry.id}] (w${weight.toFixed(2)}，${minutes} 分钟前${hit}) ${entry.text}${tags}`;
  });
  return [`共 ${rows.length} 条：`, ...lines].join('\n');
}

/** 工具输出：整体状态。 */
export function formatStatus(state, now, config) {
  const entries = state.entries ?? [];
  const alive = entries.filter((entry) => !isExpired(entry, now));
  if (entries.length === 0) return '记忆是空的。用 fish_memorize 记点东西。';
  const weights = alive.map((entry) => effectiveWeight(entry, now, config));
  const heaviest = weights.length > 0 ? Math.max(...weights) : 0;
  const oldest = alive.length > 0 ? Math.max(0, Math.round((now - Math.min(...alive.map((entry) => entry.createdAt))) / 60_000)) : 0;
  const totalHits = entries.reduce((sum, entry) => sum + entry.hits, 0);
  return [
    `记忆 ${entries.length} 条（存活 ${alive.length}，上限 ${config.maxEntries}）`,
    `最重一条 w${heaviest.toFixed(2)} · 最早 ${oldest} 分钟前 · 累计命中 ${totalHits} 次`,
    `半衰期 ${config.halfLifeMinutes} 分钟 · 默认 TTL ${config.defaultTtlMinutes} 分钟`,
  ].join('\n');
}
