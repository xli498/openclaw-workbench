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
const invoke = window.__TAURI__?.core?.invoke;
const openDialog = window.__TAURI__?.dialog?.open;

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
  projectInput.value = status?.workspace || projectInput.value;
  updateProjectState(projectInput.value);
  runtimeState.textContent = ready ? '已运行' : failed ? '异常' : status?.state === 'starting' ? '启动中' : '已停止';
  runtimeState.className = `badge ${ready ? 'badge--success' : failed ? 'badge--warning' : 'badge--muted'}`;
  runtimeCopy.textContent = ready ? 'Runtime 已就绪' : failed ? (status.error || 'Runtime 启动失败') : '等待启动本地 Runtime';
  runtimeDot.className = `status-dot ${ready ? 'status-dot--idle' : 'status-dot--warning'}`;
  startRuntime.disabled = !invoke || ready || status?.state === 'starting';
  stopRuntime.disabled = !invoke || !ready;
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
