import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CONFIG,
  coerceState,
  createEmptyState,
  describe,
  effectiveWeight,
  forget,
  formatRecall,
  formatStatus,
  isExpired,
  normalizeConfig,
  pruneEntries,
  recall,
  remember,
  withHits,
} from '../lib/memory.mjs';

const config = normalizeConfig({});
const NOW = new Date(2026, 0, 1, 12, 0, 0).getTime();
const MINUTE = 60_000;

function rememberOne(text, overrides = {}) {
  return remember(createEmptyState(), { text, ...overrides }, NOW, config);
}

test('记一条：有 id、标签被归一、默认权重 0.6', () => {
  const { entry, state } = rememberOne('用户周末要去钓鱼', { tags: [' 钓鱼 ', 'FISH', '钓鱼', 42] });
  assert.ok(entry);
  assert.equal(entry.id.length, 8);
  assert.deepEqual(entry.tags, ['钓鱼', 'fish']);
  assert.equal(entry.weight, 0.6);
  assert.equal(entry.ttlMinutes, DEFAULT_CONFIG.defaultTtlMinutes);
  assert.equal(state.entries.length, 1);
});

test('空文本不记', () => {
  const { entry, state } = remember(createEmptyState(), { text: '   ' }, NOW, config);
  assert.equal(entry, null);
  assert.equal(state.entries.length, 0);
});

test('权重按半衰期减半，TTL 到点归零', () => {
  const { entry } = rememberOne('部署脚本在 D 盘', { weight: 1, ttlMinutes: 60 });
  const half = effectiveWeight(entry, NOW + config.halfLifeMinutes * MINUTE, config);
  assert.ok(Math.abs(half - 0.5) < 0.001, String(half));
  const later = effectiveWeight(entry, NOW + 59 * MINUTE, config);
  assert.ok(later > 0 && later < 0.3);
  const expired = effectiveWeight(entry, NOW + 61 * MINUTE, config);
  assert.equal(expired, 0);
  assert.equal(isExpired(entry, NOW + 61 * MINUTE), true);
});

test('超过上限时留下最重的', () => {
  const small = normalizeConfig({ maxEntries: 2 });
  const state = {
    version: 1,
    entries: [
      { id: 'a', text: '轻', tags: [], weight: 0.2, createdAt: NOW, ttlMinutes: 60, hits: 0 },
      { id: 'b', text: '重', tags: [], weight: 0.9, createdAt: NOW, ttlMinutes: 60, hits: 0 },
      { id: 'c', text: '中', tags: [], weight: 0.5, createdAt: NOW, ttlMinutes: 60, hits: 0 },
      { id: 'd', text: '过期', tags: [], weight: 1, createdAt: NOW - 120 * MINUTE, ttlMinutes: 60, hits: 0 },
    ],
  };
  const kept = pruneEntries(state.entries, NOW, small).map((entry) => entry.id);
  assert.deepEqual(kept.sort(), ['b', 'c']);
});

test('检索：关键词命中更多分更高，空查询按权重', () => {
  const state = createEmptyState();
  const first = remember(state, { text: '部署脚本在 D 盘', tags: ['部署'], weight: 0.5 }, NOW, config).state;
  const second = remember(first, { text: '周末去钓鱼', tags: ['安排'], weight: 0.9 }, NOW, config).state;

  const hits = recall(second, { query: '部署 脚本' }, NOW, config);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].entry.tags[0], '部署');
  assert.ok(hits[0].matches >= 2);

  const top = recall(second, {}, NOW, config);
  assert.equal(top[0].entry.text, '周末去钓鱼');
  assert.equal(recall(second, { query: '不存在的词' }, NOW, config).length, 0);
});

test('withHits 累加命中次数，forget 能单删与清空', () => {
  const one = remember(createEmptyState(), { text: 'x' }, NOW, config).state;
  const hit = withHits(one, [one.entries[0].id]);
  assert.equal(hit.entries[0].hits, 1);

  const byId = forget(hit, { id: hit.entries[0].id });
  assert.equal(byId.removed, 1);
  assert.equal(byId.state.entries.length, 0);
  assert.equal(forget(hit, { all: true }).removed, 1);
  assert.equal(forget(hit, { id: 'nope' }).removed, 0);
});

test('提示词：只列还活着的、按权重排序、空记忆返回空串', () => {
  assert.equal(describe(createEmptyState(), NOW, config), '');

  const state = remember(
    remember(createEmptyState(), { text: '旧事', weight: 0.2, ttlMinutes: 120 }, NOW - 60 * MINUTE, config).state,
    { text: '新事', weight: 0.9 },
    NOW,
    config,
  ).state;
  const text = describe(state, NOW, config);
  assert.match(text, /fish-memory/);
  assert.match(text, /新事/);
  assert.ok(text.indexOf('新事') < text.indexOf('旧事'));

  const tiny = normalizeConfig({ promptMaxChars: 200 });
  assert.ok(describe(state, NOW, tiny).length <= 200);
  assert.equal(describe(state, NOW, normalizeConfig({ promptLimit: 0 })), '');
});

test('工具输出格式：检索与状态', () => {
  const one = remember(createEmptyState(), { text: '用户叫飞鱼', tags: ['人设'] }, NOW, config);
  const rows = recall(one.state, { query: '飞鱼' }, NOW, config);
  const recalled = formatRecall(rows, NOW);
  assert.match(recalled, /共 1 条/);
  assert.match(recalled, /id=/);
  assert.match(formatRecall([], NOW), /没有对得上/);
  assert.match(formatStatus(one.state, NOW, config), /记忆 1 条/);
  assert.match(formatStatus(createEmptyState(), NOW, config), /空的/);
});

test('脏数据被洗掉，配置写坏有兜底', () => {
  const state = coerceState({ entries: [{ text: 'ok', weight: 99, tags: 'x' }, { nope: 1 }, null] });
  assert.equal(state.entries.length, 1);
  assert.equal(state.entries[0].weight, 1);
  assert.deepEqual(state.entries[0].tags, []);
  assert.deepEqual(coerceState({ entries: 'nope' }).entries, []);

  const weird = normalizeConfig({ maxEntries: 0, halfLifeMinutes: -1, promptLimit: 'x' });
  assert.equal(weird.maxEntries, 1);
  assert.equal(weird.halfLifeMinutes, 1);
  assert.equal(weird.promptLimit, DEFAULT_CONFIG.promptLimit);
  assert.equal(normalizeConfig({ enabled: false }).enabled, false);
});
