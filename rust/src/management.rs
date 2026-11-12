use super::*;
use chrono::Datelike;
use slint::{Model, StandardListViewItem};
use std::collections::HashMap;
use tls_residency::{roster::Unlinked, Result};

#[cfg(test)]
#[path = "ui_parity.rs"]
mod ui_parity;

#[derive(Default)]
pub struct Data {
    users: Vec<User>,
    report: Vec<ReportRow>,
    visible: Vec<usize>,
    edit: Option<i64>,
    toggle: Option<(i64, bool)>,
    draft: Option<(PersonData, String)>,
    edit_drafts: HashMap<i64, PersonData>,
    recent: Vec<String>,
    unlinked: Vec<Unlinked>,
    months: Vec<(i32, u32)>,
    files: Vec<PathBuf>,
    file_kind: String,
    restore_path: PathBuf,
    report_range: (String, String),
    hours_seen: bool,
    page: usize,
    search: Timer,
}
fn strings(rows: impl IntoIterator<Item = String>) -> ModelRc<slint::SharedString> {
    model(rows.into_iter().map(Into::into).collect())
}
fn items(rows: impl IntoIterator<Item = String>) -> ModelRc<StandardListViewItem> {
    model(
        rows.into_iter()
            .map(|text| StandardListViewItem::from(slint::SharedString::from(text)))
            .collect(),
    )
}

// The dropdowns start on a prompt, as the web form's do.
const CHOOSE_SECTION: &str = "Choose section";
const CHOOSE_STATUS: &str = "Choose status";

pub fn connect(window: &AppWindow) {
    let ui = window.global::<Admin>();
    ui.set_sections(strings(
        std::iter::once(CHOOSE_SECTION.to_string()).chain(tls_residency::model::SECTIONS.map(str::to_owned)),
    ));
    ui.set_statuses(strings(
        std::iter::once(CHOOSE_STATUS.to_string()).chain(tls_residency::model::STATUSES.map(str::to_owned)),
    ));
    ui.on_navigate(|page| with_app(|app| app.navigate(&page)));
    ui.on_action(|action| {
        with_app(|app| {
            app.last_activity = Instant::now();
            app.action(&action);
        })
    });
    ui.on_activity(|| with_app(|app| app.last_activity = Instant::now()));
    ui.on_select_row(|index| with_app(|app| app.select_row(index)));
    ui.on_choose_card(|i| {
        with_app(|app| {
            if let Some(card) = app.data.recent.get(i as usize) {
                app.adm().set_card(card.into());
            }
        })
    });
    ui.on_choose_person(|i| {
        with_app(|app| {
            if let Some(row) = app.data.unlinked.get(i as usize) {
                let p = row.person.clone();
                let card = app.adm().get_card().to_string();
                app.fill_person(&p, &card);
            }
        })
    });
    ui.on_choose_month(|i| with_app(|app| app.choose_month(i)));
    ui.on_file_click(|i| {
        with_app(|app| {
            if let Some(path) = app.data.files.get(i as usize) {
                if path.is_file() {
                    app.adm().set_filename(
                        path.file_name()
                            .unwrap_or_default()
                            .to_string_lossy()
                            .as_ref()
                            .into(),
                    );
                }
            }
        })
    });
}
impl App {
    fn notice(&self, text: impl AsRef<str>, error: bool) {
        self.adm().set_notice(text.as_ref().into());
        self.adm().set_error(error);
    }
    fn form_person(&self) -> PersonData {
        let ui = self.adm();
        PersonData {
            name: ui.get_person_name().into(),
            student_id: ui.get_student_id().into(),
            section: Some(ui.get_section().to_string()).filter(|s| s != CHOOSE_SECTION).unwrap_or_default(),
            status: Some(ui.get_status().to_string()).filter(|s| s != CHOOSE_STATUS).unwrap_or_default(),
            telegram: ui.get_telegram().into(),
        }
    }
    fn fill_person(&self, p: &PersonData, card: &str) {
        let ui = self.adm();
        ui.set_person_name(p.name.as_str().into());
        ui.set_student_id(p.student_id.as_str().into());
        ui.set_section(if p.section.is_empty() { CHOOSE_SECTION } else { p.section.as_str() }.into());
        ui.set_status(if p.status.is_empty() { CHOOSE_STATUS } else { p.status.as_str() }.into());
        ui.set_telegram(p.telegram.as_str().into());
        ui.set_card(card.into());
    }
    pub fn management_status(&self) {
        let ui = self.adm();
        ui.set_sync_enabled(self.status.sync.is_some());
        if let Some(s) = &self.status.sync {
            let (_, bg, fg) = sync_look(&s.state);
            ui.set_sync_status(s.label.as_str().into());
            ui.set_sync_bg(bg);
            ui.set_sync_fg(fg);
        }
        match ui.get_page().as_str() {
            "system" => self.system_status(),
            "dashboard" => self.dashboard(),
            _ => {}
        }
    }
    // The web app's Dashboard: who is in, and the Google Sheet. Kept live.
    fn dashboard(&self) {
        let ui = self.adm();
        let rows =
            self.status
                .currently_in
                .iter()
                .map(|p| InRow {
                    name: p.name.as_str().into(),
                    section: p.section.as_str().into(),
                    status: p.status.as_str().into(),
                    since: self.core.config.dates.time(&p.since).into(),
                })
                .collect::<Vec<_>>();
        if !ui.get_in_rows().iter().eq(rows.iter().cloned()) {
            ui.set_in_rows(model(rows));
        }
        let sheet = match &self.status.sync {
            None => "Not set up. Set SHEETS_SPREADSHEET_ID in .env to sync with a Google Sheet.".to_string(),
            Some(s) => format!(
                    "{}\n{} uploaded · {} waiting\nLast synced: {}{}",
                    s.label, s.uploaded, s.pending,
                    s.last_synced_at.as_deref().map(|at| self.core.config.dates.full(at)).unwrap_or_else(|| "Not yet".into()),
                    self.core.sync_error().filter(|e| !e.is_empty()).map(|e| format!("\n{e}")).unwrap_or_default()
                ),
        };
        ui.set_sheet_text(sheet.into());
    }
    // Who the Staffers tab lists without a card, and its warnings.
    fn roster_notes(&mut self) {
        let notes = self.core.notes();
        self.adm().set_warnings(strings(notes.warnings.clone()));
        self.adm().set_link_rows(model(
            notes
                .unlinked
                .iter()
                .map(|u| LinkRow {
                    name: u.person.name.as_str().into(),
                    student_id: u.person.student_id.as_str().into(),
                    section: u.person.section.as_str().into(),
                    row: format!("Row {}", u.row).into(),
                })
                .collect(),
        ));
        self.data.unlinked = notes.unlinked;
    }
    // A month's first and last day, as the From and To boxes hold them.
    fn month_range(&self, y: i32, m: u32) -> (String, String) {
        let start = chrono::NaiveDate::from_ymd_opt(y, m, 1).unwrap();
        let next = if m == 12 { (y + 1, 1) } else { (y, m + 1) };
        let end = chrono::NaiveDate::from_ymd_opt(next.0, next.1, 1).unwrap() - chrono::Duration::days(1);
        (start.to_string(), end.to_string())
    }
    fn set_month_range(&self, y: i32, m: u32) {
        let (from, to) = self.month_range(y, m);
        self.adm().set_from(from.into());
        self.adm().set_to(to.into());
    }
    fn system_status(&self) {
        let notes = self.core.notes();
        let mut text = format!(
            "{}\nDatabase: {}\nBackups: {}\nTimezone: {}\nClock: {}\n\n{}",
            self.status
                .sync
                .as_ref()
                .map(|s| s.label.as_str())
                .unwrap_or("Sheets sync is disabled."),
            self.core.config.db_path.display(),
            self.core.config.backup_dir.display(),
            self.core.config.dates.0,
            if self.status.clock_ready {
                "Ready"
            } else {
                "Waiting for a reliable clock"
            },
            self.core.sync_error().unwrap_or_default()
        );
        if !notes.warnings.is_empty() {
            text.push_str("\n\nStaffers sheet warnings\n");
            text.push_str(&notes.warnings.join("\n"));
        }
        if !notes.unlinked.is_empty() {
            text.push_str("\n\nStaffers waiting for a card\n");
            for row in notes.unlinked {
                text.push_str(&format!(
                    "Row {}: {} · {} · {}\n",
                    row.row, row.person.name, row.person.student_id, row.person.section
                ));
            }
        }
        self.adm().set_diagnostics(text.into());
    }
    pub fn navigate(&mut self, page: &str) {
        if self.adm().get_busy() {
            return;
        }
        self.last_activity = Instant::now();
        self.data.search.stop();
        self.data.page = 0;
        self.remember_form();
        self.adm().set_restored_draft(false);
        self.notice("", false);
        if page == "station" {
            self.core.logout();
            self.adm().set_admin(false);
            self.adm().set_password("".into());
            self.manage_open = false;
            self.reader.reset();
            self.ui.set_managing(false);
            self.ui.invoke_focus_reader();
            return;
        }
        let page = if page != "register" && !self.core.authenticated() {
            "login"
        } else {
            page
        };
        self.adm().set_admin(self.core.authenticated());
        self.adm().set_page(page.into());
        if !self.manage_open {
            self.ui.set_managing(true);
            self.manage_open = true;
            self.reader.reset();
        }
        self.ui.invoke_focus_admin();
        self.management_status();
        match page {
            "register" => {
                self.data.edit = None;
                if let Some((p, card)) = &self.data.draft {
                    self.fill_person(p, card);
                    self.adm().set_restored_draft(true);
                } else {
                    self.fill_person(&PersonData::default(), "");
                }
                // Unknown cards as a table with when each was seen. Nothing is
                // filled in for you: with two new staffers, the newest card
                // could be the other person's.
                let unknown = self.core.unknown();
                self.adm().set_card_rows(model(
                    unknown
                        .iter()
                        .map(|(card, seen)| CardRow {
                            card: card.as_str().into(),
                            seen: self.core.config.dates.full(seen).into(),
                        })
                        .collect(),
                ));
                self.data.recent = unknown.into_iter().map(|(card, _)| card).collect();
                self.roster_notes();
            }
            "dashboard" => self.dashboard(),
            "people" => {
                self.roster_notes();
                self.load_people();
            }
            "hours" => {
                // Like the web page, Hours opens on the current month.
                if !self.data.hours_seen {
                    self.data.hours_seen = true;
                    let today = chrono::Utc::now().with_timezone(&self.core.config.dates.0).date_naive();
                    self.set_month_range(today.year(), today.month());
                }
                self.load_report();
            }
            "appearance" => {
                let a = &self.status.appearance;
                self.adm().set_panel_opacity(a.opacity as f32);
                self.adm().set_christmas(a.theme == "christmas");
                self.adm().set_hidden_rankings(a.hidden);
            }
            "system" => self.system_status(),
            _ => {}
        }
    }
    fn remember_form(&mut self) {
        let person = self.form_person();
        match self.adm().get_page().as_str() {
            "register" => {
                let card = self.adm().get_card().to_string();
                self.data.draft = (person != PersonData::default() || !card.is_empty()).then_some((person, card));
            }
            "edit" => {
                if let Some(id) = self.data.edit {
                    self.data.edit_drafts.insert(id, person);
                }
            }
            _ => {}
        }
    }
    fn job<T: Send + 'static>(
        &mut self,
        work: impl FnOnce(Arc<Core>) -> Result<T> + Send + 'static,
        done: impl FnOnce(&mut App, T) + Send + 'static,
    ) {
        if self.adm().get_busy() {
            return;
        }
        self.adm().set_busy(true);
        self.notice("", false);
        let core = Arc::clone(&self.core);
        std::thread::spawn(move || {
            let result = work(core);
            later(move |app| {
                app.adm().set_busy(false);
                app.last_activity = Instant::now();
                match result {
                    Ok(value) => done(app, value),
                    Err(e) => {
                        app.notice(e.to_string(), true);
                        if !app.core.authenticated() && app.adm().get_admin() {
                            app.remember_form();
                            app.adm().set_admin(false);
                            app.adm().set_page("login".into());
                        }
                    }
                }
            });
        });
    }
    fn load_people(&mut self) {
        self.job(
            |core| core.users(),
            |app, users| {
                app.data.users = users;
                app.filter_rows();
            },
        );
    }
    fn load_report(&mut self) {
        let from = self.adm().get_from().to_string();
        let to = self.adm().get_to().to_string();
        self.job(
            move |core| Ok((core.report(&from, &to)?, core.months()?, from, to)),
            |app, (report, months, from, to)| {
                // Tabs: Totals, then each month, newest first, as the web has them.
                let mut months = months;
                months.sort_by(|a, b| b.cmp(a));
                let on = if from.is_empty() && to.is_empty() {
                    0
                } else {
                    months
                        .iter()
                        .position(|&(y, m)| app.month_range(y, m) == (from.clone(), to.clone()))
                        .map_or(-1, |i| i as i32 + 1)
                };
                app.adm().set_month_on(on);
                let caption = if on == 0 {
                    "TOTALS".to_string()
                } else if on > 0 {
                    let (y, m) = months[(on - 1) as usize];
                    dates::Dates::title(y, m).to_uppercase()
                } else {
                    format!(
                        "{} TO {}",
                        if from.is_empty() { "FIRST RECORD" } else { &from },
                        if to.is_empty() { "LATEST RECORD" } else { &to }
                    )
                };
                app.adm().set_report_caption(caption.into());
                app.data.report_range = (from, to);
                app.data.report = report;
                app.adm().set_months(strings(
                    std::iter::once("Totals".to_string())
                        .chain(months.iter().map(|&(y, m)| dates::Dates::title(y, m))),
                ));
                app.data.months = months;
                app.filter_rows();
            },
        );
    }
    fn filter_rows(&mut self) {
        let window = self.ui.clone_strong();
        let ui = window.global::<Admin>();
        let query = ui.get_query().to_lowercase();
        let section = ui.get_section_filter();
        let status = ui.get_status_filter();
        let active = ui.get_active_filter();
        let matches = |name: &str, id: &str, card: &str, sec: &str, st: &str, on: bool| {
            (query.is_empty()
                || format!("{name} {id} {card}")
                    .to_lowercase()
                    .contains(&query))
                && (section == "All sections" || section == sec)
                && (status == "All statuses" || status == st)
                && (active == "All people" || (active == "Active") == on)
        };
        self.data.visible.clear();
        let mut matching = vec![];
        let sort = ui.get_sort_by();
        let key = |name: &str, id: &str, section: &str, status: &str| {
            match sort.as_str() {
                "ID number" => id, "Section" => section, "Status" => status, _ => name,
            }.to_lowercase()
        };
        if ui.get_page() == "people" {
            for (i, u) in self.data.users.iter().enumerate() {
                let p = &u.person;
                if matches(&p.name, &p.student_id, &u.rfid, &p.section, &p.status, u.active) {
                    matching.push((i, key(&p.name, &p.student_id, &p.section, &p.status)));
                }
            }
        } else {
            for (i, r) in self.data.report.iter().enumerate() {
                if matches(&r.name, &r.student_id, "", &r.section, &r.status, r.active) {
                    matching.push((i, key(&r.name, &r.student_id, &r.section, &r.status)));
                }
            }
        }
        matching.sort_by(|a, b| a.1.cmp(&b.1));
        if ui.get_sort_descending() { matching.reverse(); }
        const PAGE_SIZE: usize = 20;
        self.data.page = self.data.page.min(matching.len().saturating_sub(1) / PAGE_SIZE);
        let start = self.data.page * PAGE_SIZE;
        ui.set_has_previous(start > 0);
        ui.set_has_next(start + PAGE_SIZE < matching.len());
        ui.set_page_caption(if matching.is_empty() { "No matches".into() } else {
            format!("{}–{} of {}", start + 1, (start + PAGE_SIZE).min(matching.len()), matching.len()).into()
        });
        self.data.visible = matching.into_iter().skip(start).take(PAGE_SIZE).map(|(i, _)| i).collect();
        let mut people = vec![];
        let mut hours = vec![];
        if ui.get_page() == "people" {
            for &i in &self.data.visible {
                let u = &self.data.users[i];
                let p = &u.person;
                people.push(PersonRow {
                    name: p.name.as_str().into(),
                    student_id: p.student_id.as_str().into(),
                    section: p.section.as_str().into(),
                    status: p.status.as_str().into(),
                    telegram: p.telegram.as_str().into(),
                    card: u.rfid.as_str().into(),
                    active: u.active,
                    status_bg: status_colors(&p.status, self.christmas).0,
                    status_fg: status_colors(&p.status, self.christmas).1,
                });
            }
        } else {
            for &i in &self.data.visible {
                let r = &self.data.report[i];
                hours.push(HourRow {
                    name: r.name.as_str().into(),
                    student_id: r.student_id.as_str().into(),
                    hours: format!("{:.2}", r.hours).into(),
                    sessions: r.sessions.to_string().into(),
                    still_in: r.open,
                    uncounted: if r.uncounted.is_empty() { String::new() } else { r.uncounted.len().to_string() }.into(),
                    active: r.active,
                });
            }
        }
        ui.set_selected(-1);
        ui.set_selection_detail("".into());
        ui.set_people_rows(model(people));
        ui.set_hour_rows(model(hours));
    }
    fn selected_user(&self) -> Option<User> {
        self.data
            .visible
            .get(self.adm().get_selected() as usize)
            .and_then(|&i| self.data.users.get(i))
            .cloned()
    }
    fn select_row(&self, index: i32) {
        let Some(&i) = self.data.visible.get(index as usize) else {
            return;
        };
        if self.adm().get_page() == "people" {
            if let Some(u) = self.data.users.get(i) {
                self.adm()
                    .set_active_action(if u.active { "Deactivate" } else { "Reactivate" }.into());
                self.adm().set_selection_detail(
                    format!(
                        "{}\nID: {} · Card: {}\n{} · {} · {}",
                        u.person.name,
                        u.person.student_id,
                        u.rfid,
                        u.person.section,
                        u.person.status,
                        u.person.telegram
                    )
                    .into(),
                );
            }
        } else if let Some(r) = self.data.report.get(i) {
            let mut text = format!(
                "{} · {} · {}\n{:.2} hours · {} sessions",
                r.name, r.section, r.status, r.hours, r.sessions
            );
            for s in &r.uncounted {
                text.push_str(&format!(
                    "\nNot counted: {} · {}",
                    self.core.config.dates.full(&s.in_at),
                    if s.out_at.is_some() {
                        "invalid session"
                    } else {
                        "no tap out"
                    }
                ));
            }
            self.adm().set_selection_detail(text.into());
        }
    }
    fn choose_month(&mut self, index: i32) {
        if index == 0 {
            self.adm().set_from("".into());
            self.adm().set_to("".into());
        } else if let Some(&(y, m)) = self.data.months.get((index - 1) as usize) {
            let start = chrono::NaiveDate::from_ymd_opt(y, m, 1).unwrap();
            let next = if m == 12 { (y + 1, 1) } else { (y, m + 1) };
            let end = chrono::NaiveDate::from_ymd_opt(next.0, next.1, 1).unwrap()
                - chrono::Duration::days(1);
            self.adm().set_from(start.to_string().into());
            self.adm().set_to(end.to_string().into());
        } else {
            return;
        }
        self.load_report();
    }
    fn action(&mut self, action: &str) {
        if self.adm().get_busy() {
            return;
        }
        match action {
            "login" => {
                let user = self.adm().get_username();
                let pass = self.adm().get_password();
                self.adm().set_password("".into());
                if self.core.login(&user, &pass) {
                    self.navigate("dashboard");
                } else {
                    self.notice("Username or password is incorrect.", true);
                }
            }
            "logout" => self.navigate("station"),
            "escape" => {
                let page = self.adm().get_page();
                match page.as_str() {
                    "files" => {
                        let page = if self.data.file_kind == "image" {
                            "appearance"
                        } else if self.data.file_kind == "export" {
                            "hours"
                        } else {
                            "system"
                        };
                        self.navigate(page);
                    }
                    "restore" => self.navigate("system"),
                    "edit" => {
                        if let Some(id) = self.data.edit.take() {
                            self.data.edit_drafts.remove(&id);
                        }
                        self.navigate("people");
                    }
                    "confirm-active" => self.navigate("people"),
                    _ => self.navigate("station"),
                }
            }
            "search" => {
                self.data.search.start(TimerMode::SingleShot, Duration::from_millis(180), || {
                    with_app(|app| {
                        if !app.adm().get_busy() && matches!(app.adm().get_page().as_str(), "people" | "hours") {
                            app.data.page = 0;
                            app.filter_rows();
                        }
                    });
                });
            }
            "filter" => { self.data.search.stop(); self.data.page = 0; self.filter_rows(); }
            "previous-page" => { self.data.search.stop(); self.data.page = self.data.page.saturating_sub(1); self.filter_rows(); }
            "next-page" => { self.data.search.stop(); self.data.page += 1; self.filter_rows(); }
            "previous-month" | "next-month" | "this-month" => {
                let today = chrono::Utc::now().with_timezone(&self.core.config.dates.0).date_naive();
                let current = chrono::NaiveDate::parse_from_str(self.adm().get_from().as_str(), "%Y-%m-%d").unwrap_or(today);
                let offset = if action == "previous-month" { -1 } else if action == "next-month" { 1 } else { 0 };
                let base = if action == "this-month" { today } else { current };
                let month = base.year() * 12 + base.month0() as i32 + offset;
                self.set_month_range(month.div_euclid(12), month.rem_euclid(12) as u32 + 1);
                self.data.page = 0;
                self.load_report();
            }
            "refresh" => {
                if self.adm().get_page() == "hours" {
                    self.load_report();
                } else {
                    self.load_people();
                }
            }
            "report" => self.load_report(),
            "edit" => {
                if let Some(u) = self.selected_user() {
                    self.data.edit = Some(u.id);
                    self.adm().set_edit_title(format!("EDIT {}", u.person.name.to_uppercase()).into());
                    let draft = self.data.edit_drafts.get(&u.id);
                    self.fill_person(draft.unwrap_or(&u.person), &u.rfid);
                    self.adm().set_restored_draft(draft.is_some());
                    self.adm().set_page("edit".into());
                    self.notice("", false);
                }
            }
            "discard-draft" => {
                if self.adm().get_page() == "edit" {
                    if let Some(id) = self.data.edit {
                        self.data.edit_drafts.remove(&id);
                        if let Some(user) = self.data.users.iter().find(|u| u.id == id) {
                            self.fill_person(&user.person, &user.rfid);
                        }
                    }
                } else {
                    self.data.draft = None;
                    self.fill_person(&PersonData::default(), "");
                }
                self.adm().set_restored_draft(false);
            }
            "save-person" => {
                let person = self.form_person();
                let card = self.adm().get_card().to_string();
                let id = if self.adm().get_page() == "edit" {
                    self.data.edit
                } else {
                    None
                };
                self.job(
                    move |core| {
                        if let Some(id) = id {
                            core.edit(id, person)
                        } else {
                            core.register(person, &card).map(|_| ())
                        }
                    },
                    move |app, ()| {
                        if let Some(id) = id {
                            app.data.edit_drafts.remove(&id);
                            app.data.edit = None;
                            app.navigate("people");
                            app.notice("Person saved.", false);
                        } else {
                            app.data.draft = None;
                            app.adm().set_restored_draft(false);
                            app.fill_person(&PersonData::default(), "");
                            app.notice(
                                "ID registered. Return to the tap screen and tap to check in.",
                                false,
                            );
                        }
                    },
                );
            }
            "toggle-active" => {
                if let Some(u) = self.selected_user() {
                    self.data.toggle = Some((u.id, !u.active));
                    self.adm().set_active_action(if u.active { "Deactivate" } else { "Reactivate" }.into());
                    self.adm().set_selection_detail(
                        format!("{} · {} · {} · card {}", u.person.name, u.person.student_id, u.person.section, u.rfid).into(),
                    );
                    self.adm().set_page("confirm-active".into());
                    self.notice("", false);
                }
            }
            "confirm-active" => {
                if let Some((id, active)) = self.data.toggle {
                    self.job(
                        move |core| core.set_active(id, active),
                        |app, ()| {
                            app.data.toggle = None;
                            app.navigate("people");
                            app.notice("Person updated. Attendance history is kept.", false);
                        },
                    );
                }
            }
            "appearance" => {
                let opacity = self.adm().get_panel_opacity().round() as i32;
                let theme = if self.adm().get_christmas() {
                    "christmas"
                } else {
                    "none"
                };
                let hidden = self.adm().get_hidden_rankings();
                self.job(
                    move |core| core.appearance(opacity, theme, hidden),
                    |app, ()| app.notice("Appearance saved.", false),
                );
            }
            "remove-image" => self.job(
                |core| core.remove_background(),
                |app, ()| app.notice("Background removed.", false),
            ),
            "image" | "export" | "restore" => self.open_files(action),
            "backup" => self.job(
                |core| core.backup_now(),
                |app, path| app.notice(format!("Backup saved: {}", path.display()), false),
            ),
            "confirm-restore" => {
                let path = self.data.restore_path.clone();
                self.job(
                    move |core| core.restore(&path),
                    |app, (people, events, undo)| {
                        app.navigate("system");
                        app.notice(
                            format!(
                                "Restored {people} people and {events} taps. Previous data: {}",
                                undo.display()
                            ),
                            false,
                        );
                    },
                );
            }
            "system" => self.system_status(),
            "sync" => {
                self.core.sync_now();
                self.notice(
                    if self.core.config.spreadsheet_id.is_empty() {
                        "Sheets sync is disabled in configuration."
                    } else {
                        "Sync requested."
                    },
                    false,
                );
            }
            "folder" => self.list_files(),
            "backup-folder" => {
                let folder = self.core.config.backup_dir.clone();
                self.adm().set_folder(folder.to_string_lossy().as_ref().into());
                self.adm().set_filename("".into());
                self.list_files();
            }
            "usb-folder" => {
                self.job(|_| {
                    #[cfg(target_os = "windows")]
                    let paths = ('A'..='Z').map(|drive| PathBuf::from(format!("{drive}:\\")))
                        .filter(|path| path.is_dir()).collect::<Vec<_>>();
                    #[cfg(not(target_os = "windows"))]
                    let paths = {
                        let user = std::env::var("USER").unwrap_or_default();
                        [PathBuf::from("/media").join(&user), PathBuf::from("/run/media").join(&user), PathBuf::from("/mnt")]
                            .into_iter().filter(|root| root.is_dir()).flat_map(|root| {
                                std::fs::read_dir(root).into_iter().flatten().filter_map(|entry| entry.ok().map(|e| e.path()))
                            }).filter(|path| path.is_dir()).collect::<Vec<_>>()
                    };
                    Ok(paths)
                }, |app, paths| {
                    app.adm().set_file_selected(-1);
                    app.adm().set_filename("".into());
                    app.adm().set_files(items(paths.iter().map(|p| format!("[Drive] {}", p.display()))));
                    app.data.files = paths;
                    app.notice("Mounted drives: select a drive, then Open selected folder. USB drives must be mounted first.", false);
                });
            }
            "up" => {
                let folder = PathBuf::from(self.adm().get_folder().as_str());
                if let Some(parent) = folder.parent() {
                    self.adm()
                        .set_folder(parent.to_string_lossy().as_ref().into());
                    self.list_files();
                }
            }
            "open-folder" => {
                if let Some(path) = self
                    .data
                    .files
                    .get(self.adm().get_file_selected() as usize)
                {
                    if path.is_dir() {
                        self.adm()
                            .set_folder(path.to_string_lossy().as_ref().into());
                        self.list_files();
                    } else {
                        self.notice("Select a folder to open.", true);
                    }
                }
            }
            "choose-file" => self.choose_file(),
            _ => {}
        }
    }
    fn open_files(&mut self, kind: &str) {
        self.data.file_kind = kind.into();
        self.adm().set_page("files".into());
        self.adm().set_export_mode(kind == "export");
        self.adm().set_file_title(
            match kind {
                "image" => "Choose a background image",
                "export" => "Export hours as CSV",
                _ => "Choose a backup",
            }
            .into(),
        );
        self.adm().set_filename(
            if kind == "export" {
                format!(
                    "residency-hours-{}.csv",
                    chrono::Utc::now().format("%Y%m%d-%H%M%S")
                )
            } else {
                String::new()
            }
            .into(),
        );
        let folder = if kind == "restore" {
            self.core.config.backup_dir.clone()
        } else {
            self.core.data_dir()
        };
        let folder = if folder.is_absolute() {
            folder
        } else {
            std::env::current_dir().unwrap_or_default().join(folder)
        };
        self.adm()
            .set_folder(folder.to_string_lossy().as_ref().into());
        self.list_files();
    }
    fn list_files(&mut self) {
        let path = PathBuf::from(self.adm().get_folder().as_str());
        let kind = self.data.file_kind.clone();
        self.job(
            move |_| {
                let mut paths = std::fs::read_dir(&path)?
                    .map(|e| e.map(|e| e.path()))
                    .collect::<std::io::Result<Vec<_>>>()?;
                paths.retain(|p| {
                    p.is_dir()
                        || p.extension().and_then(|s| s.to_str()).is_some_and(|e| {
                            match kind.as_str() {
                                "image" => ["png", "jpg", "jpeg", "webp", "gif"]
                                    .contains(&e.to_lowercase().as_str()),
                                "restore" => e.eq_ignore_ascii_case("db"),
                                _ => e.eq_ignore_ascii_case("csv"),
                            }
                        })
                });
                paths.sort_by_key(|p| {
                    (
                        !p.is_dir(),
                        p.file_name()
                            .unwrap_or_default()
                            .to_string_lossy()
                            .to_lowercase(),
                    )
                });
                let labels = paths.iter().map(|p| {
                    let metadata = std::fs::metadata(p)?;
                    let modified: chrono::DateTime<chrono::Utc> = metadata.modified()?.into();
                    Ok(format!("{}{} · {} · {}",
                        if metadata.is_dir() { "[Folder] " } else { "" },
                        p.file_name().unwrap_or_default().to_string_lossy(),
                        modified.format("%Y-%m-%d %H:%M UTC"),
                        if metadata.is_dir() { "Folder".into() } else { format!("{} bytes", metadata.len()) }))
                }).collect::<std::io::Result<Vec<_>>>()?;
                Ok((paths, labels))
            },
            |app, (paths, labels)| {
                app.adm().set_file_selected(-1);
                if app.data.file_kind != "export" { app.adm().set_filename("".into()); }
                app.adm().set_files(items(labels));
                app.data.files = paths;
            },
        );
    }
    fn choose_file(&mut self) {
        let file = self.adm().get_filename();
        if file.trim().is_empty() {
            self.notice("Choose a file or enter its path.", true);
            return;
        }
        let path = PathBuf::from(self.adm().get_folder().as_str()).join(file.as_str());
        match self.data.file_kind.as_str() {
            "image" => self.job(
                move |core| core.background(&path),
                |app, ()| {
                    app.navigate("appearance");
                    app.notice("Background saved.", false);
                },
            ),
            "export" => {
                let (start, end) = self.data.report_range.clone();
                self.job(
                    move |core| {
                        core.export(&path, &start, &end)?;
                        Ok(path)
                    },
                    |app, path| {
                        app.navigate("hours");
                        app.notice(format!("CSV saved: {}", path.display()), false);
                    },
                );
            }
            _ => {
                self.job(move|_|{let counts=tls_residency::store::Store::verify_backup(&path)?;Ok((path,counts))},|app,(path,(people,events))|{
                app.adm().set_restore_detail(format!("{}\n{people} people · {events} taps\nSQLite integrity check passed.",path.display()).into());app.data.restore_path=path;app.adm().set_page("restore".into());
            });
            }
        }
    }
}
