// dsh-fish-memory 的装配层：一条动态提示词上下文 + 四个工具。
//
// 提示词里只出现「现在还记得的重的那几条」，这既是记忆，也是让人设自然的
// 遗忘：想不起来的事就不该编。

import path from 'node:path';
import { createStateStore, dshHome } from './state-store.mjs';
import {
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
} from './memory.mjs';

export const name = 'dsh-fish-memory';
export const inject = ['systemPrompt', 'tools'];

/** 提示词上下文名。 */
export const CONTEXT_NAME = 'plugin:fish-memory';
/** 工具名。 */
export const TOOL_NAMES = Object.freeze({
  memorize: 'fish_memorize',
  recall: 'fish_recall',
  forget: 'fish_forget',
  status: 'fish_status',
});

/**
 * 状态文件默认路径。
 * @param {ReturnType<typeof normalizeConfig>} config
 */
export function resolveStatePath(config) {
  return config.statePath ?? path.join(dshHome(), 'plugin-data', 'dsh-fish-memory', 'state.json');
}

/**
 * 创建记忆服务。
 * @param {ReturnType<typeof normalizeConfig>} config
 * @param {() => number} now
 */
export function createFishMemoryService(config, now = () => Date.now()) {
  const store = createStateStore({
    file: resolveStatePath(config),
    coerce: coerceState,
    initial: createEmptyState,
  });

  /** 读状态的统一入口：顺手把过期条目与超限条目清掉。 */
  function read() {
    const at = now();
    const state = store.load();
    const pruned = pruneEntries(state.entries ?? [], at, config);
    return { at, state: { version: 1, entries: pruned } };
  }

  return {
    file: store.file,
    config,
    now,
    current: () => read().state,
    memorize(input = {}) {
      const at = now();
      const { state } = read();
      const result = remember(state, input, at, config);
      if (result.entry) store.save(result.state);
      return { entry: result.entry, at, state: result.state };
    },
    recall(input = {}) {
      const at = now();
      const { state } = read();
      const rows = recall(state, input, at, config);
      if (rows.length > 0) store.save(withHits(state, rows.map((row) => row.entry.id)));
      return { rows, at };
    },
    forget(input = {}) {
      const at = now();
      const { state } = read();
      const result = forget(state, input);
      if (result.removed > 0) store.save(result.state);
      return { removed: result.removed, at };
    },
    status() {
      const { at, state } = read();
      return { at, state };
    },
    /** 提示词文本；抛异常会毁掉组装，自己兜住。 */
    text() {
      try {
        const { at, state } = read();
        return describe(state, at, config);
      } catch {
        return '';
      }
    },
    /** 调试/测试用：不带副作用的权重表。 */
    weights() {
      const { at, state } = read();
      return state.entries.map((entry) => ({
        id: entry.id,
        weight: effectiveWeight(entry, at, config),
        expired: isExpired(entry, at),
      }));
    },
  };
}

/**
 * @param {ReturnType<typeof createFishMemoryService>} service
 */
export function createMemorizeTool(service) {
  return {
    name: TOOL_NAMES.memorize,
    description:
      '把一条短信息记进「金鱼记忆」。会随时间衰减并过期，所以只记值得记的：用户偏好、正在做的事、约定好的下一步。不要记一大段原文，也不要记你自己编的东西。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要记的一句话（尽量短、可独立读懂）' },
        tags: { type: 'array', items: { type: 'string' }, description: '可选标签，便于以后检索，最多 8 个' },
        ttlMinutes: { type: 'number', description: '这条记忆保留多少分钟（默认 90）' },
        weight: { type: 'number', description: '初始权重 0.01~1，越重要越高（默认 0.6）' },
      },
      required: ['text'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args = {}) {
      const result = service.memorize({
        text: args.text,
        tags: args.tags,
        ttlMinutes: args.ttlMinutes,
        weight: args.weight,
      });
      if (!result.entry) return '没记住：text 是空的。';
      const entry = result.entry;
      return `记住了 [id=${entry.id}]（w${entry.weight.toFixed(2)}，TTL ${entry.ttlMinutes} 分钟）：${entry.text}`;
    },
  };
}

/**
 * @param {ReturnType<typeof createFishMemoryService>} service
 */
export function createRecallTool(service) {
  return {
    name: TOOL_NAMES.recall,
    description:
      '按关键词翻「金鱼记忆」。返回条目、当前权重、存在多久了以及 id（想删就用 id）。不传 query 就按权重返回最重的几条。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词，空格分隔；不传则按权重取前几条' },
        limit: { type: 'number', description: '最多返回几条（默认取配置的 promptLimit）' },
      },
      required: [],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args = {}) {
      const { rows, at } = service.recall({
        query: typeof args.query === 'string' ? args.query : '',
        limit: typeof args.limit === 'number' ? args.limit : undefined,
      });
      return formatRecall(rows, at);
    },
  };
}

/**
 * @param {ReturnType<typeof createFishMemoryService>} service
 */
export function createForgetTool(service) {
  return {
    name: TOOL_NAMES.forget,
    description: '忘掉一条（给 id）或者全部（all=true）。用户明确说「别记这个」时就该调用。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '要忘掉的条目 id（来自 fish_recall）' },
        all: { type: 'boolean', description: 'true 表示清空全部记忆' },
      },
      required: [],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args = {}) {
      const { removed } = service.forget({ id: args.id, all: args.all === true });
      if (removed === 0) return '没找到要忘的条目（id 可能已经过期了）。';
      return `忘了 ${removed} 条。`;
    },
  };
}

/**
 * @param {ReturnType<typeof createFishMemoryService>} service
 */
export function createStatusTool(service) {
  return {
    name: TOOL_NAMES.status,
    description: '看一眼记忆的整体情况：条数、最重的一条、最早的多久前、累计命中次数。',
    parameters: { type: 'object', properties: {}, required: [] },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute() {
      const { at, state } = service.status();
      return formatStatus(state, at, service.config);
    },
  };
}

/**
 * Cordis 装配钩子。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {unknown} rawConfig
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);
  if (!config.enabled) return;

  const service = createFishMemoryService(config);

  ctx.effect(
    () =>
      ctx.systemPrompt.context({
        name: CONTEXT_NAME,
        order: config.promptOrder,
        // 记忆正文是用户/模型写的，里面出现 {{...}} 很正常，必须关掉插值。
        interpolate: false,
        text: () => service.text(),
      }),
    'fish-memory.context()',
  );

  for (const factory of [createMemorizeTool, createRecallTool, createForgetTool, createStatusTool]) {
    const tool = factory(service);
    ctx.effect(() => ctx.tools.register(tool), `fish-memory.${tool.name}()`);
  }
}
