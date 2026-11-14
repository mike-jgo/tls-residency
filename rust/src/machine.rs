// The machine the app runs on: which boot this is, whether the clock can be
// trusted yet, and switching off. Mirrors legacy/lib/machine.js, split the same
// way so each part can be tested without the real files and commands.

use crate::{dates, Result};
use std::{
    io::Read,
    path::Path,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

const BOOT_ID_PATH: &str = "/proc/sys/kernel/random/boot_id";
const RTC_DIR: &str = "/sys/class/rtc/rtc0";

/// No real tap can be earlier than this software: a hardware clock that says
/// so restarted from zero (a flat battery).
pub const EARLIEST_MS: i64 = 1_767_225_600_000; // 2026-01-01
/// How far the system clock and the hardware clock may differ and still be
/// "the same time". The hardware clock is read in whole seconds.
pub const RTC_TOLERANCE_MS: i64 = 5000;

/// The kernel's id for this boot. Without it (off Linux) each run is a boot of
/// its own, which is close enough for development.
pub fn read_boot_id(file: &Path) -> String {
    std::fs::read_to_string(file)
        .ok()
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| format!("process-{}", uuid::Uuid::new_v4()))
}
pub fn boot_id() -> String {
    read_boot_id(Path::new(BOOT_ID_PATH))
}

pub fn output(program: &str, args: &[&str], timeout: Duration) -> Result<String> {
    let mut child = Command::new(program)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let start = Instant::now();
    loop {
        if let Some(status) = child.try_wait()? {
            let mut stdout = String::new();
            let mut stderr = String::new();
            if let Some(mut pipe) = child.stdout.take() {
                pipe.read_to_string(&mut stdout)?;
            }
            if let Some(mut pipe) = child.stderr.take() {
                pipe.read_to_string(&mut stderr)?;
            }
            if status.success() {
                return Ok(stdout);
            }
            return Err(if stderr.trim().is_empty() {
                format!("{program} exited with {status}")
            } else {
                stderr.trim().into()
            }
            .into());
        }
        if start.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("{program} timed out").into());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// What the hardware clock says.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rtc {
    /// There is none.
    Absent,
    /// It's there but won't give a time, as a module does when its battery
    /// has run out and it knows its time is no longer valid.
    Unreadable,
    /// Milliseconds since the epoch.
    At(i64),
}
pub fn read_rtc(dir: &Path) -> Rtc {
    match std::fs::read_to_string(dir.join("since_epoch")) {
        Ok(s) => s.trim().parse::<i64>().ok().and_then(|s| s.checked_mul(1000)).map_or(Rtc::Unreadable, Rtc::At),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Rtc::Absent,
        Err(_) => Rtc::Unreadable,
    }
}

/// Whether the hardware clock can be believed: it must be readable, no
/// earlier than the last recorded tap (time doesn't run backwards) or this
/// software, and agree with the system clock, which tap times come from.
pub fn rtc_verdict(rtc: Rtc, now: i64, floor: i64) -> std::result::Result<(), &'static str> {
    match rtc {
        Rtc::Absent => Err("no hardware clock"),
        Rtc::Unreadable => Err("the hardware clock can't be read — its battery may be flat"),
        Rtc::At(time) if time < floor.max(EARLIEST_MS) => {
            Err("the hardware clock is behind the last recorded tap — its battery may be flat")
        }
        Rtc::At(time) if now.abs_diff(time) > RTC_TOLERANCE_MS as u64 => {
            Err("the system clock doesn't match the hardware clock")
        }
        Rtc::At(_) => Ok(()),
    }
}

/// Where a clock that is ready got its time.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    /// Off Linux, or with no way to ask: the host is trusted.
    Host,
    /// Synchronised over the network.
    Network,
    /// A battery-backed hardware clock that checks out.
    Rtc,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClockCheck {
    /// Some(source) once taps can be recorded.
    pub ready: Option<Source>,
    /// Something worth putting in the log, once.
    pub note: Option<String>,
}

/// One look at the clock. `ntp` says whether the network has set it (an error
/// of kind NotFound means there is no timedatectl to ask).
pub fn check_clock(
    linux: bool,
    ntp: impl FnOnce() -> std::io::Result<bool>,
    rtc: impl FnOnce() -> Rtc,
    now: i64,
    floor: i64,
) -> ClockCheck {
    if !linux {
        return ClockCheck { ready: Some(Source::Host), note: None };
    }
    match ntp() {
        // Refusing every tap all day would be worse than trusting an unchecked clock.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return ClockCheck {
                ready: Some(Source::Host),
                note: Some("timedatectl not found; trusting the host clock.".into()),
            };
        }
        Ok(true) => return ClockCheck { ready: Some(Source::Network), note: None },
        _ => {}
    }
    match rtc_verdict(rtc(), now, floor) {
        Ok(()) => ClockCheck { ready: Some(Source::Rtc), note: None },
        Err("no hardware clock") => ClockCheck { ready: None, note: None },
        Err(why) => ClockCheck {
            ready: None,
            note: Some(format!("waiting for the network: not trusting the hardware clock — {why}.")),
        },
    }
}

/// The real check: timedatectl, the kernel's hardware clock, the system time.
pub fn clock_check(floor: i64) -> ClockCheck {
    check_clock(
        cfg!(target_os = "linux"),
        || match output("timedatectl", &["show", "-p", "NTPSynchronized", "--value"], Duration::from_secs(5)) {
            Ok(s) => Ok(s.trim() == "yes"),
            Err(e) => match e.downcast_ref::<std::io::Error>() {
                Some(io) if io.kind() == std::io::ErrorKind::NotFound => {
                    Err(std::io::Error::from(std::io::ErrorKind::NotFound))
                }
                _ => Ok(false),
            },
        },
        || read_rtc(Path::new(RTC_DIR)),
        dates::millis(&dates::now()).unwrap_or(0),
        floor,
    )
}

pub fn shutdown() -> Result<()> {
    if cfg!(target_os = "linux") {
        output(
            "sudo",
            &["-n", "/usr/bin/systemctl", "poweroff"],
            Duration::from_secs(15),
        )?;
    } else {
        println!("Not on Linux: shutdown was requested but the computer was not powered off.");
    }
    Ok(())
}

// legacy/test/machine.test.js, ported. The web's polling loop lives in core.rs
// natively (a thread that checks every two seconds until ready, then stops),
// so its two async tests become single checks here.
#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{TimeZone, Utc};
    use std::io;

    fn temp(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("tls-machine-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
    fn ms(y: i32, m: u32, d: u32, h: u32) -> i64 {
        Utc.with_ymd_and_hms(y, m, d, h, 0, 0).unwrap().timestamp_millis()
    }
    const NOT_FOUND: fn() -> io::Result<bool> = || Err(io::Error::from(io::ErrorKind::NotFound));
    fn now() -> i64 {
        ms(2026, 10, 5, 1) // Monday morning
    }
    fn last_tap() -> i64 {
        ms(2026, 10, 2, 10) // Friday evening
    }
    fn good() -> Rtc {
        Rtc::At(now())
    }

    #[test]
    fn the_boot_id_is_read_from_the_kernel_file() {
        let dir = temp("boot");
        let file = dir.join("boot_id");
        std::fs::write(&file, "f3c1e2d4-0000-4000-8000-000000000001\n").unwrap();
        assert_eq!(read_boot_id(&file), "f3c1e2d4-0000-4000-8000-000000000001");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn without_the_kernel_file_each_run_gets_a_boot_id_of_its_own() {
        let a = read_boot_id(Path::new("/nonexistent/boot_id"));
        let b = read_boot_id(Path::new("/nonexistent/boot_id"));
        assert!(a.starts_with("process-"));
        assert_ne!(a, b);
    }

    #[test]
    fn off_linux_the_clock_is_ready_from_the_start() {
        let check = check_clock(false, || panic!("should not ask"), || panic!("should not read"), 0, 0);
        assert_eq!(check.ready, Some(Source::Host));
    }

    #[test]
    fn on_linux_taps_wait_until_the_clock_has_synced() {
        let waiting = check_clock(true, || Ok(false), || Rtc::Absent, now(), last_tap());
        assert_eq!(waiting, ClockCheck { ready: None, note: None });
        let synced = check_clock(true, || Ok(true), || Rtc::Absent, now(), last_tap());
        assert_eq!(synced.ready, Some(Source::Network));
    }

    #[test]
    fn if_timedatectl_is_missing_the_clock_is_trusted_rather_than_blocking_all_day() {
        let check = check_clock(true, NOT_FOUND, || Rtc::Absent, now(), last_tap());
        assert_eq!(check.ready, Some(Source::Host));
        assert!(check.note.unwrap().contains("timedatectl not found"));
    }

    // ---- A battery-backed clock (RTC) --------------------------------------
    // Tested against simulated readings. What a real module reports,
    // especially with a flat battery, still has to be checked on the hardware.

    #[test]
    fn a_hardware_clock_that_agrees_with_the_system_clock_is_believed() {
        assert_eq!(rtc_verdict(good(), now(), last_tap()), Ok(()));
        // Read in whole seconds, so a little apart is still the same time.
        assert_eq!(rtc_verdict(good(), now() + RTC_TOLERANCE_MS, last_tap()), Ok(()));
    }

    #[test]
    fn no_hardware_clock_means_waiting_for_the_network_as_before() {
        assert!(rtc_verdict(Rtc::Absent, now(), 0).is_err());
    }

    #[test]
    fn a_hardware_clock_that_cannot_be_read_is_not_believed() {
        assert!(rtc_verdict(Rtc::Unreadable, now(), 0).unwrap_err().contains("battery"));
    }

    /// A flat battery: the module restarts from its own year zero, and the
    /// kernel sets the system clock to match, so the two agree, and both are wrong.
    #[test]
    fn a_hardware_clock_that_restarted_from_zero_is_not_believed_even_though_the_system_agrees_with_it() {
        let y2000 = Utc.with_ymd_and_hms(2000, 1, 1, 0, 3, 0).unwrap().timestamp_millis();
        for reset in [0, y2000] {
            assert!(rtc_verdict(Rtc::At(reset), reset, last_tap()).is_err());
        }
        // Even with an empty database there is a floor: this software's own age.
        assert!(rtc_verdict(Rtc::At(0), 0, 0).is_err());
    }

    /// Time doesn't run backwards.
    #[test]
    fn a_hardware_clock_behind_the_last_recorded_tap_is_not_believed() {
        let behind = last_tap() - 60_000;
        assert!(rtc_verdict(Rtc::At(behind), behind, last_tap()).unwrap_err().contains("behind the last recorded tap"));
    }

    /// Tap times come from the system clock. If it was set from somewhere else,
    /// a correct hardware clock doesn't make it right.
    #[test]
    fn a_hardware_clock_the_system_clock_does_not_match_is_not_believed() {
        let off = rtc_verdict(good(), now() - 15 * 3_600_000, last_tap());
        assert!(off.unwrap_err().contains("doesn't match"));
    }

    #[test]
    fn with_a_good_hardware_clock_taps_start_without_any_network() {
        let check = check_clock(true, || Ok(false), good, now(), last_tap());
        assert_eq!(check.ready, Some(Source::Rtc));
    }

    #[test]
    fn with_a_flat_hardware_clock_taps_still_wait_for_the_network_and_the_log_says_why() {
        let y2000 = Utc.with_ymd_and_hms(2000, 1, 1, 0, 0, 0).unwrap().timestamp_millis();
        let check = check_clock(true, || Ok(false), || Rtc::At(y2000), y2000, last_tap());
        assert_eq!(check.ready, None);
        assert!(check.note.unwrap().contains("not trusting the hardware clock"));
        let then = check_clock(true, || Ok(true), || Rtc::At(y2000), y2000, last_tap());
        assert_eq!(then.ready, Some(Source::Network));
    }

    #[test]
    fn the_network_setting_the_clock_wins_over_a_hardware_clock() {
        assert_eq!(check_clock(true, || Ok(true), good, now(), last_tap()).ready, Some(Source::Network));
    }

    #[test]
    fn the_hardware_clock_is_read_from_the_kernels_file() {
        let dir = temp("rtc");
        std::fs::write(dir.join("since_epoch"), "1791162000\n").unwrap();
        assert_eq!(read_rtc(&dir), Rtc::At(1_791_162_000_000));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn no_rtc_directory_means_no_hardware_clock() {
        assert_eq!(read_rtc(&std::env::temp_dir().join("no-such-rtc")), Rtc::Absent);
    }

    #[test]
    fn an_rtc_whose_time_cannot_be_read_is_present_but_unreadable() {
        let dir = temp("rtc-dir");
        // Reading it fails, as a module refusing to give a time does.
        std::fs::create_dir_all(dir.join("since_epoch")).unwrap();
        assert_eq!(read_rtc(&dir), Rtc::Unreadable);
        let _ = std::fs::remove_dir_all(dir);
    }
}
