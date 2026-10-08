use super::*;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

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

#[tauri::command(rename = "choose_workspace")]
pub fn choose_workspace(path: String) -> Result<String, String> {
    choose_workspace_path(&path).map(|value| value.display().to_string())
}

#[tauri::command(rename = "runtime_status")]
pub fn runtime_status(state: State<'_, RuntimeState>) -> Result<RuntimeStatus, String> {
    let mut manager = state
        .0
        .lock()
        .map_err(|_| "runtime state is unavailable".to_string())?;
    Ok(status_of(&mut manager))
}

#[tauri::command(rename = "start_runtime")]
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
    manager.workspace = Some(canonical);
    manager.ready = Some(process.ready.clone());
    manager.token = Some(token);
    manager.approval_token = Some(approval_token);
    manager.process = Some(process);
    manager.status = "ready".into();
    Ok(status_of(&mut manager))
}

#[tauri::command(rename = "stop_runtime")]
pub fn stop_runtime(state: State<'_, RuntimeState>) -> Result<RuntimeStatus, String> {
    let mut manager = state
        .0
        .lock()
        .map_err(|_| "runtime state is unavailable".to_string())?;
    stop_manager(&mut manager)?;
    Ok(status_of(&mut manager))
}

#[tauri::command(rename = "runtime_request")]
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
