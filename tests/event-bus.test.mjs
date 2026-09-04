import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEventBus, EventBusError } from '../runtime/event-bus.mjs';
import { symlinkOrSkip } from './test-support.mjs';

test('事件总线按序发布并支持游标读取与上限淘汰', () => {
  const bus = createEventBus({ limit: 2, clock: () => new Date('2026-01-01T00:00:00.000Z') });
  bus.publish({ type: 'one' }); bus.publish({ type: 'two' }); bus.publish({ type: 'three' });
  const page = bus.list({ after: 1, limit: 2 });
  assert.deepEqual(page.events.map((event) => event.type), ['two', 'three']);
  assert.equal(page.nextAfter, 3);
  assert.equal(page.latestSequence, 3);
  assert.equal(page.earliestSequence, 2);
  assert.equal(page.cursorExpired, false);
  assert.equal(bus.list({ after: 0, limit: 2 }).cursorExpired, false);
});

test('事件总线明确标记已超出保留窗口的游标', () => {
  const bus = createEventBus({ limit: 2 });
  bus.publish({ type: 'one' }); bus.publish({ type: 'two' }); bus.publish({ type: 'three' });
  const expired = bus.list({ after: 1, limit: 2 });
  assert.equal(expired.cursorExpired, false);
  bus.publish({ type: 'four' });
  assert.equal(bus.list({ after: 1, limit: 2 }).cursorExpired, true);
});

test('从游标订阅原子衔接历史页与后续实时事件', () => {
  const bus = createEventBus({ limit: 4 });
  bus.publish({ type: 'one' });
  const live = [];
  const stream = bus.subscribeFrom((event) => live.push(event.type), { after: 0, limit: 4 });
  bus.publish({ type: 'two' });
  assert.deepEqual(stream.page.events.map((event) => event.type), ['one']);
  assert.deepEqual(live, ['two']);
  stream.unsubscribe();
  bus.publish({ type: 'three' });
  assert.deepEqual(live, ['two']);
});

test('事件总线拒绝非法事件和游标', () => {
  const bus = createEventBus();
  assert.throws(() => bus.publish({ type: '' }), EventBusError);
  assert.throws(() => bus.list({ after: -1 }), EventBusError);
});

test('事件数据会深复制冻结，拒绝不可序列化或超限内容', () => {
  const bus = createEventBus();
  const data = { nested: { state: 'original' } };
  const event = bus.publish({ type: 'safe', data });
  data.nested.state = 'mutated';
  assert.equal(event.data.nested.state, 'original');
  assert.equal(Object.isFrozen(event.data.nested), true);
  assert.throws(() => bus.publish({ type: 'bad', data: { cycle: (() => { const value = {}; value.self = value; return value; })() } }), { code: 'INVALID_EVENT_DATA' });
  assert.throws(() => bus.publish({ type: 'large', data: { value: 'x'.repeat(64 * 1024) } }), { code: 'EVENT_DATA_LIMIT' });
});

test('事件总线重启后保留顺序并将历史明确标记为 recovered', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ocw-events-'));
  try {
    const first = createEventBus({ root });
    first.publish({ type: 'session.created', sessionId: 's' });
    const second = createEventBus({ root });
    const page = second.list();
    assert.equal(second.recovered, true);
    assert.equal(page.events[0].sequence, 1);
    assert.equal(page.events[0].recovered, true);
    assert.equal(page.recovered, true);
    const live = second.publish({ type: 'chat.completed', sessionId: 's' });
    assert.equal(live.sequence, 2);
    assert.equal(live.recovered, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('事件总线拒绝损坏快照而不是伪造新事件流', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ocw-events-invalid-'));
  try {
    const store = join(root, '.openclaw-workbench', 'events.json');
    await mkdir(join(root, '.openclaw-workbench'));
    await writeFile(store, '{bad');
    assert.throws(() => createEventBus({ root }), (error) => error instanceof EventBusError && error.code === 'EVENT_STORE_INVALID');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('拒绝重复事件 ID 和缺少事件 ID 的快照', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ocw-events-invalid-shape-'));
  try {
    const store = join(root, '.openclaw-workbench', 'events.json');
    await mkdir(join(root, '.openclaw-workbench'));
    await writeFile(store, JSON.stringify({ version: 1, sequence: 2, events: [
      { id: 'same', sequence: 1, type: 'one', data: {} },
      { id: 'same', sequence: 2, type: 'two', data: {} },
    ] }));
    assert.throws(() => createEventBus({ root }), (error) => error instanceof EventBusError && error.code === 'EVENT_STORE_INVALID');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('拒绝指向工作区外的事件快照符号链接', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ocw-events-symlink-'));
  const outside = await mkdtemp(join(tmpdir(), 'ocw-events-outside-'));
  try {
    await mkdir(join(root, '.openclaw-workbench'));
    const target = join(outside, 'events.json');
    await writeFile(target, JSON.stringify({ version: 1, sequence: 0, events: [] }));
    if (!await symlinkOrSkip(t, target, join(root, '.openclaw-workbench', 'events.json'))) return;
    assert.throws(() => createEventBus({ root }), { code: 'EVENT_STORE_INVALID' });
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test('事件快照写入遇到已有锁时保守拒绝，不覆盖现有状态', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ocw-events-lock-'));
  try {
    const bus = createEventBus({ root });
    await mkdir(`${bus.snapshotPath}.lock`, { recursive: true });
    assert.throws(() => bus.publish({ type: 'blocked' }), { code: 'EVENT_STORE_BUSY' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('两个事件总线基于不同快照版本写入时拒绝后写者覆盖', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ocw-events-conflict-'));
  try {
    const first = createEventBus({ root });
    const stale = createEventBus({ root });
    first.publish({ type: 'first' });
    assert.throws(() => stale.publish({ type: 'stale' }), { code: 'EVENT_STORE_CONFLICT' });
    assert.equal(stale.list().latestSequence, 0);
    assert.deepEqual(createEventBus({ root }).list().events.map((event) => event.type), ['first']);
  } finally { await rm(root, { recursive: true, force: true }); }
});
