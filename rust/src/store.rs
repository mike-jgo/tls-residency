use crate::{
    dates,
    model::{self, Event, Person, ReportRow, User},
    Result,
};
use rusqlite::{params, Connection, OptionalExtension, Row};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    time::Duration,
};

pub struct Store {
    pub(crate) db: Connection,
    pub path: PathBuf,
}

fn user(row: &Row<'_>) -> rusqlite::Result<User> {
    let field = |name| {
        row.get::<_, Option<String>>(name)
            .map(Option::unwrap_or_default)
    };
    Ok(User {
        id: row.get("id")?,
        person: Person {
            name: row.get("name")?,
            student_id: field("student_id")?,
            section: field("section")?,
            status: field("status")?,
            telegram: field("telegram")?,
        },
        rfid: row.get("rfid")?,
        active: row.get::<_, i64>("active")? != 0,
        created_at: row.get("created_at")?,
    })
}
fn event(row: &Row<'_>) -> rusqlite::Result<Event> {
    Ok(Event {
        id: row.get("id")?,
        user_id: row.get("user_id")?,
        kind: row.get("type")?,
        ts: row.get("ts")?,
        boot_id: row.get("boot_id")?,
        request_id: row.get("request_id")?,
    })
}

impl Store {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref();
        if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
            std::fs::create_dir_all(parent)?;
        }
        let db = Connection::open(path)?;
        Self::initialize(db, path.to_path_buf(), true)
    }
    pub fn memory() -> Result<Self> {
        Self::initialize(Connection::open_in_memory()?, PathBuf::new(), false)
    }
    fn initialize(db: Connection, path: PathBuf, exclusive: bool) -> Result<Self> {
        db.busy_timeout(Duration::from_secs(5))?;
        db.pragma_update(None, "journal_mode", "WAL")?;
        db.pragma_update(None, "foreign_keys", true)?;
        if exclusive {
            db.pragma_update(None, "locking_mode", "EXCLUSIVE")?;
        }
        db.execute_batch("BEGIN IMMEDIATE;
          CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,student_id TEXT,
            section TEXT,status TEXT,telegram TEXT,rfid TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1);
          CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,
            type TEXT NOT NULL CHECK(type IN ('in','out')),ts TEXT NOT NULL,boot_id TEXT,request_id TEXT,
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE);
          CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS native_pending_taps(rfid TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE);
          COMMIT;")?;
        Self::migrate(&db)?;
        Ok(Self { db, path })
    }
    fn migrate(db: &Connection) -> Result<()> {
        for (table, columns) in [
            (
                "users",
                vec![
                    ("student_id", "TEXT"),
                    ("section", "TEXT"),
                    ("status", "TEXT"),
                    ("telegram", "TEXT"),
                    ("active", "INTEGER NOT NULL DEFAULT 1"),
                ],
            ),
            ("events", vec![("boot_id", "TEXT"), ("request_id", "TEXT")]),
        ] {
            let existing = db
                .prepare(&format!("PRAGMA table_info({table})"))?
                .query_map([], |r| r.get::<_, String>(1))?
                .collect::<rusqlite::Result<HashSet<_>>>()?;
            for (name, kind) in columns {
                if !existing.contains(name) {
                    db.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {name} {kind}"))?;
                }
            }
        }
        db.execute_batch("CREATE INDEX IF NOT EXISTS idx_events_user_ts ON events(user_id,ts);
          CREATE INDEX IF NOT EXISTS idx_events_user_id ON events(user_id,id);
          CREATE UNIQUE INDEX IF NOT EXISTS idx_events_request ON events(request_id) WHERE request_id IS NOT NULL;")?;
        Ok(())
    }
    pub fn transaction<T>(&self, work: impl FnOnce(&Self) -> Result<T>) -> Result<T> {
        let tx = self.db.unchecked_transaction()?;
        let result = work(self)?;
        tx.commit()?;
        Ok(result)
    }
    pub fn users(&self) -> Result<Vec<User>> {
        Ok(self
            .db
            .prepare("SELECT * FROM users ORDER BY name COLLATE NOCASE")?
            .query_map([], user)?
            .collect::<rusqlite::Result<_>>()?)
    }
    pub fn user(&self, id: i64) -> Result<Option<User>> {
        Ok(self
            .db
            .query_row("SELECT * FROM users WHERE id=?", [id], user)
            .optional()?)
    }
    pub fn by_card(&self, card: &str) -> Result<Option<User>> {
        Ok(self
            .db
            .query_row("SELECT * FROM users WHERE rfid=?", [card], user)
            .optional()?)
    }
    pub fn check_person(&self, p: &Person, own: Option<i64>) -> Result<()> {
        if self
            .users()?
            .iter()
            .any(|u| Some(u.id) != own && u.person.student_id == p.student_id)
        {
            return Err("That ID number already belongs to another person.".into());
        }
        Ok(())
    }
    pub fn create(&self, p: &Person, card: &str, active: bool) -> Result<i64> {
        self.db.execute("INSERT INTO users(name,student_id,section,status,telegram,rfid,active,created_at) VALUES(?,?,?,?,?,?,?,?)",
            params![p.name,p.student_id,p.section,p.status,p.telegram,card,active,dates::now()])?;
        Ok(self.db.last_insert_rowid())
    }
    pub fn update(&self, id: i64, p: &Person) -> Result<()> {
        self.db.execute(
            "UPDATE users SET name=?,student_id=?,section=?,status=?,telegram=? WHERE id=?",
            params![p.name, p.student_id, p.section, p.status, p.telegram, id],
        )?;
        Ok(())
    }
    pub fn set_active(&self, id: i64, active: bool) -> Result<()> {
        self.db
            .execute("UPDATE users SET active=? WHERE id=?", params![active, id])?;
        Ok(())
    }
    pub fn set_card(&self, id: i64, card: &str) -> Result<()> {
        self.db
            .execute("UPDATE users SET rfid=? WHERE id=?", params![card, id])?;
        Ok(())
    }
    pub fn delete_unlisted(&self, id: i64) -> Result<()> {
        self.db.execute(
            "DELETE FROM users WHERE id=? AND NOT EXISTS(SELECT 1 FROM events WHERE user_id=?)",
            params![id, id],
        )?;
        Ok(())
    }
    pub fn events(&self) -> Result<Vec<Event>> {
        Ok(self
            .db
            .prepare("SELECT * FROM events ORDER BY id")?
            .query_map([], event)?
            .collect::<rusqlite::Result<_>>()?)
    }
    pub fn events_for(&self, id: i64) -> Result<Vec<Event>> {
        Ok(self
            .db
            .prepare("SELECT * FROM events WHERE user_id=? ORDER BY id")?
            .query_map([id], event)?
            .collect::<rusqlite::Result<_>>()?)
    }
    pub fn last_event(&self, id: i64) -> Result<Option<Event>> {
        Ok(self
            .db
            .query_row(
                "SELECT * FROM events WHERE user_id=? ORDER BY id DESC LIMIT 1",
                [id],
                event,
            )
            .optional()?)
    }
    pub fn receipt(&self, id: &str) -> Result<Option<Event>> {
        Ok(self
            .db
            .query_row("SELECT * FROM events WHERE request_id=?", [id], event)
            .optional()?)
    }
    pub fn add_event(
        &self,
        user_id: i64,
        kind: &str,
        ts: &str,
        boot_id: Option<&str>,
        request_id: Option<&str>,
    ) -> Result<i64> {
        self.db.execute(
            "INSERT INTO events(user_id,type,ts,boot_id,request_id) VALUES(?,?,?,?,?)",
            params![user_id, kind, ts, boot_id, request_id],
        )?;
        Ok(self.db.last_insert_rowid())
    }
    pub fn replace_events(&self, events: &[Event]) -> Result<()> {
        self.db.execute_batch(
            "DELETE FROM events; DELETE FROM sqlite_sequence WHERE name='events';",
        )?;
        for e in events {
            self.db.execute(
                "INSERT INTO events(id,user_id,type,ts,boot_id,request_id) VALUES(?,?,?,?,?,?)",
                params![
                    (e.id > 0).then_some(e.id),
                    e.user_id,
                    e.kind,
                    e.ts,
                    e.boot_id,
                    e.request_id
                ],
            )?;
        }
        Ok(())
    }
    pub fn pending_receipt(&self, card: &str) -> Result<String> {
        self.db.execute("INSERT INTO native_pending_taps(rfid,request_id) VALUES(?,?) ON CONFLICT(rfid) DO NOTHING",params![card,uuid::Uuid::new_v4().to_string()])?;
        Ok(self.db.query_row(
            "SELECT request_id FROM native_pending_taps WHERE rfid=?",
            [card],
            |r| r.get(0),
        )?)
    }
    pub fn acknowledge(&self, card: &str, request_id: &str) -> Result<()> {
        self.db.execute(
            "DELETE FROM native_pending_taps WHERE rfid=? AND request_id=?",
            params![card, request_id],
        )?;
        Ok(())
    }
    pub fn pending_cards(&self) -> Result<Vec<String>> {
        Ok(self
            .db
            .prepare("SELECT rfid FROM native_pending_taps")?
            .query_map([], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?)
    }
    pub fn meta(&self, key: &str) -> Result<Option<String>> {
        Ok(self
            .db
            .query_row("SELECT value FROM meta WHERE key=?", [key], |r| r.get(0))
            .optional()?)
    }
    pub fn set_meta(&self, key: &str, value: &str) -> Result<()> {
        self.db.execute("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![key,value])?;
        Ok(())
    }
    pub fn watermark(&self) -> Result<i64> {
        Ok(self
            .meta("sync_event_id")?
            .and_then(|v| v.parse().ok())
            .unwrap_or(0))
    }
    pub fn last_id(&self) -> Result<i64> {
        Ok(self
            .db
            .query_row("SELECT COALESCE(MAX(id),0) FROM events", [], |r| r.get(0))?)
    }
    pub fn sync_counts(&self) -> Result<(usize, usize)> {
        let mark = self.watermark()?;
        Ok(self.db.query_row(
            "SELECT (SELECT COUNT(*) FROM events WHERE id <= ?1),
                    (SELECT COUNT(*) FROM events WHERE id > ?1)",
            [mark],
            |r| Ok((r.get::<_, i64>(0)? as usize, r.get::<_, i64>(1)? as usize)),
        )?)
    }
    pub fn last_time(&self) -> Result<Option<String>> {
        Ok(self
            .db
            .query_row("SELECT MAX(ts) FROM events", [], |r| r.get(0))?)
    }
    pub fn currently_in(&self, boot: &str) -> Result<Vec<(User, String)>> {
        Ok(self.db.prepare("SELECT u.*,e.ts AS since FROM users u JOIN events e ON e.id=(SELECT id FROM events WHERE user_id=u.id ORDER BY id DESC LIMIT 1)
            WHERE e.type='in' AND e.boot_id=? AND u.active=1 ORDER BY e.ts DESC")?
            .query_map([boot],|r|Ok((user(r)?,r.get("since")?)))?.collect::<rusqlite::Result<_>>()?)
    }
    pub fn report(
        &self,
        boot: &str,
        max_ms: i64,
        start: Option<&str>,
        end: Option<&str>,
    ) -> Result<Vec<ReportRow>> {
        // Each check-in pairs with its immediate successor in ledger order.
        // Keep that successor even outside the range (e.g. a month-end checkout).
        // Only the requested check-ins are loaded, in one query for all people.
        let sql = format!(
            "SELECT u.*, e.id AS in_id, e.ts AS in_ts, e.boot_id AS in_boot,
                    n.id AS next_id, n.type AS next_type, n.ts AS next_ts, n.boot_id AS next_boot
             FROM users u
             LEFT JOIN events e ON e.user_id=u.id AND e.type='in'
                 {} {}
             LEFT JOIN events n ON n.id=(SELECT id FROM events
                 WHERE user_id=u.id AND id > e.id ORDER BY id LIMIT 1)
             WHERE COALESCE(u.status,'') != 'Dummy'
             ORDER BY u.name COLLATE NOCASE, u.id, e.id",
            if start.is_some() { "AND e.ts >= ?1" } else { "AND ?1 IS NULL" },
            if end.is_some() { "AND e.ts < ?2" } else { "AND ?2 IS NULL" },
        );
        let mut statement = self.db.prepare(&sql)?;
        let mut records = statement.query(params![start, end])?;
        let mut grouped: Vec<(User, Vec<model::Session>)> = vec![];
        while let Some(record) = records.next()? {
            let u = user(record)?;
            if grouped.last().is_none_or(|(last, _)| last.id != u.id) {
                grouped.push((u, vec![]));
            }
            if let Some(id) = record.get::<_, Option<i64>>("in_id")? {
                let mut pair = vec![Event {
                    id, user_id: grouped.last().unwrap().0.id, kind: "in".into(),
                    ts: record.get("in_ts")?, boot_id: record.get("in_boot")?, request_id: None,
                }];
                if let Some(id) = record.get::<_, Option<i64>>("next_id")? {
                    pair.push(Event {
                        id, user_id: pair[0].user_id, kind: record.get("next_type")?,
                        ts: record.get("next_ts")?, boot_id: record.get("next_boot")?, request_id: None,
                    });
                }
                grouped.last_mut().unwrap().1.push(model::sessions(&pair, boot, max_ms).remove(0));
            }
        }
        let mut rows = vec![];
        for (u, selected) in grouped {
            rows.push(ReportRow {
                user_id: u.id,
                name: u.person.name,
                student_id: u.person.student_id,
                section: u.person.section,
                status: u.person.status,
                active: u.active,
                hours: (selected.iter().map(|s| s.ms).sum::<i64>() as f64 / 3_600_000.0 * 100.0)
                    .round()
                    / 100.0,
                sessions: selected.iter().filter(|s| !s.open && !s.invalid).count(),
                open: u.active && selected.iter().any(|s| s.open && !s.invalid),
                any: !selected.is_empty(),
                uncounted: selected.into_iter().filter(|s| s.invalid).collect(),
            });
        }
        Ok(rows)
    }
    pub fn backup(&self, destination: &Path) -> Result<()> {
        if destination.exists() {
            return Err("A file already exists at that backup path.".into());
        }
        self.db.backup(
            rusqlite::MAIN_DB,
            destination,
            None::<fn(rusqlite::backup::Progress)>,
        )?;
        Ok(())
    }
    pub fn verify_backup(path: &Path) -> Result<(i64, i64)> {
        let db = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        let check: String = db.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
        if check != "ok" {
            return Err("The backup failed SQLite's integrity check.".into());
        }
        db.prepare("SELECT id,name,rfid,created_at FROM users LIMIT 0")?;
        db.prepare("SELECT id,user_id,type,ts FROM events LIMIT 0")?;
        let invalid:i64=db.query_row("SELECT COUNT(*) FROM events e LEFT JOIN users u ON u.id=e.user_id WHERE u.id IS NULL OR e.type NOT IN ('in','out')",[],|r|r.get(0))?;
        if invalid > 0 {
            return Err("The backup contains invalid attendance entries.".into());
        }
        Ok((
            db.query_row("SELECT COUNT(*) FROM users", [], |r| r.get(0))?,
            db.query_row("SELECT COUNT(*) FROM events", [], |r| r.get(0))?,
        ))
    }
    pub fn restore(&mut self, path: &Path) -> Result<(i64, i64)> {
        let counts = Self::verify_backup(path)?;
        // Copy into the live connection, not over its file, so its WAL and
        // exclusive ownership remain valid. The caller first makes an undo backup.
        let source = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        let backup = rusqlite::backup::Backup::new(&source, &mut self.db)?;
        backup.run_to_completion(128, Duration::from_millis(10), None)?;
        drop(backup);
        self.db.execute_batch("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS native_pending_taps(rfid TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE);")?;
        Self::migrate(&self.db)?;
        for (key, value) in [
            ("sync_full", "1"),
            ("sync_seed", "1"),
            ("sync_event_id", "0"),
        ] {
            self.set_meta(key, value)?;
        }
        Ok(counts)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn p() -> Person {
        Person {
            name: "Ana".into(),
            student_id: "001".into(),
            section: "Web".into(),
            status: "Regular".into(),
            telegram: String::new(),
        }
    }
    #[test]
    fn ledger_is_atomic_and_receipts_are_unique() {
        let store = Store::memory().unwrap();
        let id = store.create(&p(), "0001", true).unwrap();
        store
            .add_event(
                id,
                "in",
                "2026-01-05T01:00:00.000Z",
                Some("boot"),
                Some("receipt"),
            )
            .unwrap();
        assert!(store
            .transaction(|s| {
                s.set_active(id, false)?;
                s.add_event(
                    id,
                    "out",
                    "2026-01-05T02:00:00.000Z",
                    Some("boot"),
                    Some("receipt"),
                )?;
                Ok(())
            })
            .is_err());
        assert!(store.user(id).unwrap().unwrap().active);
        assert_eq!(store.events().unwrap().len(), 1);
    }
    #[test]
    fn report_and_presence_obey_deactivation_and_boot() {
        let store = Store::memory().unwrap();
        let id = store.create(&p(), "0001", true).unwrap();
        store
            .add_event(id, "in", "2026-01-05T01:00:00.000Z", Some("a"), None)
            .unwrap();
        assert_eq!(store.currently_in("a").unwrap().len(), 1);
        assert!(store.currently_in("b").unwrap().is_empty());
        let report = store.report("b", 36_000_000, None, None).unwrap();
        assert_eq!(report[0].uncounted.len(), 1);
        assert_eq!(report[0].hours, 0.0);
        store.set_active(id, false).unwrap();
        assert!(store.currently_in("a").unwrap().is_empty());
        assert_eq!(store.events().unwrap().len(), 1);
    }
    #[test]
    fn pending_receipt_is_reused_until_acknowledged() {
        let store = Store::memory().unwrap();
        let receipt = store.pending_receipt("0001").unwrap();
        assert_eq!(store.pending_receipt("0001").unwrap(), receipt);
        store.acknowledge("0001", "wrong").unwrap();
        assert_eq!(store.pending_cards().unwrap(), ["0001"]);
        store.acknowledge("0001", &receipt).unwrap();
        assert!(store.pending_cards().unwrap().is_empty());
    }

    #[test]
    fn range_query_matches_full_history_sessions_including_boundary_checkouts() {
        let store = Store::memory().unwrap();
        let id = store.create(&p(), "1", true).unwrap();
        // Historical checkout, abandoned arrival, overlong session, reversed
        // clock, and a session spanning the requested upper boundary.
        for (kind, ts, boot) in [
            ("in", "2025-12-31T23:00:00.000Z", "old"),
            ("out", "2026-01-01T01:00:00.000Z", "old"),
            ("in", "2026-01-05T01:00:00.000Z", "old"),
            ("in", "2026-01-06T01:00:00.000Z", "boot"),
            ("out", "2026-01-07T01:00:00.000Z", "boot"),
            ("in", "2026-01-08T02:00:00.000Z", "boot"),
            ("out", "2026-01-08T01:00:00.000Z", "boot"),
            ("in", "2026-01-31T23:00:00.000Z", "boot"),
            ("out", "2026-02-01T01:00:00.000Z", "boot"),
            ("in", "2026-02-02T01:00:00.000Z", "boot"),
        ] { store.add_event(id, kind, ts, Some(boot), None).unwrap(); }
        store.create(&Person { name: "No taps".into(), student_id: "2".into(), ..p() }, "2", false).unwrap();
        for (start, end) in [
            (None, None),
            (Some("2026-01-01T00:00:00.000Z"), Some("2026-02-01T00:00:00.000Z")),
            (Some("2026-02-01T00:00:00.000Z"), None),
            (None, Some("2026-01-01T00:00:00.000Z")),
        ] {
            let report = store.report("boot", 36_000_000, start, end).unwrap();
            for row in report {
                let expected: Vec<_> = model::sessions(&store.events_for(row.user_id).unwrap(), "boot", 36_000_000)
                    .into_iter().filter(|s| start.is_none_or(|a| s.in_at.as_str() >= a)
                        && end.is_none_or(|b| s.in_at.as_str() < b)).collect();
                assert_eq!(row.hours, (expected.iter().map(|s| s.ms).sum::<i64>() as f64 / 36_000.0).round() / 100.0);
                assert_eq!(row.sessions, expected.iter().filter(|s| !s.open && !s.invalid).count());
                assert_eq!(row.any, !expected.is_empty());
                assert_eq!(row.open, row.active && expected.iter().any(|s| s.open && !s.invalid));
                assert_eq!(row.uncounted, expected.into_iter().filter(|s| s.invalid).collect::<Vec<_>>());
            }
        }
    }

    #[test]
    fn sync_counts_use_rows_instead_of_assuming_contiguous_event_ids() {
        let store = Store::memory().unwrap();
        let id = store.create(&p(), "1", true).unwrap();
        for _ in 0..3 { store.add_event(id, "in", "2026-01-01T00:00:00.000Z", Some("boot"), None).unwrap(); }
        store.db.execute("DELETE FROM events WHERE id=2", []).unwrap();
        store.set_meta("sync_event_id", "2").unwrap();
        assert_eq!(store.sync_counts().unwrap(), (1, 1));
        store.set_meta("sync_event_id", "99").unwrap();
        assert_eq!(store.sync_counts().unwrap(), (2, 0));
    }
}
