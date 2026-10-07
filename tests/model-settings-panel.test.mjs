import test from 'node:test';
import assert from 'node:assert/strict';
import { controlPanelHtml } from '../runtime/control-panel.mjs';

test('控制台包含首次模型配置工作流而不渲染 API key 明文', () => {
  const html = controlPanelHtml('ABCDEFGHIJKLMNOPQRSTUVWX');
  assert.match(html, /id="modelSettings"/);
  assert.match(html, /id="modelProvider"/);
  assert.match(html, /id="modelEndpoint"/);
  assert.match(html, /id="modelName"/);
  assert.match(html, /id="modelApiKey"/);
  assert.match(html, /id="saveModel"/);
  assert.match(html, /id="testModel"/);
  assert.match(html, /id="modelProfiles"/);
  assert.match(html, /keychain:/);
  assert.match(html, /secretRef/);
  assert.match(html, /modelId/);
  assert.match(html, /\/v1\/secrets/);
  assert.match(html, /\/v1\/models\//);
  assert.match(html, /\/v1\/models/);
  assert.match(html, /\/health/);
  assert.doesNotMatch(html, /sk-[A-Za-z0-9]{12,}/);
});
