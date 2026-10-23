import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-fish-test-'));
process.env.DSH_HOME = home;

const { apply, CONTEXT_NAME, TOOL_NAMES } = await import('../lib/index.js');
const { assertRegistryReadyTool, fakeContext } = await import('./helpers.mjs');

function toolOf(registered, name) {
  const tool = registered.tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `missing tool ${name}`);
  return tool;
}

test('apply 注册一条上下文和四个工具', () => {
  const { ctx, registered } = fakeContext();
  apply(ctx, {});

  assert.equal(registered.contexts.length, 1);
  assert.equal(registered.contexts[0].name, CONTEXT_NAME);
  assert.equal(registered.contexts[0].interpolate, false);

  const names = registered.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, Object.values(TOOL_NAMES).sort());
  for (const tool of registered.tools) assertRegistryReadyTool(tool, assert);
});

test('enabled=false 不注册', () => {
  const { ctx, registered } = fakeContext();
  apply(ctx, { enabled: false });
  assert.equal(registered.tools.length, 0);
  assert.equal(registered.contexts.length, 0);
});

test('记 → 读 → 忘记，整条链路自洽', async () => {
  const { ctx, registered } = fakeContext();
  apply(ctx, { statePath: path.join(home, 'memory.json') });

  const memorize = toolOf(registered, TOOL_NAMES.memorize);
  const recallTool = toolOf(registered, TOOL_NAMES.recall);
  const forgetTool = toolOf(registered, TOOL_NAMES.forget);
  const status = toolOf(registered, TOOL_NAMES.status);

  const remembered = await memorize.execute({ text: '用户周末要去钓鱼', tags: ['安排'], weight: 0.8 });
  assert.match(remembered, /记住了/);
  const id = /id=([a-z0-9]+)/.exec(remembered)?.[1];
  assert.ok(id);

  const found = await recallTool.execute({ query: '钓鱼' });
  assert.match(found, /周末要去钓鱼/);
  assert.match(found, new RegExp(id));

  const contextText = registered.contexts[0].text();
  assert.match(contextText, /fish-memory/);
  assert.match(contextText, /钓鱼/);

  const stats = await status.execute({});
  assert.match(stats, /记忆 1 条/);

  const removed = await forgetTool.execute({ id });
  assert.match(removed, /忘了 1 条/);
  assert.equal(registered.contexts[0].text(), '');
});

test('空 text 给出明确失败，而不是静默', async () => {
  const { ctx, registered } = fakeContext();
  apply(ctx, {});
  const memorize = toolOf(registered, TOOL_NAMES.memorize);
  assert.match(await memorize.execute({ text: '' }), /text 是空的/);
});

test('清空全部 + 状态文件损坏时退回空记忆', async () => {
  const { ctx, registered } = fakeContext();
  apply(ctx, { statePath: path.join(home, 'bulk.json') });
  const memorize = toolOf(registered, TOOL_NAMES.memorize);
  const forgetTool = toolOf(registered, TOOL_NAMES.forget);
  await memorize.execute({ text: 'a' });
  await memorize.execute({ text: 'b' });
  assert.match(await forgetTool.execute({ all: true }), /忘了 2 条/);

  fs.writeFileSync(path.join(home, 'broken.json'), '{{{', 'utf8');
  const broken = fakeContext();
  apply(broken.ctx, { statePath: path.join(home, 'broken.json') });
  assert.equal(broken.registered.contexts[0].text(), '');
  assert.match(await broken.registered.tools[0].execute({ text: '还活着' }), /记住了/);
});
