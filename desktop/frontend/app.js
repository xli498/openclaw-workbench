const STORAGE_KEYS = Object.freeze({
  projectPath: 'openclaw.workbench.projectPath',
  runtimeAddress: 'openclaw.workbench.runtimeAddress'
});

const projectInput = document.querySelector('#project-path');
const projectState = document.querySelector('#workspace-state');
const runtimeState = document.querySelector('#runtime-state');
const projectFeedback = document.querySelector('#project-feedback');
const addressInput = document.querySelector('#runtime-address');
const connectionState = document.querySelector('#connection-state');
const addressFeedback = document.querySelector('#address-feedback');
const consoleLink = document.querySelector('#console-link');
const runtimeCopy = document.querySelector('#runtime-copy');
const runtimeDot = document.querySelector('#runtime-dot');
const startRuntime = document.querySelector('#start-runtime');
const stopRuntime = document.querySelector('#stop-runtime');
const browseWorkspace = document.querySelector('#browse-workspace');
const modelSettingsForm = document.querySelector('#model-settings-form');
const modelIdInput = document.querySelector('#model-id');
const modelProviderInput = document.querySelector('#model-provider');
const modelEndpointInput = document.querySelector('#model-endpoint');
const modelNameInput = document.querySelector('#model-name');
const modelApiKeyInput = document.querySelector('#model-api-key');
const saveModel = document.querySelector('#save-model');
const modelState = document.querySelector('#model-state');
const modelFeedback = document.querySelector('#model-feedback');
const modelProfilePicker = document.querySelector('#model-profile-picker');
const modelProfileList = document.querySelector('#model-profile-list');
const refreshModelsButton = document.querySelector('#refresh-models');
const enableModel = document.querySelector('#enable-model');
const testModel = document.querySelector('#test-model');
const modelProposalPanel = document.querySelector('#model-proposal');
const modelProposalSummary = document.querySelector('#model-proposal-summary');
const approveModel = document.querySelector('#approve-model');
const askRuntimeWarning = document.querySelector('#ask-runtime-warning');
const askModeState = document.querySelector('#ask-mode-state');
const askSessionSelect = document.querySelector('#ask-session-select');
const newAskSession = document.querySelector('#new-ask-session');
const askSessionStatus = document.querySelector('#ask-session-status');
const askMessages = document.querySelector('#ask-messages');
const askMessageForm = document.querySelector('#ask-message-form');
const askMessageInput = document.querySelector('#ask-message-input');
const sendAskMessage = document.querySelector('#send-ask-message');
const askFeedback = document.querySelector('#ask-feedback');
const invoke = window.__TAURI__?.core?.invoke;
const openDialog = window.__TAURI__?.dialog?.open;
let runtimeReady = false;
let modelProfiles = [];
let selectedModelId = '';
let pendingModelProposal = null;
let askSessions = [];
let selectedAskSessionId = '';
let askMessagesState = [];
let askBusy = false;

function getStored(key) {
  try { return window.localStorage.getItem(key) ?? ''; } catch { return ''; }
}

function setStored(key, value) {
  try { window.localStorage.setItem(key, value); return true; } catch { return false; }
}

function setFeedback(element, message, kind = '') {
  element.textContent = message;
  element.dataset.kind = kind;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

async function modelRequest(method, path, body = null, approval = false, { recoverRuntime = true } = {}) {
  let response;
  try {
    response = await invoke('runtime_request', { request: { method, path, body, approval } });
  } catch (error) {
    if (recoverRuntime) {
      if (runtimeReady) renderRuntime({ state: 'failed', error: 'Runtime 连接已断开，请重新启动。' });
      void refreshRuntime();
    }
    throw error;
  }
  if (!response || !Number.isInteger(response.status)) throw new Error('桌面 Runtime 返回无效响应。');
  if (response.status < 200 || response.status >= 300) {
    const code = response.body?.error;
    throw new Error(typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code)
      ? `Runtime 请求失败：${code}`
      : `Runtime 请求失败（HTTP ${response.status}）`);
  }
  return response.body;
}

async function askRequest(method, path, body = null) {
  try {
    return await modelRequest(method, path, body, false, { recoverRuntime: false });
  } catch (error) {
    // A failed Ask bridge call should refresh the desktop status once, but it
    // must not recursively reload Ask sessions while the failing request is
    // still being handled.
    void refreshRuntime();
    throw error;
  }
}

function selectedModel() {
  return modelProfiles.find((profile) => profile.id === selectedModelId) ?? null;
}

function selectedAskSession() {
  return askSessions.find((session) => session.id === selectedAskSessionId) ?? null;
}

function askSessionLabel(session) {
  const status = session.status === 'active' ? '活跃' : session.status === 'manual_review' ? '人工复核' : session.status === 'closed' ? '已关闭' : session.status ?? '未知状态';
  const createdAt = session.createdAt ? new Date(session.createdAt).toLocaleString() : session.id?.slice(0, 8);
  return `${status} · ${createdAt || session.id?.slice(0, 8) || 'Ask'}`;
}

function askMessageText(message) {
  if (typeof message?.content === 'string') return message.content;
  if (message?.content && typeof message.content === 'object') {
    if (typeof message.content.text === 'string' && message.content.text) return message.content.text;
    try { return JSON.stringify(message.content, null, 2); } catch { return '[无法显示消息内容]'; }
  }
  return '';
}

function renderAskMessages(messages = []) {
  askMessagesState = Array.isArray(messages) ? messages : [];
  if (!askMessagesState.length) {
    askMessages.innerHTML = '<p class="ask-empty">暂无消息。可以先问我如何阅读当前项目。</p>';
    return;
  }
  askMessages.innerHTML = askMessagesState.map((message) => {
    const role = message?.role === 'user' ? '你' : 'Workbench';
    const kind = message?.role === 'user' ? 'ask-message--user' : 'ask-message--assistant';
    const timestamp = message?.createdAt ? new Date(message.createdAt).toLocaleTimeString() : '';
    return `<article class="ask-message ${kind}"><div class="ask-message-meta"><strong>${escapeHtml(role)}</strong><span>${escapeHtml(timestamp)}</span></div><div class="ask-message-content">${escapeHtml(askMessageText(message))}</div></article>`;
  }).join('');
  askMessages.scrollTop = askMessages.scrollHeight;
}

function renderAskSessions(sessions = []) {
  askSessions = Array.isArray(sessions) ? sessions.filter((session) => session?.mode === 'Ask') : [];
  if (!askSessions.some((session) => session.id === selectedAskSessionId)) selectedAskSessionId = askSessions.at(-1)?.id ?? '';
  askSessionSelect.innerHTML = '<option value="">选择 Ask 会话…</option>' + askSessions.map((session) =>
    `<option value="${escapeHtml(session.id)}">${escapeHtml(askSessionLabel(session))}</option>`
  ).join('');
  askSessionSelect.value = selectedAskSessionId;
  const session = selectedAskSession();
  if (!session) {
    askSessionStatus.textContent = runtimeReady ? '暂无 Ask 会话' : 'Runtime 未启动';
    askSessionStatus.dataset.kind = runtimeReady ? '' : 'warning';
    renderAskMessages([]);
  } else if (session.status === 'manual_review') {
    askSessionStatus.textContent = '人工复核：发送已暂停';
    askSessionStatus.dataset.kind = 'warning';
  } else if (session.status === 'closed') {
    askSessionStatus.textContent = '已关闭：请新建 Ask';
    askSessionStatus.dataset.kind = 'warning';
  } else {
    askSessionStatus.textContent = `${session.messageCount ?? askMessagesState.length} 条消息 · 只读`;
    askSessionStatus.dataset.kind = 'success';
  }
  updateAskActionState();
}

function updateAskActionState() {
  const session = selectedAskSession();
  const active = runtimeReady && session?.status === 'active';
  askSessionSelect.disabled = !runtimeReady || askBusy;
  newAskSession.disabled = !runtimeReady || askBusy;
  askMessageInput.disabled = !active || askBusy;
  sendAskMessage.disabled = !active || askBusy;
  askModeState.textContent = '只读';
  askModeState.className = 'badge badge--success';
  askRuntimeWarning.hidden = runtimeReady;
}

async function loadAskMessages() {
  const session = selectedAskSession();
  if (!runtimeReady || !session) {
    renderAskMessages([]);
    updateAskActionState();
    return;
  }
  try {
    const result = await askRequest('GET', `/v1/sessions/${encodeURIComponent(session.id)}/messages`);
    renderAskMessages(result.messages);
    const latest = askSessions.find((item) => item.id === session.id);
    if (latest) latest.messageCount = askMessagesState.length;
    renderAskSessions(askSessions);
  } catch (error) {
    setFeedback(askFeedback, error.message || '无法读取 Ask 消息。', 'error');
  }
}

async function refreshAskSessions({ selectLatest = false } = {}) {
  if (!runtimeReady || !invoke) return;
  try {
    const result = await askRequest('GET', '/v1/sessions');
    const previous = selectedAskSessionId;
    const incoming = Array.isArray(result.sessions) ? result.sessions.filter((session) => session?.mode === 'Ask') : [];
    if (selectLatest || !incoming.some((session) => session.id === previous)) selectedAskSessionId = incoming.at(-1)?.id ?? '';
    renderAskSessions(incoming);
    await loadAskMessages();
  } catch (error) {
    renderAskSessions([]);
    setFeedback(askFeedback, error.message || '无法读取 Ask 会话。', 'error');
  }
}

async function createAskSession() {
  if (!runtimeReady || askBusy) return;
  askBusy = true;
  updateAskActionState();
  setFeedback(askFeedback, '正在创建只读 Ask 会话…');
  try {
    const result = await askRequest('POST', '/v1/sessions', { mode: 'Ask', actor: 'user' });
    if (!result?.session?.id) throw new Error('Runtime 未返回有效的 Ask 会话。');
    selectedAskSessionId = result.session.id;
    await refreshAskSessions();
    setFeedback(askFeedback, 'Ask 会话已创建；它不会生成修改提案。', 'success');
  } catch (error) {
    setFeedback(askFeedback, error.message || 'Ask 会话创建失败。', 'error');
  } finally {
    askBusy = false;
    updateAskActionState();
  }
}

async function sendCurrentAskMessage() {
  const session = selectedAskSession();
  const message = askMessageInput.value.trim();
  if (!runtimeReady) {
    setFeedback(askFeedback, 'Runtime 未启动，请先启动 Runtime。', 'error');
    return;
  }
  if (!session || session.status !== 'active') {
    setFeedback(askFeedback, '请选择一个活跃的 Ask 会话，或新建 Ask。', 'error');
    return;
  }
  if (!message) {
    setFeedback(askFeedback, '请输入问题后再发送。', 'error');
    askMessageInput.focus();
    return;
  }
  askBusy = true;
  updateAskActionState();
  setFeedback(askFeedback, 'Ask 正在读取项目，请稍候…');
  try {
    const profile = selectedModel();
    const body = { message };
    if (profile?.enabled === true) body.modelId = profile.id;
    const result = await askRequest('POST', `/v1/sessions/${encodeURIComponent(session.id)}/messages`, body);
    askMessageInput.value = '';
    await loadAskMessages();
    await refreshAskSessions();
    setFeedback(askFeedback, 'Ask 已完成；未创建修改提案。', 'success');
    return result;
  } catch (error) {
    setFeedback(askFeedback, error.message || 'Ask 请求失败。', 'error');
  } finally {
    askBusy = false;
    updateAskActionState();
  }
}

function updateModelActionState() {
  const profile = selectedModel();
  const pending = Boolean(pendingModelProposal?.action);
  saveModel.disabled = !runtimeReady || pending;
  enableModel.disabled = !runtimeReady || pending || !profile;
  testModel.disabled = !runtimeReady || pending || !profile;
  refreshModelsButton.disabled = !runtimeReady || pending;
  enableModel.textContent = profile?.enabled ? '申请停用' : '申请启用';
  approveModel.disabled = !runtimeReady || !pending;
}

function renderModelProfiles(profiles) {
  modelProfiles = Array.isArray(profiles) ? profiles : [];
  if (!modelProfiles.some((profile) => profile.id === selectedModelId)) selectedModelId = modelProfiles[0]?.id ?? '';
  modelProfilePicker.innerHTML = '<option value="">选择模型…</option>' + modelProfiles.map((profile) =>
    `<option value="${escapeHtml(profile.id)}">${escapeHtml(profile.provider)} / ${escapeHtml(profile.model)}</option>`
  ).join('');
  modelProfilePicker.value = selectedModelId;
  const profile = selectedModel();
  if (!profile) {
    modelProfileList.textContent = modelProfiles.length ? '选择一个模型查看状态。' : '尚无模型档案。';
    modelState.textContent = modelProfiles.length ? `${modelProfiles.length} 个模型` : '未配置';
    modelState.className = `badge ${modelProfiles.length ? 'badge--warning' : 'badge--muted'}`;
  } else {
    const health = profile.health?.status ?? 'unknown';
    const checkedAt = profile.health?.checkedAt ? `\n最近检查：${profile.health.checkedAt}` : '';
    modelProfileList.textContent = `${profile.provider} / ${profile.model}\n${profile.enabled ? '已启用' : '未启用'} · ${health}${checkedAt}`;
    modelState.textContent = profile.enabled ? `已启用 · ${health}` : '待启用';
    modelState.className = `badge ${profile.enabled && health === 'ready' ? 'badge--success' : 'badge--warning'}`;
  }
  updateModelActionState();
}

function renderModelProposal(proposal) {
  pendingModelProposal = proposal ?? null;
  if (!pendingModelProposal?.action) {
    modelProposalPanel.hidden = true;
    modelProposalSummary.textContent = '';
    updateModelActionState();
    return;
  }
  const { action } = pendingModelProposal;
  const preview = action.preview ?? {};
  const capabilities = Array.isArray(preview.capabilities) && preview.capabilities.length ? `能力：${preview.capabilities.join('、')}` : '';
  const summary = action.type === 'model.register'
    ? [`登记档案：${preview.id ?? action.target}`, `Provider：${preview.provider ?? '未提供'}`, `协议：${preview.protocol ?? '未提供'}`, `模型：${preview.model ?? '未提供'}`, `Endpoint：${preview.endpoint ?? '未提供'}`, capabilities, `密钥引用：${preview.secretRef ?? '未提供'}`, '审批后仍需单独启用。']
    : [`申请${preview.enabled ? '启用' : '停用'}档案：${preview.profileId ?? action.target}`, `Provider：${preview.provider ?? '未提供'}`, `协议：${preview.protocol ?? '未提供'}`, `模型：${preview.model ?? '未提供'}`, `Endpoint：${preview.endpoint ?? '未提供'}`, capabilities, `密钥引用：${preview.secretRef ?? '未提供'}`];
  modelProposalSummary.textContent = summary.filter(Boolean).join(' · ');
  modelProposalPanel.hidden = false;
  updateModelActionState();
}

async function refreshModels() {
  if (!runtimeReady || !invoke) return;
  modelState.textContent = '读取中';
  modelState.className = 'badge badge--muted';
  try {
    const result = await modelRequest('GET', '/v1/models');
    renderModelProfiles(result.models);
    if (!result.models?.length) setFeedback(modelFeedback, '尚未配置模型。', '');
  } catch (error) {
    renderModelProfiles([]);
    modelProfilePicker.innerHTML = '<option value="">模型状态不可用</option>';
    modelProfileList.textContent = '无法读取模型状态；请检查 Runtime 后重试。';
    modelState.textContent = '不可用';
    modelState.className = 'badge badge--warning';
    setFeedback(modelFeedback, error.message || '无法读取模型状态。', 'error');
  }
}

function isLikelyAbsolutePath(value) {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\');
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch { return false; }
}

function updateProjectState(pathValue) {
  const hasProject = Boolean(pathValue);
  projectState.textContent = hasProject ? '已保存' : '尚未选择';
  projectState.className = `badge ${hasProject ? 'badge--success' : 'badge--muted'}`;
}

function updateConnectionState(addressValue) {
  const hasAddress = Boolean(addressValue);
  connectionState.textContent = hasAddress ? '已配置' : '未配置';
  connectionState.className = `badge ${hasAddress ? 'badge--success' : 'badge--muted'}`;
  // A normal browser navigation cannot carry the Runtime Bearer token. Keep
  // this entry inert until a desktop-authenticated open-console command exists.
  consoleLink.href = '#';
  consoleLink.classList.add('console-link--disabled');
  consoleLink.setAttribute('aria-disabled', 'true');
  consoleLink.tabIndex = -1;
}

projectInput.value = getStored(STORAGE_KEYS.projectPath);
addressInput.value = getStored(STORAGE_KEYS.runtimeAddress);
updateProjectState(projectInput.value);
updateConnectionState(addressInput.value);

function renderRuntime(status) {
  const ready = status?.state === 'ready';
  const failed = status?.state === 'failed';
  const wasReady = runtimeReady;
  runtimeReady = ready;
  projectInput.value = status?.workspace || projectInput.value;
  updateProjectState(projectInput.value);
  runtimeState.textContent = ready ? '已运行' : failed ? '异常' : status?.state === 'starting' ? '启动中' : '已停止';
  runtimeState.className = `badge ${ready ? 'badge--success' : failed ? 'badge--warning' : 'badge--muted'}`;
  runtimeCopy.textContent = ready ? 'Runtime 已就绪' : failed ? (status.error || 'Runtime 启动失败') : '等待启动本地 Runtime';
  runtimeDot.className = `status-dot ${ready ? 'status-dot--idle' : 'status-dot--warning'}`;
  startRuntime.disabled = !invoke || ready || status?.state === 'starting';
  stopRuntime.disabled = !invoke || !ready;
  modelSettingsForm.disabled = !ready;
  updateModelActionState();
  if (ready && !wasReady) {
    void refreshModels();
    void refreshAskSessions({ selectLatest: true });
  }
  if (!ready && wasReady) {
    renderModelProfiles([]);
    modelProfilePicker.innerHTML = '<option value="">启动 Runtime 后加载</option>';
    modelProfileList.textContent = '启动 Runtime 后加载模型状态。';
    modelState.textContent = 'Runtime 未运行';
    modelState.className = 'badge badge--muted';
    setFeedback(modelFeedback, '', '');
    renderModelProposal(null);
    selectedAskSessionId = '';
    renderAskSessions([]);
    setFeedback(askFeedback, '', '');
  }
  if (status?.address) {
    addressInput.value = status.address;
    setStored(STORAGE_KEYS.runtimeAddress, status.address);
    updateConnectionState(status.address);
  }
}

async function refreshRuntime() {
  if (!invoke) return;
  try { renderRuntime(await invoke('runtime_status')); }
  catch (error) { setFeedback(projectFeedback, `桌面状态读取失败：${error.message || '未知错误'}`, 'error'); }
}

document.querySelector('#save-project').addEventListener('click', () => {
  const pathValue = projectInput.value.trim();
  if (!pathValue) {
    updateProjectState('');
    setFeedback(projectFeedback, '请先输入项目文件夹的绝对路径。', 'error');
    projectInput.focus();
    return;
  }
  if (!isLikelyAbsolutePath(pathValue)) {
    setFeedback(projectFeedback, '请输入 Windows 绝对路径，例如 C:\\Projects\\my-app。', 'error');
    projectInput.focus();
    return;
  }
  const stored = setStored(STORAGE_KEYS.projectPath, pathValue);
  updateProjectState(stored ? pathValue : '');
  setFeedback(projectFeedback, stored ? '项目路径已保存在本机配置中。' : '浏览器拒绝保存本机配置，请检查应用权限。', stored ? 'success' : 'error');
});

browseWorkspace.addEventListener('click', async () => {
  if (!invoke || !openDialog) {
    setFeedback(projectFeedback, '文件夹选择器仅在桌面应用中可用。', 'error');
    return;
  }
  try {
    const selected = await openDialog({ directory: true, multiple: false, title: '选择项目文件夹' });
    const selectedPath = Array.isArray(selected) ? selected[0] : selected;
    if (typeof selectedPath !== 'string' || !selectedPath) return;
    const canonical = await invoke('choose_workspace', { path: selectedPath });
    projectInput.value = canonical;
    const stored = setStored(STORAGE_KEYS.projectPath, canonical);
    updateProjectState(stored ? canonical : '');
    setFeedback(projectFeedback, stored ? '项目文件夹已选择并通过桌面校验。' : '文件夹已选择，但本机配置无法保存。', stored ? 'success' : 'error');
  } catch (error) {
    setFeedback(projectFeedback, error.message || '无法读取所选项目文件夹。', 'error');
  }
});

startRuntime.addEventListener('click', async () => {
  const pathValue = projectInput.value.trim();
  if (!invoke) return setFeedback(projectFeedback, '当前页面未运行在 Tauri 桌面壳中。', 'error');
  if (!pathValue || !isLikelyAbsolutePath(pathValue)) return setFeedback(projectFeedback, '请先保存有效的 Windows 绝对路径。', 'error');
  startRuntime.disabled = true;
  setFeedback(projectFeedback, '正在启动本地 Runtime…');
  try {
    const canonical = await invoke('choose_workspace', { path: pathValue });
    setStored(STORAGE_KEYS.projectPath, canonical);
    projectInput.value = canonical;
    renderRuntime(await invoke('start_runtime', { workspace: canonical }));
    setFeedback(projectFeedback, '项目已连接，Runtime 已通过本地健康检查。', 'success');
  } catch (error) {
    setFeedback(projectFeedback, error.message || 'Runtime 启动失败。', 'error');
    await refreshRuntime();
  }
});

stopRuntime.addEventListener('click', async () => {
  if (!invoke) return;
  stopRuntime.disabled = true;
  try { renderRuntime(await invoke('stop_runtime')); setFeedback(projectFeedback, 'Runtime 已停止。', 'success'); }
  catch (error) { setFeedback(projectFeedback, error.message || 'Runtime 停止失败。', 'error'); await refreshRuntime(); }
});

saveModel.addEventListener('click', async () => {
  const id = modelIdInput.value.trim();
  const provider = modelProviderInput.value.trim();
  const endpoint = modelEndpointInput.value.trim();
  const model = modelNameInput.value.trim();
  const apiKey = modelApiKeyInput.value.trim();
  if (!id || !provider || !endpoint || !model || !apiKey) {
    setFeedback(modelFeedback, '请填写完整的模型信息和 API Key。', 'error');
    return;
  }
  if (modelProfiles.some((profile) => profile.id === id)) {
    modelApiKeyInput.value = '';
    setFeedback(modelFeedback, '该档案 ID 已存在；当前桌面设置不支持原地修改。', 'error');
    return;
  }
  saveModel.disabled = true;
  let secretStored = false;
  let profileProposed = false;
  const secretName = `workbench.model.${id}`;
  try {
    await modelRequest('POST', '/v1/secrets', { name: secretName, value: apiKey });
    secretStored = true;
    modelApiKeyInput.value = '';
    const result = await modelRequest('POST', '/v1/models', {
      sessionId: 'desktop-settings',
      id,
      provider,
      protocol: 'openai-compatible',
      model,
      endpoint,
      capabilities: ['text', 'tool_calling'],
      secretRef: `keychain:${secretName}`
    });
    profileProposed = true;
    renderModelProposal(result.proposal);
    setFeedback(modelFeedback, '密钥已保存到 Windows 凭据管理器；模型档案等待人工批准。', 'success');
  } catch (error) {
    if (secretStored && !profileProposed) {
      try { await modelRequest('DELETE', `/v1/secrets/${encodeURIComponent(secretName)}`, null, true); } catch {}
    }
    const message = error.message || '模型配置失败。';
    setFeedback(modelFeedback, apiKey && message.includes(apiKey) ? '模型配置失败，错误内容已隐藏。' : message, 'error');
  } finally {
    modelApiKeyInput.value = '';
    updateModelActionState();
  }
});

approveModel.addEventListener('click', async () => {
  const action = pendingModelProposal?.action;
  if (!action || !runtimeReady) return;
  approveModel.disabled = true;
  try {
    await modelRequest('POST', `/v1/models/${encodeURIComponent(action.id)}/approve`, { actionHash: action.actionHash }, true);
    renderModelProposal(null);
    await refreshModels();
    setFeedback(modelFeedback, '模型变更已批准。', 'success');
  } catch (error) {
    approveModel.disabled = false;
    setFeedback(modelFeedback, error.message || '模型审批失败。', 'error');
  }
});

modelProfilePicker.addEventListener('change', () => {
  selectedModelId = modelProfilePicker.value;
  renderModelProfiles(modelProfiles);
});

enableModel.addEventListener('click', async () => {
  const profile = selectedModel();
  if (!profile || !runtimeReady) return;
  enableModel.disabled = true;
  const operation = profile.enabled ? 'disable' : 'enable';
  try {
    const result = await modelRequest('POST', `/v1/models/${encodeURIComponent(profile.id)}/${operation}`, {
      sessionId: 'desktop-settings',
      configHash: profile.configHash
    });
    renderModelProposal(result.proposal);
    setFeedback(modelFeedback, `模型${profile.enabled ? '停用' : '启用'}等待人工批准。`, '');
  } catch (error) {
    setFeedback(modelFeedback, error.message || '无法创建模型状态变更提案。', 'error');
  } finally {
    updateModelActionState();
  }
});

testModel.addEventListener('click', async () => {
  const profile = selectedModel();
  if (!profile || !runtimeReady) return;
  testModel.disabled = true;
  try {
    const result = await modelRequest('POST', `/v1/models/${encodeURIComponent(profile.id)}/health`, { actionHash: profile.configHash }, true);
    await refreshModels();
    setFeedback(modelFeedback, `连接测试完成：${result.health?.status ?? 'unknown'}。`, result.health?.status === 'ready' ? 'success' : '');
  } catch (error) {
    setFeedback(modelFeedback, error.message || '模型连接测试失败。', 'error');
  } finally {
    updateModelActionState();
  }
});

refreshModelsButton.addEventListener('click', () => { void refreshModels(); });

askSessionSelect.addEventListener('change', () => {
  selectedAskSessionId = askSessionSelect.value;
  renderAskSessions(askSessions);
  void loadAskMessages();
});

newAskSession.addEventListener('click', () => { void createAskSession(); });

askMessageForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void sendCurrentAskMessage();
});

document.querySelector('#save-address').addEventListener('click', () => {
  const addressValue = addressInput.value.trim().replace(/\/$/, '');
  if (!addressValue || !isHttpUrl(addressValue)) {
    updateConnectionState('');
    setFeedback(addressFeedback, '请输入有效的 http:// 或 https:// Runtime 地址。', 'error');
    addressInput.focus();
    return;
  }
  const stored = setStored(STORAGE_KEYS.runtimeAddress, addressValue);
  updateConnectionState(stored ? addressValue : '');
  setFeedback(addressFeedback, stored ? '地址已保存；连接将在 Runtime 接入后由桌面进程确认。' : '浏览器拒绝保存本机配置，请检查应用权限。', stored ? 'success' : 'error');
});

consoleLink.addEventListener('click', (event) => {
  event.preventDefault();
  setFeedback(addressFeedback, '控制台需要桌面认证入口；不会把 token 放入 URL。', 'error');
});

void refreshRuntime();
renderAskSessions([]);
