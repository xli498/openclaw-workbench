use std::path::{Path, PathBuf};
use std::process::{Child, Command};

/// Explicit contract for a future desktop host integration.
///
/// The shell deliberately does not source secrets or expose this as a UI command. A host
/// integration may construct this value after its own authentication and approval flow.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeLaunchSpec {
    pub node_executable: PathBuf,
    pub runtime_script: PathBuf,
    pub working_directory: PathBuf,
    pub args: Vec<String>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum RuntimeLauncherError {
    RelativeNodeExecutable,
    RelativeRuntimeScript,
    RelativeWorkingDirectory,
    EmptyArgument,
    SpawnFailed,
}

impl RuntimeLaunchSpec {
    pub fn validate(&self) -> Result<(), RuntimeLauncherError> {
        if !self.node_executable.is_absolute() {
            return Err(RuntimeLauncherError::RelativeNodeExecutable);
        }
        if !self.runtime_script.is_absolute() {
            return Err(RuntimeLauncherError::RelativeRuntimeScript);
        }
        if !self.working_directory.is_absolute() {
            return Err(RuntimeLauncherError::RelativeWorkingDirectory);
        }
        if self.args.iter().any(|arg| arg.is_empty()) {
            return Err(RuntimeLauncherError::EmptyArgument);
        }
        Ok(())
    }

    /// Starts Node with the existing runtime entry point using argv only and no shell.
    pub fn spawn(&self) -> Result<Child, RuntimeLauncherError> {
        self.validate()?;
        let mut command = Command::new(&self.node_executable);
        command
            .arg(&self.runtime_script)
            .args(&self.args)
            .current_dir(&self.working_directory);
        command
            .spawn()
            .map_err(|_| RuntimeLauncherError::SpawnFailed)
    }
}

pub fn runtime_script_from(repo_root: &Path) -> PathBuf {
    repo_root.join("runtime").join("index.mjs")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> RuntimeLaunchSpec {
        RuntimeLaunchSpec {
            node_executable: PathBuf::from(r"C:\Program Files\nodejs\node.exe"),
            runtime_script: PathBuf::from(r"C:\workbench\runtime\index.mjs"),
            working_directory: PathBuf::from(r"C:\workbench"),
            args: vec!["--help".into()],
        }
    }

    #[test]
    fn requires_absolute_paths() {
        let mut value = spec();
        value.runtime_script = PathBuf::from("runtime/index.mjs");
        assert_eq!(
            value.validate(),
            Err(RuntimeLauncherError::RelativeRuntimeScript)
        );
    }

    #[test]
    fn rejects_empty_arguments() {
        let mut value = spec();
        value.args.push(String::new());
        assert_eq!(value.validate(), Err(RuntimeLauncherError::EmptyArgument));
    }

    #[test]
    fn derives_existing_runtime_entrypoint() {
        assert_eq!(
            runtime_script_from(Path::new(r"C:\workbench")),
            PathBuf::from(r"C:\workbench\runtime\index.mjs")
        );
    }
}
