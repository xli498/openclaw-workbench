import test from 'node:test';
import assert from 'node:assert/strict';
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
