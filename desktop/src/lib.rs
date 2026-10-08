mod runtime_launcher;

use runtime_launcher::{
    generate_token, runtime_request as send_runtime_request, runtime_script_from,
    RuntimeLaunchSpec, RuntimeLauncherError, RuntimeProcess, RuntimeReady,
};
use serde::{Deserialize, Serialize};
use std::env;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, RunEvent, State};

#[derive(Debug, Clone, Serialize)]
pub struct RuntimeStatus {
    pub state: String,
    pub workspace: Option<String>,
    pub address: Option<String>,
    pub pid: Option<u32>,
    pub error: Option<String>,
}

struct RuntimeManager {
    process: Option<RuntimeProcess>,
    ready: Option<RuntimeReady>,
    workspace: Option<PathBuf>,
    token: Option<String>,
    approval_token: Option<String>,
    status: String,
    error: Option<String>,
}

impl Default for RuntimeManager {
    fn default() -> Self {
        Self {
            process: None,
            ready: None,
            workspace: None,
            token: None,
            approval_token: None,
            status: "stopped".into(),
            error: None,
        }
    }
}

pub struct RuntimeState(pub Mutex<RuntimeManager>);

impl Default for RuntimeState {
    fn default() -> Self {
        Self(Mutex::new(RuntimeManager::default()))
    }
}

#[derive(Debug, Deserialize)]
pub struct RuntimeRequest {
    pub method: String,
    pub path: String,
    pub body: Option<serde_json::Value>,
    pub approval: Option<bool>,
}

#[derive(Debug, Serialize)]
pub struct RuntimeResponse {
    pub status: u16,
    pub body: serde_json::Value,
}

fn error_text(error: RuntimeLauncherError) -> String {
    format!("runtime operation failed: {error:?}")
}

fn status_of(manager: &mut RuntimeManager) -> RuntimeStatus {
    let running = manager.process.as_mut().map(RuntimeProcess::is_running);
    if running == Some(true) {
        manager.status = "ready".into();
    } else if running == Some(false) {
        manager.status = "failed".into();
        manager.error = Some("runtime process exited unexpectedly".into());
        manager.process = None;
        manager.ready = None;
        manager.token = None;
        manager.approval_token = None;
    }
    RuntimeStatus {
        state: manager.status.clone(),
        workspace: manager
            .workspace
            .as_ref()
            .map(|path| path.display().to_string()),
        address: manager
            .ready
            .as_ref()
            .map(|ready| format!("http://{}:{}", ready.host, ready.port)),
        pid: manager.process.as_ref().map(RuntimeProcess::pid),
        error: manager.error.clone(),
    }
}

fn choose_workspace_path(value: &str) -> Result<PathBuf, String> {
    let path = Path::new(value);
    if !path.is_absolute() {
        return Err("workspace must be an absolute path".into());
    }
    let canonical = path
        .canonicalize()
        .map_err(|_| "workspace does not exist".to_string())?;
    if !canonical.is_dir() {
        return Err("workspace must be a directory".into());
    }
    Ok(canonical)
}

fn node_executable_from_path() -> Result<PathBuf, String> {
    let names = if cfg!(windows) {
        ["node.exe", "node"]
    } else {
        ["node", "node.exe"]
    };
    let path = env::var_os("PATH").ok_or_else(|| "Node.js was not found on PATH".to_string())?;
    for directory in env::split_paths(&path) {
        for name in names {
            let candidate = directory.join(name);
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }
    Err("Node.js was not found on PATH".into())
}

fn node_executable(app: &AppHandle) -> Result<PathBuf, String> {
    let resource_root = app
        .path()
        .resource_dir()
        .map_err(|_| "desktop resource directory is unavailable".to_string())?;
    let bundled = resource_root
        .join("runtime")
        .join("node")
        .join(if cfg!(windows) { "node.exe" } else { "node" });
    if bundled.is_file() {
        return Ok(bundled);
    }

    // `cargo tauri dev` does not always materialize bundle resources. In a
    // debug build, prefer the downloaded developer runtime and finally the
    // user's PATH. Release builds must use the bundled runtime so an
    // installer can never silently depend on a machine-wide Node install.
    #[cfg(debug_assertions)]
    {
        let development = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("node-runtime")
            .join(if cfg!(windows) { "node.exe" } else { "node" });
        if development.is_file() {
            return Ok(development);
        }
        return node_executable_from_path();
    }

    Err("bundled Node.js runtime is unavailable; prepare desktop/node-runtime before building a release".into())
}

fn runtime_script_path(app: &AppHandle) -> Result<PathBuf, String> {
    let resource_root = app
        .path()
        .resource_dir()
        .map_err(|_| "desktop resource directory is unavailable".to_string())?;
    let packaged_script = runtime_script_from(&resource_root.join("runtime"));
    if packaged_script.is_file() {
        return Ok(packaged_script);
    }

    // `cargo tauri dev` may not materialize bundle resources. Keep this fallback
    // debug-only so release builds never silently depend on a source checkout.
    #[cfg(debug_assertions)]
    {
        let repository_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .ok_or_else(|| "desktop repository root is unavailable".to_string())?
            .to_path_buf();
        let development_script = runtime_script_from(&repository_root);
        if development_script.is_file() {
            return Ok(development_script);
        }
    }

    Err("Workbench runtime resources are unavailable; build the desktop bundle or run cargo tauri dev from the repository".into())
}

fn stop_manager(manager: &mut RuntimeManager) -> Result<(), String> {
    let stop_result = match (
        manager.process.take(),
        manager.token.as_deref(),
        manager.approval_token.as_deref(),
    ) {
        (Some(mut process), Some(token), Some(approval_token)) => {
            process.stop(token, approval_token).map_err(error_text)
        }
        (Some(mut process), _, _) => {
            let result = process.force_stop().map_err(error_text);
            if result.is_ok() {
                Err("runtime credentials were unavailable during shutdown".into())
            } else {
                result
            }
        }
        (None, _, _) => Ok(()),
    };
    manager.ready = None;
    manager.token = None;
    manager.approval_token = None;
    match stop_result {
        Ok(()) => {
            manager.status = "stopped".into();
            manager.error = None;
            Ok(())
        }
        Err(error) => {
            manager.status = "failed".into();
            manager.error = Some(error.clone());
            Err(error)
        }
    }
}

#[cfg_attr(not(test), tauri::command)]
pub fn choose_workspace(path: String) -> Result<String, String> {
    choose_workspace_path(&path).map(|value| value.display().to_string())
}

#[cfg_attr(not(test), tauri::command)]
pub fn runtime_status(state: State<'_, RuntimeState>) -> Result<RuntimeStatus, String> {
    let mut manager = state
        .0
        .lock()
        .map_err(|_| "runtime state is unavailable".to_string())?;
    Ok(status_of(&mut manager))
}

#[cfg_attr(not(test), tauri::command)]
pub fn start_runtime(
    workspace: String,
    app: AppHandle,
    state: State<'_, RuntimeState>,
) -> Result<RuntimeStatus, String> {
    let canonical = choose_workspace_path(&workspace)?;
    let mut manager = state
        .0
        .lock()
        .map_err(|_| "runtime state is unavailable".to_string())?;
    if manager.process.is_some() {
        return Err("runtime is already running; stop it before switching workspace".into());
    }
    manager.status = "starting".into();
    manager.error = None;
    let start_result = (|| {
        let token = generate_token().map_err(error_text)?;
        let approval_token = generate_token().map_err(error_text)?;
        let script = runtime_script_path(&app)?;
        let spec = RuntimeLaunchSpec {
            node_executable: node_executable(&app)?,
            runtime_script: script,
            working_directory: canonical.clone(),
            args: vec![
                "--root".into(),
                canonical.display().to_string(),
                "--host".into(),
                "127.0.0.1".into(),
                "--port".into(),
                "0".into(),
                "--token-env".into(),
                "OPENCLAW_DESKTOP_TOKEN".into(),
                "--approval-token-env".into(),
                "OPENCLAW_DESKTOP_APPROVAL".into(),
                "--json".into(),
            ],
            token_env: "OPENCLAW_DESKTOP_TOKEN".into(),
            approval_token_env: "OPENCLAW_DESKTOP_APPROVAL".into(),
            token,
            approval_token,
        };
        let mut process = spec.spawn().map_err(error_text)?;
        let health = send_runtime_request(
            &process.ready,
            &spec.token,
            &spec.approval_token,
            "GET",
            "/health",
            None,
            false,
        )
        .map_err(error_text);
        let (status, _) = match health {
            Ok(result) => result,
            Err(error) => {
                let _ = process.stop(&spec.token, &spec.approval_token);
                return Err(error);
            }
        };
        if status != 200 {
            let _ = process.stop(&spec.token, &spec.approval_token);
            return Err("runtime health check failed".into());
        }
        Ok((process, spec.token, spec.approval_token))
    })();
    let (process, token, approval_token) = match start_result {
        Ok(started) => started,
        Err(error) => {
            manager.status = "failed".into();
            manager.error = Some(error.clone());
            manager.ready = None;
            manager.token = None;
            manager.approval_token = None;
            manager.process = None;
            return Err(error);
        }
    };
    let process = process;
    manager.workspace = Some(canonical);
    manager.ready = Some(process.ready.clone());
    manager.token = Some(token);
    manager.approval_token = Some(approval_token);
    manager.process = Some(process);
    manager.status = "ready".into();
    Ok(status_of(&mut manager))
}

#[cfg_attr(not(test), tauri::command)]
pub fn stop_runtime(state: State<'_, RuntimeState>) -> Result<RuntimeStatus, String> {
    let mut manager = state
        .0
        .lock()
        .map_err(|_| "runtime state is unavailable".to_string())?;
    stop_manager(&mut manager)?;
    Ok(status_of(&mut manager))
}

#[cfg_attr(not(test), tauri::command)]
pub fn runtime_request(
    request: RuntimeRequest,
    state: State<'_, RuntimeState>,
) -> Result<RuntimeResponse, String> {
    let mut manager = state
        .0
        .lock()
        .map_err(|_| "runtime state is unavailable".to_string())?;
    let running = manager
        .process
        .as_mut()
        .map(RuntimeProcess::is_running)
        .unwrap_or(false);
    let ready = manager
        .ready
        .as_ref()
        .ok_or_else(|| "runtime is not ready".to_string())?;
    let token = manager
        .token
        .as_ref()
        .ok_or_else(|| "runtime token is unavailable".to_string())?;
    let approval_token = manager
        .approval_token
        .as_ref()
        .ok_or_else(|| "runtime approval token is unavailable".to_string())?;
    if !running {
        return Err("runtime is not running".into());
    }
    let body = request
        .body
        .as_ref()
        .map(|value| {
            serde_json::to_string(value).map_err(|_| "request body is invalid".to_string())
        })
        .transpose()?;
    let (status, body) = send_runtime_request(
        ready,
        token,
        approval_token,
        &request.method,
        &request.path,
        body.as_deref(),
        request.approval.unwrap_or(false),
    )
    .map_err(error_text)?;
    let body = serde_json::from_str(&body).unwrap_or_else(|_| serde_json::Value::String(body));
    Ok(RuntimeResponse { status, body })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(RuntimeState::default())
        .invoke_handler(tauri::generate_handler![
            choose_workspace,
            runtime_status,
            start_runtime,
            stop_runtime,
            runtime_request
        ])
        .build(tauri::generate_context!())
        .expect("error while building OpenClaw Workbench desktop application");
    app.run(|app_handle, event| {
        if matches!(
            event,
            RunEvent::Exit
                | RunEvent::WindowEvent {
                    event: tauri::WindowEvent::CloseRequested { .. },
                    ..
                }
        ) {
            if let Some(state) = app_handle.try_state::<RuntimeState>() {
                if let Ok(mut manager) = state.0.lock() {
                    let _ = stop_manager(&mut manager);
                }
            }
        }
    });
}
