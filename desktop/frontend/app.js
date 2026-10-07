const STORAGE_KEYS = Object.freeze({
  projectPath: 'openclaw.workbench.projectPath',
  runtimeAddress: 'openclaw.workbench.runtimeAddress'
});

const projectInput = document.querySelector('#project-path');
const projectState = document.querySelector('#workspace-state');
const projectFeedback = document.querySelector('#project-feedback');
const addressInput = document.querySelector('#runtime-address');
const connectionState = document.querySelector('#connection-state');
const addressFeedback = document.querySelector('#address-feedback');
const consoleLink = document.querySelector('#console-link');

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
  consoleLink.href = hasAddress ? addressValue : '#';
  consoleLink.classList.toggle('console-link--disabled', !hasAddress);
  consoleLink.setAttribute('aria-disabled', String(!hasAddress));
  consoleLink.tabIndex = hasAddress ? 0 : -1;
}

projectInput.value = getStored(STORAGE_KEYS.projectPath);
addressInput.value = getStored(STORAGE_KEYS.runtimeAddress);
updateProjectState(projectInput.value);
updateConnectionState(addressInput.value);

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
  if (consoleLink.getAttribute('aria-disabled') === 'true') {
    event.preventDefault();
    setFeedback(addressFeedback, '请先保存 Runtime 地址。', 'error');
  }
});
