mod runtime_launcher;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running OpenClaw Workbench desktop application");
}

pub use runtime_launcher::{RuntimeLaunchSpec, RuntimeLauncherError};
