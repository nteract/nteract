use std::future::Future;
use std::io;
use std::process::{Output, Stdio};

const TERMINATION_FENCE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// Cancellation-safe output collection for package-manager subprocesses.
///
/// Tokio leaves children running when an `output()` future is dropped unless
/// kill-on-drop is enabled. Package managers may also spawn build helpers, so
/// Unix commands own a fresh process group and Windows commands are terminated
/// as a tree. A room-owned launch task can therefore be aborted without an
/// orphan continuing to mutate its environment after the launch gate reopens.
pub trait CommandOutputExt {
    fn output_owned(&mut self) -> impl Future<Output = io::Result<Output>> + Send;
}

impl CommandOutputExt for tokio::process::Command {
    async fn output_owned(&mut self) -> io::Result<Output> {
        self.stdout(Stdio::piped()).stderr(Stdio::piped());
        #[cfg(unix)]
        self.process_group(0);
        #[cfg(windows)]
        {
            use windows_sys::Win32::System::Threading::CREATE_SUSPENDED;

            self.creation_flags(CREATE_SUSPENDED);
        }

        let child = self.spawn()?;
        #[cfg(unix)]
        let pid = child
            .id()
            .ok_or_else(|| io::Error::other("spawned package-manager child has no process id"))?;
        #[cfg(windows)]
        let windows = match WindowsProcessTree::assign(&child) {
            Ok(windows) => windows,
            Err(error) => {
                terminate_suspended_child(&child);
                drop(child);
                return Err(error);
            }
        };
        let mut process_tree = ProcessTreeGuard {
            #[cfg(unix)]
            pid,
            armed: true,
            #[cfg(windows)]
            windows,
        };
        #[cfg(windows)]
        process_tree.windows.resume()?;
        match child.wait_with_output().await {
            Ok(output) => {
                process_tree.armed = false;
                Ok(output)
            }
            Err(error) => Err(error),
        }
    }
}

struct ProcessTreeGuard {
    #[cfg(unix)]
    pid: u32,
    armed: bool,
    #[cfg(windows)]
    windows: WindowsProcessTree,
}

impl Drop for ProcessTreeGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }

        run_blocking_cleanup(|| self.terminate_and_reap());
    }
}

impl ProcessTreeGuard {
    fn terminate_and_reap(&mut self) {
        #[cfg(unix)]
        {
            use nix::sys::signal::{killpg, Signal};
            use nix::sys::wait::{waitpid, WaitPidFlag, WaitStatus};
            use nix::unistd::Pid;

            let pid = Pid::from_raw(self.pid as i32);
            if let Err(error) = killpg(pid, Signal::SIGKILL) {
                if error != nix::errno::Errno::ESRCH {
                    log::warn!(
                        "failed to terminate cancelled package-manager process group {}: {}",
                        self.pid,
                        error
                    );
                }
            }

            // Task abortion drops this guard immediately before the launch
            // attempt records completion. Reap the process leader here so
            // completion cannot reopen the launch gate while that command is
            // still able to mutate a project file or environment.
            let deadline = std::time::Instant::now() + TERMINATION_FENCE_TIMEOUT;
            loop {
                match waitpid(pid, Some(WaitPidFlag::WNOHANG)) {
                    Ok(WaitStatus::Exited(..) | WaitStatus::Signaled(..))
                    | Err(nix::errno::Errno::ECHILD) => break,
                    Err(nix::errno::Errno::EINTR) => continue,
                    Ok(WaitStatus::StillAlive) if std::time::Instant::now() < deadline => {
                        std::thread::sleep(std::time::Duration::from_millis(1));
                    }
                    Ok(WaitStatus::StillAlive) => {
                        log::warn!(
                            "cancelled package-manager process {} did not reap within {:?}",
                            self.pid,
                            TERMINATION_FENCE_TIMEOUT
                        );
                        break;
                    }
                    Ok(status) => {
                        log::warn!(
                            "cancelled package-manager process {} returned unexpected wait status {:?}",
                            self.pid,
                            status
                        );
                        break;
                    }
                    Err(error) => {
                        log::warn!(
                            "failed to reap cancelled package-manager process {}: {}",
                            self.pid,
                            error
                        );
                        break;
                    }
                }
            }
        }

        #[cfg(windows)]
        {
            self.windows.terminate_and_wait();
        }
    }
}

fn run_blocking_cleanup(cleanup: impl FnOnce()) {
    if tokio::runtime::Handle::try_current()
        .is_ok_and(|handle| handle.runtime_flavor() == tokio::runtime::RuntimeFlavor::MultiThread)
    {
        tokio::task::block_in_place(cleanup);
    } else {
        cleanup();
    }
}

#[cfg(windows)]
struct WindowsProcessTree {
    job: windows_sys::Win32::Foundation::HANDLE,
    process: windows_sys::Win32::Foundation::HANDLE,
    pid: u32,
}

#[cfg(windows)]
impl WindowsProcessTree {
    fn assign(child: &tokio::process::Child) -> io::Result<Self> {
        use std::mem::{size_of, zeroed};
        use std::os::windows::io::RawHandle;
        use std::ptr::null;
        use windows_sys::Win32::Foundation::{
            CloseHandle, DuplicateHandle, GetLastError, DUPLICATE_SAME_ACCESS, HANDLE,
        };
        use windows_sys::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };
        use windows_sys::Win32::System::Threading::GetCurrentProcess;

        let pid = child
            .id()
            .ok_or_else(|| io::Error::other("spawned package-manager child has no process id"))?;
        let raw_process = child.raw_handle().ok_or_else(|| {
            io::Error::other("spawned package-manager child has no process handle")
        })? as RawHandle as HANDLE;
        let job = unsafe { CreateJobObjectW(null(), null()) };
        if job == 0 {
            return Err(io::Error::last_os_error());
        }

        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let set_ok = unsafe {
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const _,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if set_ok == 0 {
            let error = unsafe { GetLastError() };
            unsafe { CloseHandle(job) };
            return Err(io::Error::from_raw_os_error(error as i32));
        }

        let current = unsafe { GetCurrentProcess() };
        let mut process = 0;
        let duplicate_ok = unsafe {
            DuplicateHandle(
                current,
                raw_process,
                current,
                &mut process,
                0,
                0,
                DUPLICATE_SAME_ACCESS,
            )
        };
        if duplicate_ok == 0 {
            let error = unsafe { GetLastError() };
            unsafe { CloseHandle(job) };
            return Err(io::Error::from_raw_os_error(error as i32));
        }

        let assign_ok = unsafe { AssignProcessToJobObject(job, raw_process) };
        if assign_ok == 0 {
            let error = unsafe { GetLastError() };
            unsafe {
                CloseHandle(process);
                CloseHandle(job);
            }
            return Err(io::Error::from_raw_os_error(error as i32));
        }

        Ok(Self { job, process, pid })
    }

    fn resume(&self) -> io::Result<()> {
        use std::mem::{size_of, zeroed};
        use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, INVALID_HANDLE_VALUE};
        use windows_sys::Win32::System::Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
        };
        use windows_sys::Win32::System::Threading::{
            OpenThread, ResumeThread, THREAD_SUSPEND_RESUME,
        };

        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
        if snapshot == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }

        let mut entry: THREADENTRY32 = unsafe { zeroed() };
        entry.dwSize = size_of::<THREADENTRY32>() as u32;
        let mut has_entry = unsafe { Thread32First(snapshot, &mut entry) } != 0;
        while has_entry {
            if entry.th32OwnerProcessID == self.pid {
                let thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) };
                if thread == 0 {
                    let error = unsafe { GetLastError() };
                    unsafe { CloseHandle(snapshot) };
                    return Err(io::Error::from_raw_os_error(error as i32));
                }
                let resume_result = unsafe { ResumeThread(thread) };
                let error = unsafe { GetLastError() };
                unsafe {
                    CloseHandle(thread);
                    CloseHandle(snapshot);
                }
                if resume_result == u32::MAX {
                    return Err(io::Error::from_raw_os_error(error as i32));
                }
                return Ok(());
            }
            has_entry = unsafe { Thread32Next(snapshot, &mut entry) } != 0;
        }

        unsafe { CloseHandle(snapshot) };
        Err(io::Error::other(format!(
            "suspended package-manager process {} had no resumable thread",
            self.pid
        )))
    }

    fn terminate_and_wait(&mut self) {
        use std::mem::{size_of, zeroed};
        use windows_sys::Win32::Foundation::{
            CloseHandle, GetLastError, WAIT_OBJECT_0, WAIT_TIMEOUT,
        };
        use windows_sys::Win32::System::JobObjects::{
            JobObjectBasicAccountingInformation, QueryInformationJobObject, TerminateJobObject,
            JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
        };
        use windows_sys::Win32::System::Threading::{TerminateProcess, WaitForSingleObject};

        if unsafe { TerminateJobObject(self.job, 1) } == 0 {
            log::warn!(
                "failed to terminate cancelled package-manager job for process {}: {}",
                self.pid,
                unsafe { GetLastError() }
            );
            // Closing the final kill-on-close job handle is the strongest
            // available tree fallback. Terminate the duplicated leader too,
            // then use its handle as the bounded completion fence below.
            unsafe {
                CloseHandle(self.job);
                TerminateProcess(self.process, 1);
            }
            self.job = 0;
        }
        let wait_ms = TERMINATION_FENCE_TIMEOUT.as_millis() as u32;
        match unsafe { WaitForSingleObject(self.process, wait_ms) } {
            WAIT_OBJECT_0 => {}
            WAIT_TIMEOUT => log::warn!(
                "cancelled package-manager process {} did not exit within {:?}",
                self.pid,
                TERMINATION_FENCE_TIMEOUT
            ),
            _ => log::warn!(
                "failed waiting for cancelled package-manager process {}: {}",
                self.pid,
                unsafe { GetLastError() }
            ),
        }

        // TerminateJobObject initiates termination for the whole job. The
        // duplicated leader handle above fences the direct process; this loop
        // additionally fences every descendant before launch completion can
        // reopen the generation gate.
        let deadline = std::time::Instant::now() + TERMINATION_FENCE_TIMEOUT;
        if self.job != 0 {
            loop {
                let mut accounting: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { zeroed() };
                let query_ok = unsafe {
                    QueryInformationJobObject(
                        self.job,
                        JobObjectBasicAccountingInformation,
                        &mut accounting as *mut _ as *mut _,
                        size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                        std::ptr::null_mut(),
                    )
                };
                if query_ok == 0 {
                    log::warn!(
                        "failed to query cancelled package-manager job completion: {}",
                        unsafe { GetLastError() }
                    );
                    break;
                }
                if accounting.ActiveProcesses == 0 {
                    break;
                }
                if std::time::Instant::now() >= deadline {
                    log::warn!(
                        "cancelled package-manager job for process {} retained {} process(es) after {:?}",
                        self.pid,
                        accounting.ActiveProcesses,
                        TERMINATION_FENCE_TIMEOUT
                    );
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(1));
            }
        }
    }
}

#[cfg(windows)]
fn terminate_suspended_child(child: &tokio::process::Child) {
    use std::os::windows::io::RawHandle;
    use windows_sys::Win32::Foundation::{GetLastError, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT};
    use windows_sys::Win32::System::Threading::{TerminateProcess, WaitForSingleObject};

    if let Some(raw_handle) = child.raw_handle() {
        let process = raw_handle as RawHandle as HANDLE;
        let pid = child.id().unwrap_or_default();
        if unsafe { TerminateProcess(process, 1) } == 0 {
            log::warn!(
                "failed to terminate suspended package-manager process {}: {}",
                pid,
                unsafe { GetLastError() }
            );
        }
        match unsafe { WaitForSingleObject(process, TERMINATION_FENCE_TIMEOUT.as_millis() as u32) }
        {
            WAIT_OBJECT_0 => {}
            WAIT_TIMEOUT => log::warn!(
                "suspended package-manager process {} did not exit within {:?}",
                pid,
                TERMINATION_FENCE_TIMEOUT
            ),
            _ => log::warn!(
                "failed waiting for suspended package-manager process {}: {}",
                pid,
                unsafe { GetLastError() }
            ),
        }
    }
}

#[cfg(windows)]
impl Drop for WindowsProcessTree {
    fn drop(&mut self) {
        use windows_sys::Win32::Foundation::CloseHandle;
        unsafe {
            CloseHandle(self.process);
            if self.job != 0 {
                CloseHandle(self.job);
            }
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::CommandOutputExt;

    #[tokio::test]
    async fn cancelling_output_terminates_the_owned_process_group_before_returning() {
        use nix::sys::signal::kill;
        use nix::unistd::Pid;

        let temp = tempfile::TempDir::new().unwrap();
        let pid_file = temp.path().join("pids");
        let mutation_file = temp.path().join("late-mutation");
        let script = format!(
            "echo $$ > '{}'; (sleep 0.2; touch '{}') & echo $! >> '{}'; wait",
            pid_file.display(),
            mutation_file.display(),
            pid_file.display()
        );
        let mut command = tokio::process::Command::new("sh");
        command.args(["-c", &script]);
        let task = tokio::spawn(async move { command.output_owned().await });

        let pids = loop {
            if let Ok(contents) = tokio::fs::read_to_string(&pid_file).await {
                let pids: Vec<i32> = contents
                    .lines()
                    .filter_map(|line| line.parse().ok())
                    .collect();
                if pids.len() == 2 {
                    break pids;
                }
            }
            tokio::task::yield_now().await;
        };

        task.abort();
        let _ = task.await;
        assert!(
            kill(Pid::from_raw(pids[0]), None).is_err(),
            "process leader remained alive after cancellation completed"
        );
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        assert!(
            !mutation_file.exists(),
            "cancelled process tree mutated state after cancellation completed"
        );
    }
}
