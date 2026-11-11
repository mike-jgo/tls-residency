use crate::{
    dates::{self, Dates},
    model::{Event, Person, ReportRow, User},
    roster::{self, Unlinked},
    sheet_layout,
    sheets::{self, Error, Range, Result, Rows, Sheets, Tab},
    store::Store,
};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    sync::Mutex,
};

fn db<T>(store: &Mutex<Store>, work: impl FnOnce(&Store) -> crate::Result<T>) -> Result<T> {
    work(&store.lock().expect("database mutex poisoned")).map_err(Error::local)
}
#[derive(Debug, Clone, Default)]
pub struct Notes {
    pub warnings: Vec<String>,
    pub unlinked: Vec<Unlinked>,
}
pub struct Sync {
    pub client: Box<dyn Sheets>,
    pub target: String,
    pub notes: Notes,
    pulled: bool,
    refresh: bool,
    relabel: bool,
    /// The time a sync stamps on Totals and goes by for "this month". The
    /// real clock, except in tests, which pin it as the web tests do.
    pub clock: Box<dyn Fn() -> String + Send>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{model::Person, test_support::Fake};
    fn setup() -> (Mutex<Store>, Fake) {
        let store = Store::memory().unwrap();
        store
            .create(
                &Person {
                    name: "Ana".into(),
                    student_id: "001".into(),
                    section: "Web".into(),
                    status: "Regular".into(),
                    telegram: String::new(),
                },
                "111",
                true,
            )
            .unwrap();
        store.set_meta("sync_spreadsheet", "3:test").unwrap();
        let fake = Fake::default();
        fake.tab(
            "Staffers",
            vec![
                sheets::strings(&roster::HEADER),
                roster::row(&store.user(1).unwrap().unwrap()),
            ],
        );
        (Mutex::new(store), fake)
    }
    #[test]
    fn startup_keeps_pending_taps_and_original_boot_metadata() {
        let (store, fake) = setup();
        {
            let s = store.lock().unwrap();
            s.add_event(
                1,
                "in",
                "2026-01-05T01:00:00.123Z",
                Some("boot"),
                Some("first"),
            )
            .unwrap();
            s.add_event(
                1,
                "out",
                "2026-01-05T02:00:00.456Z",
                Some("boot"),
                Some("pending"),
            )
            .unwrap();
            s.set_meta("sync_event_id", "1").unwrap();
        }
        fake.tab(
            "January 2026 Logs",
            vec![
                sheets::strings(&sheet_layout::TAPS_HEADER),
                vec![
                    json!(1),
                    json!("2026-01-05"),
                    json!("09:00:00"),
                    json!("Ana"),
                    json!("001"),
                    json!("IN"),
                ],
            ],
        );
        let mut sync = Sync::new("test", Box::new(fake.clone()));
        sync.run(
            &store,
            "boot",
            Dates::new("Asia/Manila").unwrap(),
            36_000_000,
        )
        .unwrap();
        let s = store.lock().unwrap();
        let events = s.events().unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].boot_id.as_deref(), Some("boot"));
        assert_eq!(events[0].ts, "2026-01-05T01:00:00.123Z");
        assert_eq!(events[1].request_id.as_deref(), Some("pending"));
        assert_eq!(s.watermark().unwrap(), 2);
    }
    #[test]
    fn lost_upload_response_retries_the_same_cells_without_duplicate_taps() {
        let (store, fake) = setup();
        store
            .lock()
            .unwrap()
            .add_event(
                1,
                "in",
                "2026-01-05T01:00:00.000Z",
                Some("boot"),
                Some("pending"),
            )
            .unwrap();
        fake.0.lock().unwrap().fail_next_write = true;
        let mut sync = Sync::new("test", Box::new(fake.clone()));
        assert!(sync
            .run(
                &store,
                "boot",
                Dates::new("Asia/Manila").unwrap(),
                36_000_000
            )
            .is_err());
        assert_eq!(store.lock().unwrap().watermark().unwrap(), 0);
        sync.run(
            &store,
            "boot",
            Dates::new("Asia/Manila").unwrap(),
            36_000_000,
        )
        .unwrap();
        let state = fake.0.lock().unwrap();
        let logs = &state.cells["January 2026 Logs"];
        assert_eq!(logs.len(), 2);
        assert_eq!(logs[1][0], json!(1));
        assert_eq!(store.lock().unwrap().watermark().unwrap(), 1);
    }
    #[test]
    fn invalid_sheet_logs_leave_the_local_ledger_intact() {
        let (store, fake) = setup();
        store
            .lock()
            .unwrap()
            .add_event(1, "in", "2026-01-05T01:00:00.000Z", Some("boot"), None)
            .unwrap();
        fake.tab(
            "January 2026 Logs",
            vec![
                sheets::strings(&sheet_layout::TAPS_HEADER),
                vec![
                    json!(1),
                    json!("not a date"),
                    json!("09:00"),
                    json!("Ana"),
                    json!("001"),
                    json!("IN"),
                ],
            ],
        );
        let mut sync = Sync::new("test", Box::new(fake));
        assert!(sync
            .run(
                &store,
                "boot",
                Dates::new("Asia/Manila").unwrap(),
                36_000_000
            )
            .is_err());
        let s = store.lock().unwrap();
        assert_eq!(s.events().unwrap().len(), 1);
        assert_eq!(s.events().unwrap()[0].boot_id.as_deref(), Some("boot"));
    }
    #[test]
    fn pending_id_collision_is_renumbered_without_losing_receipt() {
        let (store, fake) = setup();
        {
            let s = store.lock().unwrap();
            s.add_event(
                1,
                "in",
                "2026-01-05T01:00:00.000Z",
                Some("boot"),
                Some("pending"),
            )
            .unwrap();
        }
        fake.tab(
            "January 2026 Logs",
            vec![
                sheets::strings(&sheet_layout::TAPS_HEADER),
                vec![
                    json!(1),
                    json!("2026-01-04"),
                    json!("09:00"),
                    json!("Ana"),
                    json!("001"),
                    json!("OUT"),
                ],
            ],
        );
        let mut sync = Sync::new("test", Box::new(fake));
        sync.run(
            &store,
            "boot",
            Dates::new("Asia/Manila").unwrap(),
            36_000_000,
        )
        .unwrap();
        let s = store.lock().unwrap();
        let events = s.events().unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[1].id, 2);
        assert_eq!(events[1].request_id.as_deref(), Some("pending"));
    }
}
impl Sync {
    pub fn new(id: &str, client: Box<dyn Sheets>) -> Self {
        Self {
            client,
            target: format!("3:{id}"),
            notes: Notes::default(),
            pulled: false,
            refresh: true,
            relabel: false,
            clock: Box::new(dates::now),
        }
    }
    pub fn refresh(&mut self) {
        self.refresh = true;
        self.relabel = true;
    }
    pub fn reset(&mut self) {
        self.pulled = false;
        self.refresh();
    }
    fn staffers(&mut self, store: &Mutex<Store>) -> Result<()> {
        let mut tabs = self.client.describe()?;
        if !tabs.iter().any(|t| t.title == "Staffers") {
            self.client.add_tabs(&["Staffers".into()], 9)?;
            tabs = self.client.describe()?;
        }
        let tab = tabs
            .iter()
            .find(|t| t.title == "Staffers")
            .ok_or_else(|| Error::local("Google did not create the Staffers tab."))?;
        let key = format!("{}:3:{}", self.target, tab.id);
        if db(store, |s| s.meta("sync_staffers"))?.as_deref() == Some(&key) {
            return Ok(());
        }
        for (title, address, start, end) in
            [("Staffers", "F1:G1", 5, 7), ("Search", "O4:P4", 14, 16)]
        {
            if let Some(tab) = tabs.iter().find(|t| t.title == title) {
                let header = self
                    .client
                    .read(&format!("{}!{address}", sheets::quote(title)))?;
                if header
                    .first()
                    .is_some_and(|r| sheets::cell(r, 0) == "Year" && sheets::cell(r, 1) == "Course")
                {
                    self.client.batch(vec![json!({"deleteDimension":{"range":{"sheetId":tab.id,"dimension":"COLUMNS","startIndex":start,"endIndex":end}}})])?;
                }
            }
        }
        self.client.batch(sheet_layout::staffers_shape(tab))?;
        db(store, |s| s.set_meta("sync_staffers", &key))
    }
    fn pull_roster(&mut self, store: &Mutex<Store>) -> Result<roster::Plan> {
        self.staffers(store)?;
        let values = self.client.read("'Staffers'!A1:G")?;
        let (users, seed) = db(store, |s| {
            Ok((s.users()?, s.meta("sync_seed")?.as_deref() == Some("1")))
        })?;
        let plan = roster::pull(&users, &values, seed);
        db(store, |s| plan.apply(s))?;
        self.client.write(&plan.writes, false)?;
        if seed {
            db(store, |s| s.set_meta("sync_seed", "0"))?;
        }
        self.notes = Notes {
            warnings: plan.warnings.clone(),
            unlinked: plan.unlinked.clone(),
        };
        if !plan.update.is_empty() {
            self.relabel = true;
        }
        Ok(plan)
    }
    pub fn save(&mut self, store: &Mutex<Store>, wanted: &User, own: Option<&User>) -> Result<()> {
        self.staffers(store)?;
        let rows = self.client.read("'Staffers'!A1:G")?;
        let writes = roster::place(&rows, wanted, own).map_err(Error::local)?;
        self.client.write(&writes, false)?;
        Ok(())
    }
    fn pull_taps(
        &mut self,
        store: &Mutex<Store>,
        tabs: &[Tab],
        formerly: &HashMap<String, i64>,
        unlisted: &[i64],
        dates: Dates,
    ) -> Result<()> {
        let mut logs: Vec<_> = tabs
            .iter()
            .filter(|t| t.title.ends_with(" Logs") && Dates::month_of_title(&t.title).is_some())
            .collect();
        logs.sort_by_key(|t| Dates::month_of_title(&t.title));
        let mut read = vec![];
        let mut tidy = true;
        let mut numbers = HashSet::new();
        for tab in logs {
            let rows = self
                .client
                .read(&format!("{}!A2:F", sheets::quote(&tab.title)))?;
            let mut last = 0;
            for (i, cells) in rows.iter().enumerate() {
                let cells: Vec<_> = (0..6).map(|i| sheets::cell(cells, i)).collect();
                if cells.iter().all(String::is_empty) {
                    tidy = false;
                    continue;
                }
                let where_ = format!("{}, row {}", tab.title, i + 2);
                let ts = dates.instant(&cells[1], &cells[2]).map_err(|_| {
                    Error::local(format!(
                        "Cannot read the taps: {where_} has an invalid date or time."
                    ))
                })?;
                let kind = cells[5].to_lowercase();
                if kind != "in" && kind != "out" {
                    return Err(Error::local(format!(
                        "Cannot read the taps: {where_} must say IN or OUT."
                    )));
                }
                if cells[3].is_empty() && cells[4].is_empty() {
                    return Err(Error::local(format!(
                        "Cannot read the taps: {where_} has no name or ID."
                    )));
                }
                let id = cells[0]
                    .replace(',', "")
                    .parse::<i64>()
                    .ok()
                    .filter(|n| *n > 0);
                let month = dates.month(&ts).map_err(Error::local)?;
                if id.is_none_or(|n| n <= last || numbers.contains(&n))
                    || format!("{} Logs", Dates::title(month.0, month.1)) != tab.title
                {
                    tidy = false;
                } else {
                    last = id.unwrap();
                    numbers.insert(last);
                }
                read.push((
                    id.unwrap_or(0),
                    ts,
                    kind,
                    cells[3].clone(),
                    cells[4].clone(),
                ));
            }
        }
        if !tidy {
            read.sort_by(|a, b| a.1.cmp(&b.1));
            for (i, row) in read.iter_mut().enumerate() {
                row.0 = (i + 1) as i64;
            }
        }
        let top = read.iter().map(|r| r.0).max().unwrap_or(0);
        db(store, |s| {
            s.transaction(|s| {
                let mut users = s.users()?;
                let all = s.events()?;
                let mark = s.watermark()?;
                let mine: HashMap<_, _> = all
                    .iter()
                    .filter(|e| e.id <= mark)
                    .map(|e| (e.id, e))
                    .collect();
                let waiting: Vec<_> = all.iter().filter(|e| e.id > mark).collect();
                let clash = waiting.first().is_some_and(|e| e.id <= top);
                let mut events = vec![];
                for (id, ts, kind, name, student_id) in &read {
                    let named: Vec<_> = users.iter().filter(|u| u.person.name == *name).collect();
                    let whose = if !student_id.is_empty() {
                        users
                            .iter()
                            .find(|u| u.person.student_id == *student_id)
                            .map(|u| u.id)
                            .or_else(|| formerly.get(student_id).copied())
                    } else {
                        None
                    }
                    .or_else(|| {
                        if named.len() == 1 {
                            Some(named[0].id)
                        } else {
                            None
                        }
                    });
                    let user_id = if let Some(id) = whose {
                        id
                    } else {
                        let person = Person {
                            name: if name.is_empty() {
                                student_id.clone()
                            } else {
                                name.clone()
                            },
                            student_id: student_id.clone(),
                            ..Person::default()
                        };
                        let id = s.create(
                            &person,
                            &format!(
                                "none:{}",
                                if student_id.is_empty() {
                                    name
                                } else {
                                    student_id
                                }
                            ),
                            false,
                        )?;
                        users.push(s.user(id)?.expect("created person exists"));
                        id
                    };
                    let own = mine.get(id).filter(|e| {
                        e.user_id == user_id
                            && e.kind == *kind
                            && dates::millis(&e.ts).map(|n| n / 1000 * 1000) == dates::millis(ts)
                    });
                    events.push(own.map(|e| (*e).clone()).unwrap_or_else(|| Event {
                        id: *id,
                        user_id,
                        kind: kind.clone(),
                        ts: ts.clone(),
                        boot_id: None,
                        request_id: None,
                    }));
                }
                for e in waiting {
                    let mut e = e.clone();
                    if clash {
                        e.id = 0;
                    }
                    events.push(e);
                }
                s.replace_events(&events)?;
                for id in unlisted {
                    s.delete_unlisted(*id)?;
                }
                s.set_meta("sync_event_id", &top.to_string())?;
                if !tidy {
                    s.set_meta("sync_event_id", "0")?;
                    s.set_meta("sync_full", "1")?;
                }
                Ok(())
            })
        })?;
        self.pulled = true;
        Ok(())
    }
    fn log_ranges(store: &Store, events: &[Event], dates: Dates) -> crate::Result<Vec<Range>> {
        let all = store.events()?;
        let users: HashMap<_, _> = store.users()?.into_iter().map(|u| (u.id, u)).collect();
        let mut months: BTreeMap<(i32, u32), Vec<&Event>> = BTreeMap::new();
        for event in events {
            months
                .entry(dates.month(&event.ts)?)
                .or_default()
                .push(event);
        }
        let mut out = vec![];
        for ((y, m), events) in months {
            let title = sheets::quote(&format!("{} Logs", Dates::title(y, m)));
            let (start, end) = dates.month_bounds(y, m)?;
            let first = 2 + all
                .iter()
                .filter(|e| e.id < events[0].id && e.ts >= start && e.ts < end)
                .count();
            let mut rows = vec![];
            for e in &events {
                let p = &users.get(&e.user_id).ok_or("A tap has no person.")?.person;
                let stamp = dates.stamp(&e.ts)?;
                rows.push(vec![
                    json!(e.id),
                    json!(&stamp[..10]),
                    json!(&stamp[11..]),
                    json!(p.name),
                    json!(p.student_id),
                    json!(e.kind.to_uppercase()),
                ]);
            }
            out.push(sheets::range(
                format!("{title}!A1:F1"),
                vec![sheets::strings(&sheet_layout::TAPS_HEADER)],
            ));
            out.push(sheets::range(
                format!("{title}!A{first}:F{}", first + events.len() - 1),
                rows,
            ));
        }
        Ok(out)
    }
    fn hours_row(r: &ReportRow) -> Vec<Value> {
        vec![
            json!(r.name),
            json!(r.student_id),
            json!(r.hours),
            json!(r.sessions),
            json!(if r.open { "yes" } else { "" }),
            if r.uncounted.is_empty() {
                json!("")
            } else {
                json!(r.uncounted.len())
            },
            json!(if r.active { "" } else { "yes" }),
        ]
    }
    fn pad(mut rows: Rows, height: usize) -> Rows {
        while rows.len() < height {
            rows.push(vec![json!(""); 7]);
        }
        rows
    }
    fn upload(
        &mut self,
        store: &Mutex<Store>,
        boot: &str,
        dates: Dates,
        max_ms: i64,
        all_months: bool,
    ) -> Result<bool> {
        let now = (self.clock)();
        let (current_y, current_m) = dates.month(&now).map_err(Error::local)?;
        let (pending, from_top, height, first, last) = db(store, |s| {
            let events = s.events()?;
            let mark = s.watermark()?;
            let pending = events
                .iter()
                .filter(|e| e.id > mark)
                .take(2000)
                .cloned()
                .collect::<Vec<_>>();
            Ok((
                pending,
                s.meta("sync_full")?.as_deref() == Some("1"),
                s.users()?.len().max(1),
                events.iter().map(|e| e.ts.clone()).min(),
                events.iter().map(|e| e.ts.clone()).max(),
            ))
        })?;
        let mut months = HashSet::from([(current_y, current_m)]);
        if all_months || from_top {
            if let (Some(a), Some(b)) = (first, last) {
                months.extend(dates.months(&a, &b).map_err(Error::local)?);
            }
        }
        let mut log_titles = HashSet::new();
        for e in &pending {
            let (y, m) = dates.month(&e.ts).map_err(Error::local)?;
            months.insert((y, m));
            log_titles.insert(format!("{} Logs", Dates::title(y, m)));
            let start = dates.month_bounds(y, m).map_err(Error::local)?.0;
            if e.kind == "out"
                && dates::millis(&e.ts).unwrap_or(0) - dates::millis(&start).unwrap_or(0) <= max_ms
            {
                let prior = dates::iso(
                    chrono::DateTime::from_timestamp_millis(dates::millis(&start).unwrap() - 1)
                        .unwrap(),
                );
                months.insert(dates.month(&prior).map_err(Error::local)?);
            }
        }
        let data = db(store, |s| {
            let mut out = Self::log_ranges(s, &pending, dates)?;
            let mut ordered: Vec<_> = months.iter().copied().collect();
            ordered.sort();
            for (y, m) in ordered {
                let title = sheets::quote(&Dates::title(y, m));
                let (start, end) = dates.month_bounds(y, m)?;
                let rows = s
                    .report(boot, max_ms, Some(&start), Some(&end))?
                    .iter()
                    .filter(|r| r.active || r.any)
                    .map(Self::hours_row)
                    .collect();
                out.push(sheets::range(
                    format!("{title}!A1:G1"),
                    vec![sheets::strings(&sheet_layout::HOURS_HEADER)],
                ));
                out.push(sheets::range(
                    format!("{title}!A2:G{}", height + 1),
                    Self::pad(rows, height),
                ));
            }
            let mut totals = vec![
                vec![
                    json!("Last synced"),
                    json!(dates.stamp(&now)?),
                    json!(""),
                    json!(""),
                    json!(""),
                    json!(""),
                    json!(""),
                ],
                vec![
                    json!("All-time hours"),
                    json!(""),
                    json!(""),
                    json!(""),
                    json!(""),
                    json!(""),
                    json!(""),
                ],
                sheets::strings(&sheet_layout::HOURS_HEADER),
            ];
            totals.extend(Self::pad(
                s.report(boot, max_ms, None, None)?
                    .iter()
                    .map(Self::hours_row)
                    .collect(),
                height,
            ));
            out.push(sheets::range(
                format!("'Totals'!A1:G{}", height + 3),
                totals,
            ));
            Ok(out)
        })?;
        let mut tabs = self.client.describe()?;
        let have: HashSet<_> = tabs.iter().map(|t| t.title.clone()).collect();
        if from_top {
            let ranges = tabs
                .iter()
                .filter(|t| t.title == "Totals" || Dates::month_of_title(&t.title).is_some())
                .map(|t| format!("{}!A2:H", sheets::quote(&t.title)))
                .collect::<Vec<_>>();
            self.client.clear(&ranges)?;
        }
        let mut missing: HashSet<_> = months
            .iter()
            .map(|(y, m)| Dates::title(*y, *m))
            .chain(log_titles.iter().cloned())
            .chain(["Totals".into(), "Staffers".into()])
            .filter(|t| !have.contains(t))
            .collect();
        let mut titles: Vec<_> = missing.drain().collect();
        titles.sort();
        self.client.add_tabs(&titles, 9)?;
        if !have.contains("Search") {
            self.client.add_tabs(&["Search".into()], 24)?;
        }
        if !titles.is_empty() || !have.contains("Search") {
            tabs = self.client.describe()?;
        }
        let dressing = tabs.iter().flat_map(sheet_layout::dress).collect();
        self.client.batch(dressing)?;
        let style_key = format!("{}:3", self.target);
        let memo: Value = db(store, |s| s.meta("sync_styled"))?
            .and_then(|v| serde_json::from_str(&v).ok())
            .unwrap_or(json!({}));
        let mut styled: HashSet<String> =
            if memo.get("key").and_then(Value::as_str) == Some(&style_key) {
                memo.get("ids")
                    .and_then(Value::as_array)
                    .map(|v| {
                        v.iter()
                            .filter_map(|i| i.as_str().map(str::to_owned))
                            .collect()
                    })
                    .unwrap_or_default()
            } else {
                HashSet::new()
            };
        let mut formats = vec![];
        for tab in &tabs {
            if !styled.contains(&tab.id.to_string()) {
                let requests = sheet_layout::style(tab);
                if !requests.is_empty() {
                    formats.extend(requests);
                    styled.insert(tab.id.to_string());
                }
            }
        }
        self.client.batch(formats)?;
        styled.retain(|id| tabs.iter().any(|t| t.id.to_string() == *id));
        let mut ids: Vec<_> = styled.into_iter().collect();
        ids.sort();
        db(store, |s| {
            s.set_meta(
                "sync_styled",
                &json!({"key":style_key,"ids":ids}).to_string(),
            )
        })?;
        self.staffers(store)?;
        self.client.write(&data, false)?;
        let mut month_tabs: Vec<_> = tabs
            .iter()
            .filter(|t| Dates::month_of_title(&t.title).is_some())
            .map(|t| t.title.clone())
            .collect();
        month_tabs.sort_by_key(|t| std::cmp::Reverse(Dates::month_of_title(t)));
        let wanted = json!([self.target, 4, month_tabs]).to_string();
        if !have.contains("Search")
            || db(store, |s| s.meta("sync_search"))?.as_deref() != Some(&wanted)
        {
            self.client.write(&sheet_layout::search(&tabs), true)?;
            db(store, |s| s.set_meta("sync_search", &wanted))?;
        }
        db(store, |s| {
            s.transaction(|s| {
                if from_top {
                    s.set_meta("sync_full", "0")?;
                }
                if let Some(last) = pending.last() {
                    s.set_meta("sync_event_id", &last.id.to_string())?;
                }
                s.set_meta("sync_last_at", &now)
            })
        })?;
        let written: HashSet<_> = months
            .iter()
            .map(|(y, m)| Dates::title(*y, *m))
            .chain(log_titles)
            .chain(["Totals".into()])
            .collect();
        self.client.batch(tabs.iter().filter(|t|written.contains(&t.title)).map(|t|json!({"autoResizeDimensions":{"dimensions":{"sheetId":t.id,"dimension":"COLUMNS"}}})).collect())?;
        Ok(pending.len() == 2000)
    }
    pub fn run(
        &mut self,
        store: &Mutex<Store>,
        boot: &str,
        dates: Dates,
        max_ms: i64,
    ) -> Result<()> {
        let result = self.run_inner(store, boot, dates, max_ms);
        if result.is_err() {
            self.refresh = true;
        }
        result
    }
    fn run_inner(
        &mut self,
        store: &Mutex<Store>,
        boot: &str,
        dates: Dates,
        max_ms: i64,
    ) -> Result<()> {
        let (from_top, target) = db(store, |s| {
            Ok((
                s.meta("sync_full")?.as_deref() == Some("1"),
                s.meta("sync_spreadsheet")?,
            ))
        })?;
        if from_top {
            db(store, |s| s.set_meta("sync_spreadsheet", &self.target))?;
            self.pulled = true;
        } else if target.as_deref() != Some(&self.target) {
            db(store, |s| {
                s.transaction(|s| {
                    s.set_meta("sync_event_id", &s.last_id()?.to_string())?;
                    s.set_meta("sync_spreadsheet", &self.target)
                })
            })?;
        }
        let mut all = self.refresh;
        self.refresh = false;
        self.staffers(store)?;
        let mut pulled_now = false;
        if !self.pulled {
            let tabs = self.client.describe()?;
            let formerly = db(store, |s| {
                Ok(s.users()?
                    .into_iter()
                    .filter(|u| !u.person.student_id.is_empty())
                    .map(|u| (u.person.student_id, u.id))
                    .collect())
            })?;
            let plan = self.pull_roster(store)?;
            self.pull_taps(store, &tabs, &formerly, &plan.unlisted, dates)?;
            pulled_now = true;
            all = true;
        }
        while self.upload(store, boot, dates, max_ms, all)? {
            all = false;
        }
        if !pulled_now && self.pull_roster(store)?.changed() {
            self.upload(store, boot, dates, max_ms, true)?;
        }
        if self.relabel {
            let ranges = db(store, |s| {
                let mark = s.watermark()?;
                let events: Vec<_> = s.events()?.into_iter().filter(|e| e.id <= mark).collect();
                Self::log_ranges(s, &events, dates)
            })?;
            for chunk in ranges.chunks(200) {
                self.client.write(chunk, false)?;
            }
            self.relabel = false;
        }
        Ok(())
    }
}
