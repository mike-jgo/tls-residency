// The web app's backup tests (web/test/backup.test.js), ported to the native
// app's own backup and restore (Admin > System). A child of core.rs, so it can
// build a Core the way core's own tests do.
//
// Not ported, as there is nothing native for them to test:
//   - `npm run restore` and "refuses while the server is running": restore is
//     done inside the app. What they protected is still checked: a bad file is
//     refused, and a second app can't open a database another one holds.
//   - "a database under the old name is carried over": the Pi's database was
//     renamed to residency.db long ago, and the native import uses DB_PATH.

use super::*;
use crate::model::Person;

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!("residency-backup-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&p).unwrap();
        Self(p)
    }
    fn config(&self, keep: usize) -> Config {
        Config {
            db_path: self.0.join("residency.db"),
            backup_dir: self.0.join("backups"),
            backup_keep: keep,
            key_file: self.0.join("unused.json"),
            spreadsheet_id: String::new(),
            admin_user: "admin".into(),
            admin_password: "secret".into(),
            dates: dates::Dates::new("Asia/Manila").unwrap(),
            max_session_ms: 36_000_000,
        }
    }
    fn core(&self, keep: usize) -> Arc<Core> {
        let (core, _) = Core::with_sync(self.config(keep), None, false).unwrap();
        core.clock.store(true, Ordering::Relaxed);
        assert!(core.login("admin", "secret"));
        core
    }
    fn backups(&self) -> Vec<String> {
        let mut names: Vec<_> = fs::read_dir(self.0.join("backups"))
            .map(|d| d.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).collect())
            .unwrap_or_default();
        names.sort();
        names
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn person(name: &str, id: &str) -> Person {
    Person { name: name.into(), student_id: id.into(), section: "Web".into(), status: "Regular".into(), telegram: String::new() }
}
/// Ana, with a session on Monday.
fn seed(core: &Core) {
    let id = core.register(person("Ana", "S1"), "111").unwrap();
    let s = core.store.lock().unwrap();
    s.add_event(id, "in", "2026-01-05T01:00:00.000Z", Some("boot-a"), None).unwrap();
    s.add_event(id, "out", "2026-01-05T05:00:00.000Z", Some("boot-a"), None).unwrap();
}
/// Who is in the database, and their taps.
fn snapshot(core: &Core) -> Vec<(String, bool, Vec<(String, String)>)> {
    let s = core.store.lock().unwrap();
    s.users()
        .unwrap()
        .into_iter()
        .map(|u| {
            let events = s.events_for(u.id).unwrap().into_iter().map(|e| (e.kind, e.ts)).collect();
            (u.person.name, u.active, events)
        })
        .collect()
}
fn snapshot_of(path: &Path) -> Vec<(String, Vec<String>)> {
    let db = rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let names: Vec<(i64, String)> = db
        .prepare("SELECT id,name FROM users ORDER BY id")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    names
        .into_iter()
        .map(|(id, name)| {
            let taps = db
                .prepare("SELECT type FROM events WHERE user_id=? ORDER BY id")
                .unwrap()
                .query_map([id], |r| r.get(0))
                .unwrap()
                .collect::<rusqlite::Result<_>>()
                .unwrap();
            (name, taps)
        })
        .collect()
}

#[test]
fn a_backup_restores_the_database_to_exactly_what_it_was() {
    let f = Fixture::new();
    let core = f.core(60);
    seed(&core);
    let backup = core.backup_now().unwrap();
    let before = snapshot(&core);
    assert_eq!(before[0].2.len(), 2);

    // The day goes on, then goes wrong.
    {
        let s = core.store.lock().unwrap();
        let ana = s.by_card("111").unwrap().unwrap();
        s.add_event(ana.id, "in", "2026-01-06T01:00:00.000Z", Some("boot-b"), None).unwrap();
        s.set_active(ana.id, false).unwrap();
    }
    core.register(person("Mistake", "S2"), "222").unwrap();
    assert_ne!(snapshot(&core), before);

    let (users, events, _) = core.restore(&backup).unwrap();
    assert_eq!((users, events), (1, 2));
    assert_eq!(snapshot(&core), before);
}

#[test]
fn the_database_being_replaced_is_set_aside_not_deleted() {
    let f = Fixture::new();
    let core = f.core(60);
    seed(&core);
    let backup = core.backup_now().unwrap();
    core.register(person("Later", "S3"), "333").unwrap();

    let (_, _, set_aside) = core.restore(&backup).unwrap();
    assert_eq!(snapshot(&core).len(), 1);
    // Restoring the wrong backup can be undone: the old database still opens.
    let names: Vec<_> = snapshot_of(&set_aside).into_iter().map(|(n, _)| n).collect();
    assert_eq!(names, ["Ana", "Later"]);
}

#[test]
fn restoring_the_oldest_backup_at_full_retention_keeps_the_source_and_undo_copy() {
    for keep in [1, 3] {
        let f = Fixture::new();
        let core = f.core(keep);
        seed(&core);
        let source = core.backup_now().unwrap();
        for _ in 1..keep {
            core.backup_now().unwrap();
        }
        core.register(person("Later", "S3"), "333").unwrap();
        // Include a redundant path segment, as a typed filename may do.
        let selected = source.parent().unwrap().join(".").join(source.file_name().unwrap());
        let (people, taps, undo) = core.restore(&selected).unwrap();
        assert_eq!((people, taps), (1, 2));
        assert!(source.is_file(), "the selected backup must not be pruned");
        assert_eq!(Store::verify_backup(&undo).unwrap(), (2, 2));
        core.backup_now().unwrap();
        assert_eq!(f.backups().iter().filter(|name| name.ends_with(".db")).count(), keep, "normal retention resumes afterward");
    }
}

#[test]
fn a_damaged_backup_is_refused_and_the_database_is_left_alone() {
    let f = Fixture::new();
    let core = f.core(60);
    seed(&core);
    let before = snapshot(&core);
    let backups = f.backups();

    let bad = f.0.join("bad.db");
    fs::write(&bad, "this is not a database, it only has the right name").unwrap();
    assert!(core.restore(&bad).is_err());
    assert!(core.restore(&f.0.join("missing.db")).is_err());

    assert_eq!(snapshot(&core), before);
    assert_eq!(f.backups(), backups, "no undo backup is made for a restore that never happens");
}

#[test]
fn a_backup_is_a_complete_database_while_the_app_still_has_it_open() {
    let f = Fixture::new();
    let core = f.core(60);
    seed(&core);
    let backup = core.backup_now().unwrap();
    assert_eq!(Store::verify_backup(&backup).unwrap(), (1, 2));
}

#[test]
fn only_the_newest_backups_are_kept() {
    let f = Fixture::new();
    let core = f.core(3); // the startup backup is the first of them
    let mut made = vec![];
    for _ in 0..4 {
        made.push(core.backup_now().unwrap().file_name().unwrap().to_string_lossy().into_owned());
    }
    assert_eq!(f.backups(), made[1..], "the three newest");
}

#[test]
fn a_backup_that_fails_part_way_leaves_nothing_that_looks_like_a_backup() {
    let f = Fixture::new();
    let core = f.core(60);
    // Left over from a backup cut short: not a backup, and never counted as one.
    fs::write(f.0.join("backups/residency-2026-01-05_090000-000000000.db.partial"), "half").unwrap();
    let before = f.backups().iter().filter(|n| n.ends_with(".db")).count();
    // A backup folder that can't be written to (it's a file).
    let broken = Fixture::new();
    fs::write(broken.0.join("backups"), "not a folder").unwrap();
    let (other, _) = Core::with_sync(broken.config(60), None, false).unwrap();
    assert!(other.login("admin", "secret"));
    assert!(other.backup_now().is_err());
    // And retention ignores the leftover.
    core.backup_now().unwrap();
    assert_eq!(f.backups().iter().filter(|n| n.ends_with(".db")).count(), before + 1);
    assert!(f.backups().iter().any(|n| n.ends_with(".partial")));
}

/// Web: "npm run restore refuses while the server is running". Natively, one
/// app owns the database: a second can't open it.
#[test]
fn a_second_app_cannot_open_a_database_another_one_holds() {
    let f = Fixture::new();
    let _core = f.core(60);
    assert!(Store::open(f.0.join("residency.db")).is_err());
}

#[test]
fn backups_made_under_the_old_name_are_still_counted() {
    let f = Fixture::new();
    let core = f.core(2);
    fs::write(f.0.join("backups/attendance-2026-10-01_183044.db"), "x").unwrap();
    let newest = core.backup_now().unwrap();
    // The startup backup, attendance-…, and the new one: the oldest goes.
    let names = f.backups();
    assert!(!names.contains(&"attendance-2026-10-01_183044.db".to_string()), "{names:?}");
    assert!(names.contains(&newest.file_name().unwrap().to_string_lossy().into_owned()));
    assert_eq!(names.len(), 2);
}

/// The sheet is the record, and a sync at startup takes its word over the
/// database's. A restore marks the database as owed to the sheet instead.
#[test]
fn a_restore_makes_the_next_sheet_sync_start_from_the_top() {
    let f = Fixture::new();
    let core = f.core(60);
    seed(&core);
    {
        let s = core.store.lock().unwrap();
        s.set_meta("sync_spreadsheet", "3:abc").unwrap();
        s.set_meta("sync_event_id", "2").unwrap();
    }
    let backup = core.backup_now().unwrap();
    core.restore(&backup).unwrap();
    let s = core.store.lock().unwrap();
    let meta: Vec<_> = ["sync_full", "sync_seed", "sync_event_id"].iter().map(|k| s.meta(k).unwrap().unwrap_or_default()).collect();
    assert_eq!(meta, ["1", "1", "0"]);
}
