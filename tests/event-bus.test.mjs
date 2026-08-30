import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEventBus, EventBusError } from '../runtime/event-bus.mjs';

test('事件总线按序发布并支持游标读取与上限淘汰', () => {
  const bus = createEventBus({ limit: 2, clock: () => new Date('2026-01-01T00:00:00.000Z') });
  bus.publish({ type: 'one' }); bus.publish({ type: 'two' }); bus.publish({ type: 'three' });
  const page = bus.list({ after: 1, limit: 2 });
  assert.deepEqual(page.events.map((event) => event.type), ['two', 'three']);
  assert.equal(page.nextAfter, 3);
  assert.equal(page.latestSequence, 3);
});

test('事件总线拒绝非法事件和游标', () => {
  const bus = createEventBus();
  assert.throws(() => bus.publish({ type: '' }), EventBusError);
  assert.throws(() => bus.list({ after: -1 }), EventBusError);
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
