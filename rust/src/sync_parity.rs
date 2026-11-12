// The web app's sync tests (web/test/sync.test.js), ported to the native sync
// engine, against the stand-in sheet in test_support.rs. Names follow the web
// file's, in the same sections.
//
// How they map:
//   - Each web `syncer(...)` is a new process: here, a fresh `Sync` over the
//     same database and sheet, its clock pinned to the moment given.
//   - A sheet the test hasn't synced with yet is treated as a restored backup
//     on first use, exactly as the web helper does.
//   - The web fake's `writes`/`styled`/`shaped`/`fitted`/`views` are read from
//     the batch requests the native engine sends (test_support.rs).
//   - Wording of error messages differs between the apps; the tests check
//     the part that matters (who, which row) rather than the sentence.
//
// Scheduler retry, clock gating and in-flight taps are tested in core.rs.

use crate::{
    dates::{self, Dates},
    model::{Person, User},
    roster,
    sheets,
    store::Store,
    sync::Sync,
    test_support::Fake,
};
use chrono::{TimeZone, Utc};
use serde_json::{json, Value};
use std::{collections::HashMap, sync::Mutex};

const BOOT: &str = "boot-today";
const TAPS: [&str; 6] = ["Tap #", "Date", "Time", "Name", "Student ID", "Direction"];

/// Manila is UTC+8: 09:00 there is 01:00Z.
fn at(y: i32, m: u32, d: u32, h: i64, min: i64) -> String {
    let midnight = Utc.with_ymd_and_hms(y, m, d, 0, 0, 0).unwrap().timestamp_millis();
    dates::iso(Utc.timestamp_millis_opt(midnight + (h - 8) * 3_600_000 + min * 60_000).unwrap())
}
fn manila() -> Dates {
    Dates::new("Asia/Manila").unwrap()
}

struct World {
    store: Mutex<Store>,
    cards: u32,
}
struct Sheet {
    fake: Fake,
    id: String,
    begun: bool,
}

impl World {
    fn new() -> Self {
        Self { store: Mutex::new(Store::memory().unwrap()), cards: 0 }
    }
    fn s(&self) -> std::sync::MutexGuard<'_, Store> {
        self.store.lock().unwrap()
    }
    fn person(&mut self, name: &str) -> User {
        self.cards += 1;
        let card = (5000 + self.cards).to_string();
        let id = self
            .s()
            .create(&Person { name: name.into(), student_id: format!("S{}", self.cards), ..Person::default() }, &card, true)
            .unwrap();
        self.s().user(id).unwrap().unwrap()
    }
    /// A person with every detail filled, as the web `details()` gives.
    fn staffer(&mut self, name: &str, id: &str) -> User {
        let u = self.person(name);
        self.s().update(u.id, &details(name, id)).unwrap();
        self.s().user(u.id).unwrap().unwrap()
    }
    fn tap_at(&self, user: &User, kind: &str, iso: &str) -> i64 {
        self.tap_at_boot(user, kind, iso, BOOT)
    }
    fn tap_at_boot(&self, user: &User, kind: &str, iso: &str, boot: &str) -> i64 {
        self.s().add_event(user.id, kind, iso, Some(boot), None).unwrap()
    }
    /// What a restored backup leaves: the database is owed to the sheet whole.
    fn restored(&self) {
        let s = self.s();
        s.set_meta("sync_full", "1").unwrap();
        s.set_meta("sync_seed", "1").unwrap();
        s.set_meta("sync_event_id", "0").unwrap();
    }
    /// A new process syncing with `sheet`, at `now`.
    fn syncer(&self, sheet: &mut Sheet, now: &str) -> Sync {
        if !sheet.begun {
            sheet.begun = true;
            self.restored();
        }
        let mut sync = Sync::new(&sheet.id, Box::new(sheet.fake.clone()));
        let now = now.to_string();
        sync.clock = Box::new(move || now.clone());
        sync
    }
    fn run(&self, sync: &mut Sync) -> Result<(), sheets::Error> {
        self.run_boot(sync, BOOT)
    }
    fn run_boot(&self, sync: &mut Sync, boot: &str) -> Result<(), sheets::Error> {
        sync.run(&self.store, boot, manila())
    }
    /// Sync once with a new process, as most web tests do.
    fn sync_at(&self, sheet: &mut Sheet, now: &str) -> Sync {
        let mut sync = self.syncer(sheet, now);
        self.run(&mut sync).unwrap();
        sync
    }
    fn pending(&self) -> usize {
        let s = self.s();
        let mark = s.watermark().unwrap();
        s.events().unwrap().iter().filter(|e| e.id > mark).count()
    }
    fn taps(&self) -> Vec<(i64, String, String, String)> {
        let s = self.s();
        s.events()
            .unwrap()
            .into_iter()
            .map(|e| (e.id, s.user(e.user_id).unwrap().unwrap().person.name, e.kind, e.ts))
            .collect()
    }
    fn names(&self) -> Vec<String> {
        self.s().users().unwrap().into_iter().map(|u| u.person.name).collect()
    }
    fn user(&self, id: i64) -> Option<User> {
        self.s().user(id).unwrap()
    }
}

static SHEETS: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
fn fake_sheet() -> Sheet {
    let n = SHEETS.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
    Sheet { fake: Fake::default(), id: format!("sheet-{n}"), begun: false }
}
/// A spreadsheet as another device left it.
fn left_by(staffers: &[[&str; 7]], logs: &[(&str, Vec<Vec<Value>>)]) -> Sheet {
    let mut sheet = fake_sheet();
    sheet.begun = true;
    let mut rows = vec![sheets::strings(&roster::HEADER)];
    rows.extend(staffers.iter().map(|r| sheets::strings(r)));
    sheet.fake.tab("Staffers", rows);
    for (title, taps) in logs {
        let mut rows = vec![sheets::strings(&TAPS)];
        rows.extend(taps.iter().cloned());
        sheet.fake.tab(title, rows);
    }
    sheet
}
const PIA: [&str; 7] = ["Pia Pull", "P-pia", "Web", "Regular", "@pia", "", "990001"];
fn tap_row(n: Value, date: &str, time: &str, name: &str, id: &str, dir: &str) -> Vec<Value> {
    vec![n, json!(date), json!(time), json!(name), json!(id), json!(dir)]
}
fn details(name: &str, id: &str) -> Person {
    Person {
        name: name.into(),
        student_id: id.into(),
        section: "A&G".into(),
        status: "Probie".into(),
        telegram: format!("@{}", id.replace('-', "_")),
    }
}

// ---- Reading the stand-in sheet ------------------------------------------

fn num(v: &Option<Value>) -> f64 {
    v.as_ref().and_then(|v| v.as_f64().or_else(|| v.as_str().and_then(|s| s.parse().ok()))).unwrap_or(f64::NAN)
}
fn text(v: &Option<Value>) -> String {
    match v {
        Some(Value::String(s)) => s.clone(),
        Some(v) => v.to_string(),
        None => String::new(),
    }
}
impl Sheet {
    fn ids(&self, title: &str) -> Vec<i64> {
        self.fake.column(title, 'A').iter().map(|v| num(v) as i64).collect()
    }
    fn texts(&self, title: &str, col: char) -> Vec<String> {
        self.fake.column(title, col).iter().map(text).collect()
    }
    fn cell(&self, title: &str, at: &str) -> String {
        text(&self.fake.cell(title, at))
    }
    /// A table's hours by name: column A names, column C hours.
    fn hours(&self, title: &str) -> HashMap<String, f64> {
        let names = self.fake.column(title, 'A');
        let hours = self.fake.column(title, 'C');
        names.iter().zip(hours.iter()).map(|(n, h)| (text(n), num(h))).collect()
    }
    fn has(&self, title: &str) -> bool {
        self.fake.has(title)
    }
    fn staff_row(&self, id: &str) -> usize {
        self.texts("Staffers", 'B').iter().position(|b| b == id).unwrap() + 2
    }
    fn staff_cells(&self, id: &str) -> Vec<String> {
        let row = self.staff_row(id);
        "ABCDEFG".chars().map(|c| self.cell("Staffers", &format!("{c}{row}"))).collect()
    }
    fn set(&self, title: &str, at: &str, v: Value) {
        self.fake.set(title, at, v);
    }
    fn clears(&self) -> Vec<String> {
        self.fake.0.lock().unwrap().clears.clone()
    }
    fn writes(&self) -> usize {
        self.fake.0.lock().unwrap().writes.len()
    }
    fn styled(&self, title: &str) -> usize {
        self.fake.id_of(title).map_or(0, |id| self.fake.batches_with("repeatCell", id))
    }
    fn view_titles(&self, title: &str) -> Vec<String> {
        let id = self.fake.id_of(title).unwrap();
        self.fake
            .requests_for("addFilterView", id)
            .iter()
            .map(|v| v["filter"]["title"].as_str().unwrap().to_string())
            .collect()
    }
}

// ---- Uploading -------------------------------------------------------------

#[test]
fn a_months_hours_and_its_taps_land_on_that_months_two_tabs() {
    let mut w = World::new();
    let ana = w.person("Ana Jan");
    let ben = w.person("Ben Jan");
    let ids = vec![
        w.tap_at(&ana, "in", &at(2026, 1, 5, 9, 0)),
        w.tap_at(&ben, "in", &at(2026, 1, 5, 10, 0)),
        w.tap_at(&ana, "out", &at(2026, 1, 5, 13, 0)),
        w.tap_at(&ben, "out", &at(2026, 1, 5, 12, 30)),
    ];
    let mut sheet = fake_sheet();
    w.sync_at(&mut sheet, &at(2026, 1, 5, 18, 0));

    assert_eq!(sheet.ids("January 2026 Logs"), ids);
    assert_eq!(sheet.texts("January 2026 Logs", 'D'), ["Ana Jan", "Ben Jan", "Ana Jan", "Ben Jan"]);
    assert_eq!(sheet.texts("January 2026 Logs", 'F'), ["IN", "IN", "OUT", "OUT"]);
    assert_eq!(sheet.cell("January 2026 Logs", "B2"), "2026-01-05");
    assert_eq!(sheet.cell("January 2026 Logs", "C2"), "09:00:00");
    assert_eq!(sheet.cell("January 2026", "A1"), "Name");
    assert_eq!(sheet.cell("January 2026 Logs", "A1"), "Tap #");

    let hours = sheet.hours("January 2026");
    assert_eq!(hours["Ana Jan"], 4.0);
    assert_eq!(hours["Ben Jan"], 2.5);

    assert_eq!(sheet.cell("Totals", "A1"), "Last synced");
    assert_eq!(sheet.cell("Totals", "B1"), "2026-01-05 18:00:00");
    assert_eq!(sheet.cell("Totals", "A3"), "Name");
    let totals: HashMap<_, _> = {
        // Totals' table starts on row 3, so read it from there.
        let names = sheet.fake.column("Totals", 'A');
        let hours = sheet.fake.column("Totals", 'C');
        names.iter().zip(hours.iter()).skip(2).map(|(n, h)| (text(n), num(h))).collect()
    };
    assert_eq!(totals["Ana Jan"], 4.0);
    assert_eq!(totals["Ben Jan"], 2.5);
}

/// The requirement that matters most: a retry must never duplicate a record.
#[test]
fn an_upload_whose_reply_was_lost_is_sent_again_without_duplicating_a_tap() {
    let mut w = World::new();
    let cy = w.person("Cy Feb");
    let ids = vec![w.tap_at(&cy, "in", &at(2026, 2, 3, 9, 0)), w.tap_at(&cy, "out", &at(2026, 2, 3, 11, 0))];
    let mut sheet = fake_sheet();
    let mut sync = w.syncer(&mut sheet, &at(2026, 2, 3, 18, 0));

    sheet.fake.0.lock().unwrap().fail_next_write = true; // applied, reply lost
    assert!(w.run(&mut sync).is_err());
    assert!(w.pending() >= 2, "as far as we know they are still pending");

    w.run(&mut sync).unwrap();
    assert_eq!(sheet.ids("February 2026 Logs"), ids, "each tap exactly once");
    assert_eq!(sheet.hours("February 2026")["Cy Feb"], 2.0);
    assert_eq!(w.pending(), 0);
}

#[test]
fn taps_that_could_not_be_uploaded_survive_a_restart_and_go_up_afterwards() {
    let mut w = World::new();
    let di = w.person("Di Mar");
    let first = vec![w.tap_at(&di, "in", &at(2026, 3, 2, 9, 0)), w.tap_at(&di, "out", &at(2026, 3, 2, 12, 0))];
    let mut sheet = fake_sheet();
    w.sync_at(&mut sheet, &at(2026, 3, 2, 13, 0));

    let later = vec![w.tap_at(&di, "in", &at(2026, 3, 2, 14, 0)), w.tap_at(&di, "out", &at(2026, 3, 2, 17, 0))];
    let mut offline = w.syncer(&mut sheet, &at(2026, 3, 2, 18, 0));
    sheet.fake.0.lock().unwrap().lose_next_write = true;
    assert!(w.run(&mut offline).is_err());
    assert_eq!(w.pending(), 2);
    assert_eq!(sheet.ids("March 2026 Logs"), first);

    // Next morning: a new process. Only the database knows what is owed.
    let mut next_day = w.syncer(&mut sheet, &at(2026, 3, 3, 9, 0));
    assert_eq!(w.pending(), 2);
    sheet.fake.0.lock().unwrap().writes.clear();
    w.run(&mut next_day).unwrap();
    assert_eq!(sheet.ids("March 2026 Logs"), [first, later].concat());
    assert_eq!(w.pending(), 0);
    // Only what was owed, to the rows after what was already there.
    let log_writes: Vec<_> = sheet.fake.0.lock().unwrap().writes.iter()
        .map(|r| r.range.clone())
        .filter(|r| r.contains("Logs'!A") && !r.contains("A1:"))
        .collect();
    assert_eq!(log_writes, ["'March 2026 Logs'!A4:F5"]);
}

#[test]
fn syncing_again_with_nothing_new_changes_nothing_but_the_time() {
    let mut w = World::new();
    let ed = w.person("Ed Apr");
    w.tap_at(&ed, "in", &at(2026, 4, 6, 9, 0));
    w.tap_at(&ed, "out", &at(2026, 4, 6, 10, 0));
    let mut sheet = fake_sheet();
    w.sync_at(&mut sheet, &at(2026, 4, 6, 11, 0));
    let before = sheet.fake.0.lock().unwrap().cells["April 2026"].clone();

    sheet.fake.0.lock().unwrap().writes.clear();
    w.sync_at(&mut sheet, &at(2026, 4, 6, 15, 0));
    assert_eq!(sheet.fake.0.lock().unwrap().cells["April 2026"], before);
    let resent = sheet.fake.0.lock().unwrap().writes.iter()
        .filter(|r| r.range.contains("Logs") && !r.range.contains("A1:F1"))
        .count();
    assert_eq!(resent, 0, "no taps re-sent");
    assert_eq!(sheet.cell("Totals", "B1"), "2026-04-06 15:00:00");
}

#[test]
fn each_month_gets_its_own_tabs_and_taps_start_at_the_top_of_its_log() {
    let mut w = World::new();
    let fe = w.person("Fe MayJun");
    let may = vec![w.tap_at(&fe, "in", &at(2026, 5, 29, 9, 0)), w.tap_at(&fe, "out", &at(2026, 5, 29, 12, 0))];
    let june = vec![w.tap_at(&fe, "in", &at(2026, 6, 1, 9, 0)), w.tap_at(&fe, "out", &at(2026, 6, 1, 14, 0))];
    let mut sheet = fake_sheet();
    w.sync_at(&mut sheet, &at(2026, 6, 1, 18, 0));
    assert_eq!(sheet.ids("May 2026 Logs"), may);
    assert_eq!(sheet.ids("June 2026 Logs"), june);
    assert_eq!(sheet.hours("May 2026")["Fe MayJun"], 3.0);
    assert_eq!(sheet.hours("June 2026")["Fe MayJun"], 5.0);
}

/// Midnight in Manila is 16:00Z the day before: the month is the local one.
#[test]
fn a_tap_just_after_local_midnight_belongs_to_the_new_month() {
    let mut w = World::new();
    let gil = w.person("Gil Jul");
    let id = w.tap_at(&gil, "in", &at(2026, 8, 1, 0, 30));
    let mut sheet = fake_sheet();
    w.sync_at(&mut sheet, &at(2026, 8, 1, 1, 0));
    assert!(sheet.ids("August 2026 Logs").contains(&id));
    assert!(!sheet.has("July 2026 Logs"));
}

#[test]
fn a_session_that_runs_past_midnight_on_the_last_day_updates_the_month_it_began_in() {
    let mut w = World::new();
    let hal = w.person("Hal SepOct");
    w.tap_at(&hal, "in", &at(2026, 9, 30, 22, 0));
    let mut sheet = fake_sheet();
    w.sync_at(&mut sheet, &at(2026, 9, 30, 23, 0));
    assert_eq!(sheet.hours("September 2026")["Hal SepOct"], 0.0);
    w.tap_at(&hal, "out", &at(2026, 10, 1, 1, 0));
    w.sync_at(&mut sheet, &at(2026, 10, 1, 2, 0));
    assert_eq!(sheet.hours("September 2026")["Hal SepOct"], 3.0);
}

#[test]
fn someone_who_drops_out_of_a_months_table_leaves_no_stale_row_behind() {
    let mut w = World::new();
    let zed = w.person("Zed Nov");
    let mut sheet = fake_sheet();
    w.sync_at(&mut sheet, &at(2026, 11, 2, 9, 0));
    assert!(sheet.texts("November 2026", 'A').contains(&"Zed Nov".into()), "active people are listed with zero hours");

    w.s().set_active(zed.id, false).unwrap();
    w.sync_at(&mut sheet, &at(2026, 11, 2, 10, 0));
    assert!(!sheet.texts("November 2026", 'A').contains(&"Zed Nov".into()));
    let row = sheet.texts("Totals", 'A').iter().position(|n| n == "Zed Nov").unwrap() + 2;
    assert_eq!(sheet.cell("Totals", &format!("G{row}")), "yes", "still in the all-time totals, marked deactivated");
}

#[test]
fn a_restored_backup_is_uploaded_whole_to_whichever_spreadsheet_is_set() {
    let mut w = World::new();
    let ivy = w.person("Ivy Dec");
    let ids = vec![w.tap_at(&ivy, "in", &at(2026, 12, 1, 9, 0)), w.tap_at(&ivy, "out", &at(2026, 12, 1, 10, 0))];
    let mut one = fake_sheet();
    w.sync_at(&mut one, &at(2026, 12, 1, 11, 0));
    let mut two = fake_sheet();
    w.sync_at(&mut two, &at(2026, 12, 1, 12, 0));
    assert_eq!(two.ids("December 2026 Logs"), ids);
}

// ---- Review fixes ----------------------------------------------------------

#[test]
fn starting_from_the_top_removes_rows_the_database_no_longer_has() {
    let mut w = World::new();
    let lea = w.person("Lea 27");
    let id = w.tap_at(&lea, "in", &at(2027, 5, 3, 9, 0));
    let mut sheet = fake_sheet();
    w.sync_at(&mut sheet, &at(2027, 5, 3, 10, 0));

    // What a later, now-lost stretch of the database had put in the sheet.
    sheet.set("May 2027 Logs", "A3", json!(999));
    sheet.set("May 2027 Logs", "D3", json!("Ghost"));
    sheet.fake.tab("June 2027 Logs", vec![sheets::strings(&TAPS), vec![json!(1000), json!(""), json!(""), json!("Ghost")]]);
    sheet.fake.tab("June 2027", vec![vec![json!("Name")], vec![json!("Ghost"), json!(""), json!(5)]]);
    sheet.fake.tab("Notes", vec![vec![], vec![json!("someone's own tab")]]);

    w.restored();
    w.sync_at(&mut sheet, &at(2027, 5, 3, 11, 0));
    assert_eq!(sheet.ids("May 2027 Logs"), [id]);
    assert!(sheet.ids("June 2027 Logs").is_empty());
    assert!(sheet.texts("June 2027", 'A').is_empty());
    assert_eq!(sheet.cell("Notes", "A2"), "someone's own tab", "only the sync's own tabs are emptied");
    assert_eq!(w.pending(), 0);
}

#[test]
fn a_failed_start_from_the_top_is_finished_by_the_retry() {
    // The web test inherits a May 2027 tap, and so a May 2027 Logs tab, from
    // the test before it (its tests share one database); this one makes its own.
    let mut w = World::new();
    let lea = w.person("Lea 27");
    w.tap_at(&lea, "in", &at(2027, 5, 3, 9, 0));
    let mut sheet = fake_sheet();
    let mut sync = w.syncer(&mut sheet, &at(2027, 5, 4, 10, 0));
    w.run(&mut sync).unwrap();
    assert!(sheet.has("May 2027 Logs"));
    sheet.set("May 2027 Logs", "A9", json!(999));
    w.restored();
    sheet.fake.0.lock().unwrap().lose_next_write = true;
    assert!(w.run(&mut sync).is_err());
    w.run(&mut sync).unwrap();
    assert!(!sheet.ids("May 2027 Logs").contains(&999));
}

/// A check-in left open at shutdown is "still in" until the next boot, when it
/// becomes abandoned, though nobody taps in that month again.
#[test]
fn last_months_open_check_in_stops_showing_as_still_in_after_the_next_boot() {
    let mut w = World::new();
    let mo = w.person("Mo 27");
    w.tap_at_boot(&mo, "in", &at(2027, 6, 30, 17, 0), "boot-june");
    let mut sheet = fake_sheet();
    let mut june = w.syncer(&mut sheet, &at(2027, 6, 30, 18, 0));
    w.run_boot(&mut june, "boot-june").unwrap();
    let row = sheet.texts("June 2027", 'A').iter().position(|n| n == "Mo 27").unwrap() + 2;
    assert_eq!(sheet.cell("June 2027", &format!("E{row}")), "yes", "still in, that evening");

    let mut july = w.syncer(&mut sheet, &at(2027, 7, 1, 8, 0));
    w.run_boot(&mut july, "boot-july").unwrap();
    assert_eq!(sheet.cell("June 2027", &format!("E{row}")), "", "no longer still in");
    assert_eq!(num(&sheet.fake.cell("June 2027", &format!("F{row}"))), 1.0, "one session not counted");
}

#[test]
fn starting_from_the_top_removes_people_the_database_no_longer_has_from_totals() {
    let mut w = World::new();
    w.person("Someone");
    let mut sheet = fake_sheet();
    w.sync_at(&mut sheet, &at(2027, 10, 1, 9, 0));
    let below = sheet.texts("Totals", 'A').len() + 2;
    sheet.set("Totals", &format!("A{below}"), json!("Obsolete Person"));
    sheet.set("Totals", &format!("C{below}"), json!(12));

    w.restored();
    w.sync_at(&mut sheet, &at(2027, 10, 1, 10, 0));
    assert!(!sheet.texts("Totals", 'A').contains(&"Obsolete Person".into()));
    assert_eq!(sheet.cell("Totals", &format!("C{below}")), "", "their hours went with them");
    assert_eq!(sheet.cell("Totals", "A1"), "Last synced");
    assert_eq!(sheet.cell("Totals", "A3"), "Name");
    assert_eq!(sheet.texts("Totals", 'A').len(), 2 + w.names().len(), "the table is whole again");
}

// ---- The Staffers tab: the record of who the staffers are ----------------

#[test]
fn the_people_in_a_restored_backup_are_put_in_the_staffers_tab_once() {
    let mut w = World::new();
    let uma = w.staffer("Uma Dir", "D-uma");
    let mut sheet = fake_sheet();
    let mut sync = w.syncer(&mut sheet, &at(2028, 1, 3, 9, 0));
    w.run(&mut sync).unwrap();

    assert_eq!(sheet.cell("Staffers", "G1"), "Card number");
    assert_eq!(sheet.staff_cells("D-uma"), ["Uma Dir", "D-uma", "A&G", "Probie", "@D_uma", "", uma.rfid.as_str()]);
    let staffers = sheet.fake.id_of("Staffers").unwrap();
    assert_eq!(sheet.fake.batches_with("setDataValidation", staffers), 1, "shaped with its dropdowns");
    assert_eq!(sheet.fake.requests_for("setDataValidation", staffers).len(), 2, "Section and Status");

    w.run(&mut sync).unwrap();
    assert_eq!(sheet.texts("Staffers", 'B').iter().filter(|b| *b == "D-uma").count(), 1);
    assert_eq!(sheet.fake.batches_with("setDataValidation", staffers), 1);
}

#[test]
fn an_edit_made_in_the_sheet_is_taken_up_here_and_reaches_the_hours_tables() {
    let mut w = World::new();
    let vic = w.staffer("Vic Dir", "D-vic");
    w.tap_at(&vic, "in", &at(2028, 2, 1, 9, 0));
    w.tap_at(&vic, "out", &at(2028, 2, 1, 11, 0));
    let mut sheet = fake_sheet();
    let mut sync = w.syncer(&mut sheet, &at(2028, 2, 1, 12, 0));
    w.run(&mut sync).unwrap();

    let row = sheet.staff_row("D-vic");
    sheet.set("Staffers", &format!("A{row}"), json!("Victor Dir"));
    sheet.set("Staffers", &format!("D{row}"), json!("Regular"));
    sheet.set("Staffers", &format!("E{row}"), json!("victor"));
    sheet.set("Staffers", &format!("F{row}"), json!("Yes"));
    w.run(&mut sync).unwrap();

    let now = w.user(vic.id).unwrap();
    assert_eq!(now.person.name, "Victor Dir");
    assert_eq!(now.person.status, "Regular");
    assert_eq!(now.person.telegram, "@victor", "the @ is added to what was typed in the sheet");
    assert!(!now.active, "deactivated from the sheet");
    assert_eq!(now.rfid, vic.rfid);
    assert_eq!(sheet.hours("February 2028")["Victor Dir"], 2.0);
    assert!(!sheet.hours("February 2028").contains_key("Vic Dir"));
    assert_eq!(sheet.texts("February 2028 Logs", 'D'), ["Victor Dir", "Victor Dir"], "the rows of their taps follow");
}

#[test]
fn a_row_deleted_from_the_sheet_deactivates_the_person_and_keeps_their_taps() {
    let mut w = World::new();
    let wes = w.staffer("Wes Dir", "D-wes");
    w.tap_at(&wes, "in", &at(2028, 3, 1, 9, 0));
    w.tap_at(&wes, "out", &at(2028, 3, 1, 10, 0));
    let mut sheet = fake_sheet();
    let mut sync = w.syncer(&mut sheet, &at(2028, 3, 1, 12, 0));
    w.run(&mut sync).unwrap();

    let row = sheet.staff_row("D-wes");
    for c in "ABCDEFG".chars() {
        sheet.set("Staffers", &format!("{c}{row}"), json!(""));
    }
    w.run(&mut sync).unwrap();
    assert!(!w.user(wes.id).unwrap().active);
    assert_eq!(w.s().events_for(wes.id).unwrap().len(), 2);
    assert!(!sheet.texts("Staffers", 'B').contains(&"D-wes".into()), "the row is not put back");
}

#[test]
fn a_bad_row_in_the_sheet_is_skipped_with_a_warning_and_changes_nothing_here() {
    let mut w = World::new();
    let xia = w.staffer("Xia Dir", "D-xia");
    let mut sheet = fake_sheet();
    let mut sync = w.syncer(&mut sheet, &at(2028, 4, 1, 9, 0));
    w.run(&mut sync).unwrap();
    w.run(&mut sync).unwrap();
    assert!(!sync.notes.warnings.iter().any(|m| m.contains("Xia Dir")));

    let row = sheet.staff_row("D-xia");
    sheet.set("Staffers", &format!("C{row}"), json!("Gossip"));
    w.run(&mut sync).unwrap();
    let now = w.user(xia.id).unwrap();
    assert_eq!(now.person.section, "A&G");
    assert!(now.active);
    assert!(sync.notes.warnings.iter().any(|m| m.contains("Xia Dir") && m.to_lowercase().contains("section")), "{:?}", sync.notes.warnings);
}

#[test]
fn a_row_with_a_card_for_someone_not_here_creates_them_card_and_all() {
    let w = World::new();
    let mut sheet = fake_sheet();
    let mut sync = w.syncer(&mut sheet, &at(2028, 5, 1, 9, 0));
    w.run(&mut sync).unwrap();
    let row = sheet.texts("Staffers", 'B').len() + 2;
    for (c, v) in "ABCDEFG".chars().zip(["Yan Dir", "D-yan", "Web", "Newbie", "yan_d", "", "880001"]) {
        sheet.set("Staffers", &format!("{c}{row}"), json!(v));
    }
    w.run(&mut sync).unwrap();
    let yan = w.s().by_card("880001").unwrap().unwrap();
    assert_eq!(
        (yan.person.name.as_str(), yan.person.student_id.as_str(), yan.person.section.as_str(), yan.person.status.as_str(), yan.person.telegram.as_str(), yan.active),
        ("Yan Dir", "D-yan", "Web", "Newbie", "@yan_d", true),
    );
}

// ---- Saving from the People page: the sheet first, then here -------------

fn wanted(p: Person, card: &str, active: bool) -> User {
    User { id: 0, person: p, rfid: card.into(), active, created_at: dates::now() }
}

#[test]
fn a_save_reaches_the_sheet_before_it_is_kept_here() {
    let w = World::new();
    let mut sheet = fake_sheet();
    let mut sync = w.syncer(&mut sheet, &at(2028, 6, 1, 9, 0));
    w.run(&mut sync).unwrap();

    sync.save(&w.store, &wanted(details("Zoe Dir", "D-zoe"), "880002", true), None).unwrap();
    assert_eq!(sheet.staff_cells("D-zoe")[6], "880002");
    let id = w.s().create(&details("Zoe Dir", "D-zoe"), "880002", true).unwrap();

    // An edit, then a deactivation, land on the same row.
    let saved = w.user(id).unwrap();
    let edited = User { person: Person { status: "Regular".into(), ..saved.person.clone() }, active: false, ..saved.clone() };
    sync.save(&w.store, &edited, Some(&saved)).unwrap();
    assert_eq!(sheet.staff_cells("D-zoe")[3..7], ["Regular", "@D_zoe", "yes", "880002"]);
    assert_eq!(sheet.texts("Staffers", 'B').iter().filter(|b| *b == "D-zoe").count(), 1);
}

#[test]
fn with_no_internet_a_save_changes_nothing_here_or_in_the_sheet() {
    let w = World::new();
    let mut sheet = fake_sheet();
    let mut sync = w.syncer(&mut sheet, &at(2028, 7, 1, 9, 0));
    w.run(&mut sync).unwrap();
    let before = sheet.texts("Staffers", 'B').len();

    sheet.fake.0.lock().unwrap().lose_next_write = true;
    let err = sync.save(&w.store, &wanted(details("Abe Dir", "D-abe"), "880003", true), None).unwrap_err();
    assert!(err.offline);
    assert_eq!(sheet.texts("Staffers", 'B').len(), before);
    assert!(w.s().by_card("880003").unwrap().is_none());
}

#[test]
fn a_save_whose_reply_was_lost_is_picked_up_from_the_sheet_by_the_next_sync() {
    let w = World::new();
    let mut sheet = fake_sheet();
    let mut sync = w.syncer(&mut sheet, &at(2028, 8, 1, 9, 0));
    w.run(&mut sync).unwrap();

    sheet.fake.0.lock().unwrap().fail_next_write = true;
    assert!(sync.save(&w.store, &wanted(details("Bea Dir", "D-bea"), "880004", true), None).is_err());
    assert!(w.s().by_card("880004").unwrap().is_none());
    w.run(&mut sync).unwrap();
    assert_eq!(w.s().by_card("880004").unwrap().unwrap().person.name, "Bea Dir");
    assert_eq!(sheet.texts("Staffers", 'B').iter().filter(|b| *b == "D-bea").count(), 1);
}

#[test]
fn a_save_is_refused_when_the_sheet_already_has_that_id_number_or_card() {
    let mut w = World::new();
    let cal = w.staffer("Cal Dir", "D-cal");
    let mut sheet = fake_sheet();
    let mut sync = w.syncer(&mut sheet, &at(2028, 9, 1, 9, 0));
    w.run(&mut sync).unwrap();

    let twin = sync.save(&w.store, &wanted(details("Twin Dir", "D-cal"), "880005", true), None).unwrap_err();
    assert!(twin.message.contains("D-cal already belongs to Cal Dir"), "{}", twin.message);
    let thief = sync.save(&w.store, &wanted(details("Thief Dir", "D-thief"), &cal.rfid, true), None).unwrap_err();
    assert!(thief.message.contains("card number already belongs to Cal Dir"), "{}", thief.message);
}

#[test]
fn a_save_from_a_device_that_is_behind_the_sheet_is_refused_and_the_device_catches_up() {
    let mut w = World::new();
    let eli = w.staffer("Eli Dir", "D-eli");
    let mut sheet = fake_sheet();
    let mut sync = w.syncer(&mut sheet, &at(2028, 10, 1, 9, 0));
    w.run(&mut sync).unwrap();

    // Someone changes their status in the sheet, by hand or from another device.
    let row = sheet.staff_row("D-eli");
    sheet.set("Staffers", &format!("D{row}"), json!("Regular"));
    let before = sheet.writes();

    let own = w.user(eli.id).unwrap();
    let err = sync.save(&w.store, &User { active: false, ..own.clone() }, Some(&own)).unwrap_err();
    assert!(!err.offline);
    assert!(err.message.contains(&format!("Eli Dir (row {row})")), "{}", err.message);
    assert_eq!(sheet.writes(), before, "nothing was written");
    assert_eq!(sheet.cell("Staffers", &format!("D{row}")), "Regular");

    // Caught up, the same change goes through on top of the sheet's.
    w.run(&mut sync).unwrap();
    let now = w.user(eli.id).unwrap();
    assert_eq!(now.person.status, "Regular");
    sync.save(&w.store, &User { active: false, ..now.clone() }, Some(&now)).unwrap();
    assert_eq!(sheet.staff_cells("D-eli")[3..6], ["Regular", "@D_eli", "yes"]);
}

#[test]
fn the_staffers_tab_is_never_emptied_and_its_word_is_taken_when_a_device_comes_back_to_it() {
    let mut w = World::new();
    let dee = w.staffer("Dee Dir", "D-dee");
    let mut one = fake_sheet();
    w.sync_at(&mut one, &at(2028, 10, 2, 9, 0));
    let mut two = fake_sheet();
    w.sync_at(&mut two, &at(2028, 10, 2, 10, 0));
    assert_eq!(two.staff_cells("D-dee")[0], "Dee Dir");
    assert!(w.user(dee.id).unwrap().active);

    // Back on the first, which was edited meanwhile: its word is taken.
    let row = one.staff_row("D-dee");
    one.set("Staffers", &format!("D{row}"), json!("Regular"));
    w.sync_at(&mut one, &at(2028, 10, 2, 11, 0));
    assert!(![one.clears(), two.clears()].concat().iter().any(|r| r.contains("Staffers")));
    assert_eq!(w.user(dee.id).unwrap().person.status, "Regular");
}

#[test]
fn a_sheet_that_still_has_year_and_course_columns_loses_them_and_nobody_with_them() {
    let mut w = World::new();
    let fox = w.staffer("Fox Dir", "D-fox");
    let mut sheet = fake_sheet();
    sheet.fake.tab(
        "Staffers",
        vec![
            sheets::strings(&["Name", "ID number", "Section", "Status", "Telegram", "Year", "Course", "Deactivated", "Card number"]),
            sheets::strings(&["Fox Dir", "D-fox", "A&G", "Regular", "@D_fox", "2", "AB CAM", "", &fox.rfid]),
        ],
    );
    sheet.fake.tab("Search", vec![vec![], vec![], vec![], {
        let mut r = vec![json!(""); 13];
        r.extend(sheets::strings(&["Telegram", "Year", "Course", "Deactivated"]));
        r
    }]);
    let mut sync = w.syncer(&mut sheet, &at(2029, 8, 1, 9, 0));
    w.run(&mut sync).unwrap();

    let deletes: Vec<_> = sheet.fake.0.lock().unwrap().requests.iter().flatten()
        .filter_map(|r| r.get("deleteDimension"))
        .map(|d| (d["range"]["sheetId"].as_i64().unwrap(), d["range"]["startIndex"].as_u64().unwrap(), d["range"]["endIndex"].as_u64().unwrap()))
        .collect();
    let (staffers, search) = (sheet.fake.id_of("Staffers").unwrap(), sheet.fake.id_of("Search").unwrap());
    assert_eq!(deletes, [(staffers, 5, 7), (search, 14, 16)]);
    assert_eq!(sheet.staff_cells("D-fox"), ["Fox Dir", "D-fox", "A&G", "Regular", "@D_fox", "", fox.rfid.as_str()]);
    assert_eq!(sheet.cell("Staffers", "G1"), "Card number");
    let now = w.user(fox.id).unwrap();
    assert_eq!((now.person.status.as_str(), now.active, now.rfid.as_str()), ("Regular", true, fox.rfid.as_str()));

    w.run(&mut sync).unwrap();
    let again = sheet.fake.0.lock().unwrap().requests.iter().flatten().filter(|r| r.get("deleteDimension").is_some()).count();
    assert_eq!(again, 2, "once");
}

// ---- Finding things in the sheet -------------------------------------------

#[test]
fn hours_and_log_tabs_get_their_filter_views_once_and_the_views_move_no_cells() {
    let mut w = World::new();
    let eve = w.person("Eve Find");
    w.tap_at(&eve, "in", &at(2029, 1, 8, 9, 0));
    w.tap_at(&eve, "out", &at(2029, 1, 8, 12, 0));
    let mut sheet = fake_sheet();
    let mut sync = w.syncer(&mut sheet, &at(2029, 1, 8, 13, 0));
    w.run(&mut sync).unwrap();

    assert_eq!(sheet.view_titles("January 2029"), ["Search", "Most hours", "Least hours"]);
    assert_eq!(sheet.view_titles("January 2029 Logs"), ["Search", "Newest first"]);
    assert_eq!(sheet.view_titles("Totals"), ["Search", "Most hours", "Least hours"]);
    assert!(sheet.view_titles("Staffers").is_empty() && sheet.view_titles("Search").is_empty());

    let totals = sheet.fake.id_of("Totals").unwrap();
    let most = sheet.fake.requests_for("addFilterView", totals).into_iter()
        .find(|v| v["filter"]["title"] == "Most hours").unwrap();
    assert_eq!(most["filter"]["range"]["startRowIndex"], 2, "Totals' table starts on row 3");
    assert_eq!(most["filter"]["range"]["endColumnIndex"], 7);
    assert_eq!(most["filter"]["sortSpecs"][0]["dimensionIndex"], 2);
    assert_eq!(most["filter"]["sortSpecs"][0]["sortOrder"], "DESCENDING");
    let frozen = |id| sheet.fake.requests_for("updateSheetProperties", id).last().unwrap()["properties"]["gridProperties"]["frozenRowCount"].clone();
    assert_eq!(frozen(totals), 3);
    assert_eq!(frozen(sheet.fake.id_of("January 2029").unwrap()), 1);

    w.run(&mut sync).unwrap();
    assert_eq!(sheet.view_titles("January 2029").len(), 3, "not added twice");

    w.tap_at(&eve, "in", &at(2029, 2, 1, 9, 0));
    w.sync_at(&mut sheet, &at(2029, 2, 1, 10, 0));
    assert_eq!(sheet.view_titles("February 2029"), ["Search", "Most hours", "Least hours"]);
}

#[test]
fn the_search_tab_is_written_when_a_month_is_added_and_its_search_box_is_left_alone() {
    let mut w = World::new();
    let fay = w.person("Fay Find");
    w.tap_at(&fay, "in", &at(2029, 3, 5, 9, 0));
    let mut sheet = fake_sheet();
    let mut sync = w.syncer(&mut sheet, &at(2029, 3, 5, 10, 0));
    w.run(&mut sync).unwrap();
    let formulas = |sheet: &Sheet| sheet.fake.0.lock().unwrap().formula_writes;
    assert_eq!(formulas(&sheet), 1);
    let a5 = sheet.cell("Search", "A5");
    assert!(a5.starts_with('=') && a5.contains("'March 2029'!A2:G"), "{a5}");
    assert!(sheet.cell("Search", "Q5").contains("'March 2029 Logs'!A2:F"));

    sheet.set("Search", "B1", json!("fay"));
    w.run(&mut sync).unwrap();
    assert_eq!(formulas(&sheet), 1, "nothing new, nothing rewritten");

    w.tap_at(&fay, "out", &at(2029, 4, 2, 9, 0));
    w.sync_at(&mut sheet, &at(2029, 4, 2, 10, 0));
    assert_eq!(formulas(&sheet), 2);
    let hours = sheet.cell("Search", "A5");
    assert!(hours.find("'April 2029'").unwrap() < hours.find("'March 2029'").unwrap(), "newest month first");
    assert_eq!(sheet.cell("Search", "B1"), "fay");
}

#[test]
fn the_columns_of_what_a_sync_wrote_are_fitted_to_it_and_only_those() {
    let mut w = World::new();
    let gus = w.person("Gus Find");
    w.tap_at(&gus, "in", &at(2029, 5, 7, 9, 0));
    let mut sheet = fake_sheet();
    w.sync_at(&mut sheet, &at(2029, 5, 7, 10, 0));
    let fitted: Vec<i64> = sheet.fake.0.lock().unwrap().requests.iter().flatten()
        .filter_map(|r| r.get("autoResizeDimensions"))
        .map(|r| r["dimensions"]["sheetId"].as_i64().unwrap())
        .collect();
    for title in ["May 2029", "May 2029 Logs", "Totals"] {
        assert!(fitted.contains(&sheet.fake.id_of(title).unwrap()), "{title}");
    }
    for title in ["Staffers", "Search"] {
        assert!(!fitted.contains(&sheet.fake.id_of(title).unwrap()), "{title}");
    }
}

#[test]
fn each_tab_is_styled_once_and_a_new_or_re_made_tab_gets_its_turn() {
    let mut w = World::new();
    let hal = w.person("Hal Style");
    w.tap_at(&hal, "in", &at(2029, 6, 4, 9, 0));
    let mut sheet = fake_sheet();
    w.sync_at(&mut sheet, &at(2029, 6, 4, 10, 0));
    for title in ["June 2029", "June 2029 Logs", "Totals", "Staffers", "Search"] {
        assert_eq!(sheet.styled(title), 1, "{title}");
    }

    w.sync_at(&mut sheet, &at(2029, 6, 4, 11, 0));
    assert_eq!(sheet.styled("Search"), 1, "restyling by hand is left alone");

    w.tap_at(&hal, "out", &at(2029, 7, 2, 9, 0));
    sheet.fake.delete_tab("Search"); // someone deletes it; the app makes it again
    w.sync_at(&mut sheet, &at(2029, 7, 2, 10, 0));
    assert_eq!(sheet.styled("July 2029"), 1);
    assert_eq!(sheet.styled("Search"), 1, "the new Search tab, styled once");
    assert_eq!(sheet.styled("Totals"), 1);
}

// ---- The sheet is the record: what a device has when it starts -----------

#[test]
fn a_device_switched_on_takes_the_sheets_people_and_taps_over_its_own() {
    let mut w = World::new();
    let stray = w.person("Stray Local");
    w.tap_at(&stray, "in", &at(2030, 3, 1, 9, 0));
    let mut sheet = left_by(&[PIA], &[(
        "March 2030 Logs",
        vec![tap_row(json!(1), "2030-03-04", "09:00:00", "Pia Pull", "P-pia", "IN"), tap_row(json!(2), "2030-03-04", "12:00:00", "Pia Pull", "P-pia", "OUT")],
    )]);
    w.sync_at(&mut sheet, &at(2030, 3, 4, 13, 0));

    assert_eq!(w.taps(), [
        (1, "Pia Pull".into(), "in".into(), at(2030, 3, 4, 9, 0)),
        (2, "Pia Pull".into(), "out".into(), at(2030, 3, 4, 12, 0)),
    ]);
    assert_eq!(w.s().by_card("990001").unwrap().unwrap().person.section, "Web");
    assert!(w.user(stray.id).is_none(), "nobody the sheet does not know is left");
    assert_eq!(w.names(), ["Pia Pull"]);
    assert!(sheet.clears().is_empty(), "nothing of the sheet's was emptied");
    assert_eq!(sheet.ids("March 2030 Logs"), [1, 2]);
    assert_eq!(sheet.hours("March 2030")["Pia Pull"], 3.0);
    assert_eq!(sheet.texts("Staffers", 'A'), ["Pia Pull"]);
    assert_eq!(w.pending(), 0);
}

#[test]
fn taps_still_waiting_when_a_device_starts_are_kept_after_whatever_the_sheet_has_gained() {
    let w = World::new();
    let mut sheet = left_by(&[PIA], &[(
        "April 2030 Logs",
        vec![tap_row(json!(1), "2030-04-01", "09:00:00", "Pia Pull", "P-pia", "IN"), tap_row(json!(2), "2030-04-01", "12:00:00", "Pia Pull", "P-pia", "OUT")],
    )]);
    w.sync_at(&mut sheet, &at(2030, 4, 1, 13, 0));
    // Tapped with no internet, then switched off. It got the next number...
    let pia = w.s().by_card("990001").unwrap().unwrap();
    assert_eq!(w.tap_at(&pia, "in", &at(2030, 4, 2, 9, 0)), 3);
    // ...which another device, switched on meanwhile, has used as well.
    for (r, row) in [
        tap_row(json!(3), "2030-04-03", "09:00:00", "Pia Pull", "P-pia", "IN"),
        tap_row(json!(4), "2030-04-03", "10:00:00", "Pia Pull", "P-pia", "OUT"),
    ].into_iter().enumerate() {
        for (c, v) in "ABCDEF".chars().zip(row) {
            sheet.set("April 2030 Logs", &format!("{c}{}", r + 4), v);
        }
    }

    let mut sync = w.syncer(&mut sheet, &at(2030, 4, 4, 9, 0));
    assert_eq!(w.pending(), 1);
    w.run(&mut sync).unwrap();
    assert_eq!(sheet.ids("April 2030 Logs"), [1, 2, 3, 4, 5]);
    assert_eq!(sheet.texts("April 2030 Logs", 'B'), ["2030-04-01", "2030-04-01", "2030-04-03", "2030-04-03", "2030-04-02"]);
    assert_eq!(w.taps().iter().map(|t| t.0).collect::<Vec<_>>(), [1, 2, 3, 4, 5]);
    assert_eq!(w.pending(), 0);
    assert!(sheet.clears().is_empty());
}

#[test]
fn a_server_restarted_mid_day_still_knows_who_is_in() {
    let w = World::new();
    let mut sheet = left_by(&[PIA], &[]);
    let mut morning = w.syncer(&mut sheet, &at(2030, 5, 6, 8, 0));
    w.run(&mut morning).unwrap();
    let pia = w.s().by_card("990001").unwrap().unwrap();
    w.tap_at(&pia, "in", "2030-05-06T01:00:00.417Z");
    w.run(&mut morning).unwrap();

    w.sync_at(&mut sheet, &at(2030, 5, 6, 10, 0)); // same boot, new process
    assert_eq!(w.s().currently_in(BOOT).unwrap().iter().map(|(u, _)| u.person.name.clone()).collect::<Vec<_>>(), ["Pia Pull"]);
    assert_eq!(w.s().events().unwrap()[0].ts, "2030-05-06T01:00:00.417Z", "its own tap, to the millisecond");

    let mut tomorrow = w.syncer(&mut sheet, &at(2030, 5, 7, 8, 0));
    w.run_boot(&mut tomorrow, "boot-tomorrow").unwrap();
    assert!(w.s().currently_in("boot-tomorrow").unwrap().is_empty(), "switched off overnight: nobody is");
}

#[test]
fn logs_tabs_edited_by_hand_are_taken_as_they_are_then_written_out_afresh() {
    let w = World::new();
    let mut sheet = left_by(&[PIA], &[(
        "June 2030 Logs",
        vec![
            tap_row(json!(1), "2030-06-03", "09:00:00", "Pia Pull", "P-pia", "IN"),
            vec![],                                                                      // a mistaken tap, deleted
            tap_row(json!(3), "2030-06-04", "09:00:00", "Pia Pull", "P-pia", "IN"),
            tap_row(json!(""), "2030-06-03", "11:30", "Pia Pull", "P-pia", "out"),        // the check-out she forgot, typed in
            tap_row(json!(5), "2030-06-04", "10:00:00", "Pia Pull", "P-pia", "OUT"),
        ],
    )]);
    w.sync_at(&mut sheet, &at(2030, 6, 5, 9, 0));

    assert_eq!(sheet.ids("June 2030 Logs"), [1, 2, 3, 4]);
    assert_eq!(sheet.texts("June 2030 Logs", 'C'), ["09:00:00", "11:30:00", "09:00:00", "10:00:00"]);
    assert_eq!(sheet.texts("June 2030 Logs", 'F'), ["IN", "OUT", "IN", "OUT"]);
    assert_eq!(sheet.hours("June 2030")["Pia Pull"], 3.5);
    assert_eq!(w.taps().iter().map(|t| t.0).collect::<Vec<_>>(), [1, 2, 3, 4]);
    assert_eq!(w.pending(), 0);

    // Tidy now: the next start reads it and rewrites nothing.
    sheet.fake.0.lock().unwrap().clears.clear();
    w.sync_at(&mut sheet, &at(2030, 6, 5, 10, 0));
    assert!(sheet.clears().is_empty());
}

#[test]
fn uploaded_tap_numbers_with_commas_are_preserved_across_months() {
    let w = World::new();
    let mut sheet = left_by(&[PIA], &[
        ("September 2030 Logs", vec![tap_row(json!(1), "2030-09-30", "09:00:00", "Pia Pull", "P-pia", "IN"), tap_row(json!(2), "2030-09-30", "12:00:00", "Pia Pull", "P-pia", "OUT")]),
        ("October 2030 Logs", vec![tap_row(json!("3"), "2030-10-01", "09:00:00", "Pia Pull", "P-pia", "IN"), tap_row(json!("1,004"), "2030-10-01", "10:30:00", "Pia Pull", "P-pia", "out")]),
    ]);
    w.sync_at(&mut sheet, &at(2030, 10, 2, 9, 0));
    assert_eq!(w.s().events().unwrap().iter().map(|e| e.id).collect::<Vec<_>>(), [1, 2, 3, 1004]);
}

#[test]
fn edited_log_rows_are_sorted_and_renumbered_for_each_untidy_case() {
    let row = |n, date, time, kind| tap_row(n, date, time, "Pia Pull", "P-pia", kind);
    for rows in [
        vec![row(json!(1), "2030-10-01", "09:00", "IN"), vec![], row(json!(3), "2030-10-01", "12:00", "OUT")],
        vec![row(json!(1), "2030-10-01", "09:00", "IN"), row(json!(""), "2030-10-01", "12:00", "OUT")],
        vec![row(json!(2), "2030-10-01", "09:00", "IN"), row(json!(1), "2030-10-01", "12:00", "OUT")],
        vec![row(json!(1), "2030-10-01", "09:00", "IN"), row(json!(2), "2030-11-02", "12:00", "OUT")],
    ] {
        let w = World::new();
        let mut sheet = left_by(&[PIA], &[("October 2030 Logs", rows)]);
        w.sync_at(&mut sheet, &at(2030, 11, 3, 9, 0));
        let events = w.s().events().unwrap();
        assert_eq!(events.iter().map(|e| e.id).collect::<Vec<_>>(), [1, 2]);
        assert_eq!(events.iter().map(|e| e.kind.as_str()).collect::<Vec<_>>(), ["in", "out"]);
    }
}

#[test]
fn invalid_log_time_direction_and_identity_each_report_the_tab_and_row() {
    for (time, name, id, kind) in [("9am", "Pia Pull", "P-pia", "IN"), ("09:00", "Pia Pull", "P-pia", "ARRIVED"), ("09:00", "", "", "IN")] {
        let w = World::new();
        let mut sheet = left_by(&[PIA], &[("October 2030 Logs", vec![tap_row(json!(1), "2030-10-01", time, name, id, kind)])]);
        let mut sync = w.syncer(&mut sheet, &at(2030, 10, 2, 9, 0));
        let err = w.run(&mut sync).unwrap_err();
        assert!(err.message.contains("October 2030 Logs, row 2"), "{}", err.message);
        assert!(w.s().events().unwrap().is_empty());
    }
}

#[test]
fn no_logs_or_an_empty_log_import_no_taps() {
    for logs in [vec![], vec![("October 2030 Logs", vec![])]] {
        let w = World::new();
        let mut sheet = left_by(&[PIA], &logs);
        w.sync_at(&mut sheet, &at(2030, 10, 2, 9, 0));
        assert!(w.s().events().unwrap().is_empty());
    }
}

#[test]
fn a_roster_rename_updates_earlier_months_and_their_log_labels() {
    let mut w = World::new();
    let ana = w.staffer("Ana Before", "A-before");
    for month in [1, 2] {
        w.tap_at(&ana, "in", &at(2030, month, 5, 9, 0));
        w.tap_at(&ana, "out", &at(2030, month, 5, 11, 0));
    }
    let mut sheet = fake_sheet();
    let mut sync = w.syncer(&mut sheet, &at(2030, 3, 1, 9, 0));
    w.run(&mut sync).unwrap();
    let row = sheet.staff_row("A-before");
    let own = w.user(ana.id).unwrap();
    let wanted = User { person: Person { name: "Ana After".into(), student_id: "A-after".into(), ..own.person.clone() }, ..own.clone() };
    sync.save(&w.store, &wanted, Some(&own)).unwrap();
    w.s().update(ana.id, &wanted.person).unwrap();
    sync.refresh();
    w.run(&mut sync).unwrap();
    assert_eq!(sheet.cell("Staffers", &format!("A{row}")), "Ana After");
    for title in ["January 2030", "February 2030"] {
        assert_eq!(sheet.hours(title)["Ana After"], 2.0);
        assert!(!sheet.hours(title).contains_key("Ana Before"));
        let logs = format!("{title} Logs");
        assert_eq!(sheet.texts(&logs, 'D'), ["Ana After", "Ana After"]);
        assert_eq!(sheet.texts(&logs, 'E'), ["A-after", "A-after"]);
    }
}

#[test]
fn a_tap_in_the_sheet_that_cannot_be_read_stops_the_sync_and_changes_nothing() {
    let w = World::new();
    let mut sheet = left_by(&[PIA], &[("July 2030 Logs", vec![tap_row(json!(1), "2030-07-01", "09:00:00", "Pia Pull", "P-pia", "IN")])]);
    w.sync_at(&mut sheet, &at(2030, 7, 1, 10, 0));
    let before = w.s().events().unwrap();

    for (c, v) in "ABCDEF".chars().zip(tap_row(json!(2), "July 1", "12:00:00", "Pia Pull", "P-pia", "OUT")) {
        sheet.set("July 2030 Logs", &format!("{c}3"), v);
    }
    let mut sync = w.syncer(&mut sheet, &at(2030, 7, 2, 9, 0));
    let err = w.run(&mut sync).unwrap_err();
    assert!(!err.offline);
    assert!(err.message.contains("July 2030 Logs, row 3"), "{}", err.message);
    assert_eq!(w.s().events().unwrap(), before);
    assert_eq!(sheet.cell("July 2030 Logs", "B3"), "July 1", "nor the sheet");

    sheet.set("July 2030 Logs", "B3", json!("2030-07-01"));
    w.run(&mut sync).unwrap();
    assert_eq!(w.s().events().unwrap().len(), 2);
}

#[test]
fn taps_of_someone_the_staffers_tab_does_not_list_are_kept_under_a_deactivated_person() {
    let w = World::new();
    let mut sheet = left_by(&[PIA], &[(
        "August 2030 Logs",
        vec![tap_row(json!(1), "2030-08-01", "09:00:00", "Gone Staffer", "P-gone", "IN"), tap_row(json!(2), "2030-08-01", "11:00:00", "Gone Staffer", "P-gone", "OUT")],
    )]);
    w.sync_at(&mut sheet, &at(2030, 8, 1, 12, 0));
    let users = w.s().users().unwrap();
    let gone = users.iter().find(|u| u.person.student_id == "P-gone").unwrap();
    assert_eq!((gone.person.name.as_str(), gone.active), ("Gone Staffer", false));
    assert!(!sheet.texts("Staffers", 'B').contains(&"P-gone".into()), "and not put in the Staffers tab");

    w.sync_at(&mut sheet, &at(2030, 8, 2, 9, 0));
    assert_eq!(w.s().users().unwrap().iter().filter(|u| u.person.student_id == "P-gone").count(), 1, "the same person each start");
}

#[test]
fn an_id_number_corrected_in_the_staffers_tab_while_switched_off_keeps_the_taps_with_their_person() {
    let w = World::new();
    let mut sheet = left_by(&[PIA], &[("September 2030 Logs", vec![tap_row(json!(1), "2030-09-02", "09:00:00", "Pia Pull", "P-pia", "IN")])]);
    w.sync_at(&mut sheet, &at(2030, 9, 2, 10, 0));
    let pia = w.s().by_card("990001").unwrap().unwrap();

    sheet.set("Staffers", "A2", json!("Pia Pulled"));
    sheet.set("Staffers", "B2", json!("P-pia-2"));
    w.sync_at(&mut sheet, &at(2030, 9, 3, 9, 0));
    let users: Vec<_> = w.s().users().unwrap().into_iter().map(|u| (u.id, u.person.name, u.person.student_id)).collect();
    assert_eq!(users, [(pia.id, "Pia Pulled".to_string(), "P-pia-2".to_string())]);
    assert_eq!(w.s().events_for(pia.id).unwrap().len(), 1);
    assert_eq!(sheet.texts("September 2030 Logs", 'E'), ["P-pia-2"], "the tap's row follows");
}

#[test]
fn a_spreadsheet_with_nothing_in_it_leaves_a_device_with_nothing() {
    let mut w = World::new();
    let eve = w.person("Eve Empty");
    w.tap_at(&eve, "in", &at(2030, 10, 1, 9, 0));
    let mut sheet = fake_sheet();
    sheet.begun = true;
    w.sync_at(&mut sheet, &at(2030, 10, 1, 10, 0));
    assert!(w.s().events().unwrap().is_empty());
    assert!(w.s().users().unwrap().is_empty());
    assert!(sheet.texts("Staffers", 'A').is_empty());
    assert_eq!(w.pending(), 0);
}

#[test]
fn a_tap_made_before_a_new_spreadsheet_could_be_reached_is_still_owed_to_it() {
    let w = World::new();
    let id = w.s().create(&details("Pia Pull", "P-pia"), "990001", true).unwrap();
    let pia = w.user(id).unwrap();
    w.tap_at(&pia, "in", &at(2030, 11, 1, 9, 0)); // from whatever it synced with before
    let mut sheet = left_by(&[PIA], &[]);
    let mut sync = w.syncer(&mut sheet, &at(2030, 11, 4, 9, 0));

    sheet.fake.0.lock().unwrap().fail_reads = true;
    assert!(w.run(&mut sync).is_err());
    let waiting = w.tap_at(&pia, "in", &at(2030, 11, 4, 9, 0));
    assert_eq!(w.pending(), 1);

    sheet.fake.0.lock().unwrap().fail_reads = false;
    w.run(&mut sync).unwrap();
    assert_eq!(w.taps(), [(waiting, "Pia Pull".into(), "in".into(), at(2030, 11, 4, 9, 0))]);
    assert_eq!(sheet.ids("November 2030 Logs"), [waiting]);
    assert_eq!(w.pending(), 0);
}

/// Deleted by hand while the device was off. The startup sync makes it again
/// before it reads it, and that must not pass for the tab that was styled.
#[test]
fn a_staffers_tab_deleted_and_made_again_is_styled_and_given_its_dropdowns_again() {
    let w = World::new();
    let mut sheet = left_by(&[PIA], &[]);
    w.sync_at(&mut sheet, &at(2031, 1, 6, 9, 0));
    let count = |sheet: &Sheet| {
        let id = sheet.fake.id_of("Staffers").unwrap();
        (sheet.fake.batches_with("repeatCell", id), sheet.fake.batches_with("setDataValidation", id))
    };
    assert_eq!(count(&sheet), (1, 1));

    sheet.fake.delete_tab("Staffers");
    w.sync_at(&mut sheet, &at(2031, 1, 7, 9, 0));
    assert_eq!(count(&sheet), (1, 1), "the new tab, styled and shaped");
    assert_eq!(sheet.cell("Staffers", "G1"), "Card number");

    w.sync_at(&mut sheet, &at(2031, 1, 8, 9, 0));
    assert_eq!(count(&sheet), (1, 1), "once");
}
