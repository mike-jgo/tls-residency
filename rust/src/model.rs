use serde::{Deserialize, Serialize};

pub const SECTIONS: [&str; 9] = [
    "University",
    "Menagerie",
    "Sports",
    "Vanguard",
    "Intermedia",
    "Photo",
    "A&G",
    "Layout",
    "Web",
];
pub const STATUSES: [&str; 6] = ["Newbie", "Probie", "Regular", "EB", "EAL", "Dummy"];

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct Person {
    pub name: String,
    pub student_id: String,
    pub section: String,
    pub status: String,
    pub telegram: String,
}

impl Person {
    pub fn validated(mut self) -> crate::Result<Self> {
        self.name = self.name.trim().into();
        self.student_id = self.student_id.trim().into();
        self.section = self.section.trim().into();
        self.status = self.status.trim().into();
        self.telegram = self.telegram.trim().trim_start_matches('@').into();
        if self.name.is_empty() {
            return Err("A name is required.".into());
        }
        if self.student_id.is_empty() {
            return Err("An ID number is required.".into());
        }
        if !SECTIONS.contains(&self.section.as_str()) {
            return Err("Pick a section.".into());
        }
        if !STATUSES.contains(&self.status.as_str()) {
            return Err("Pick a status.".into());
        }
        if !self.telegram.is_empty() {
            if self.telegram.len() > 32
                || !self
                    .telegram
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'_')
            {
                return Err("A Telegram handle is letters, digits and underscores only.".into());
            }
            self.telegram.insert(0, '@');
        }
        Ok(self)
    }
}

pub fn valid_card(card: &str) -> bool {
    !card.is_empty() && card.len() <= 64 && card.bytes().all(|c| c.is_ascii_digit())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct User {
    pub id: i64,
    #[serde(flatten)]
    pub person: Person,
    pub rfid: String,
    pub active: bool,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Event {
    pub id: i64,
    pub user_id: i64,
    #[serde(rename = "type")]
    pub kind: String,
    pub ts: String,
    pub boot_id: Option<String>,
    pub request_id: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Tap {
    pub status: String,
    #[serde(default)]
    pub direction: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub time: String,
    #[serde(default)]
    pub rfid: String,
    #[serde(default)]
    pub stale: bool,
    #[serde(default)]
    pub replayed: bool,
    #[serde(default)]
    pub request_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Session {
    #[serde(rename = "inAt")]
    pub in_at: String,
    #[serde(rename = "outAt")]
    pub out_at: Option<String>,
    pub ms: i64,
    pub open: bool,
    pub invalid: bool,
}

pub fn sessions(events: &[Event], boot_id: &str) -> Vec<Session> {
    let mut rows = Vec::new();
    let mut open: Option<&Event> = None;
    let abandoned = |e: &Event| Session {
        in_at: e.ts.clone(),
        out_at: None,
        ms: 0,
        open: true,
        invalid: true,
    };
    for event in events {
        if event.kind == "in" {
            if let Some(previous) = open {
                rows.push(abandoned(previous));
            }
            open = Some(event);
        } else if let Some(previous) = open.take() {
            let duration = crate::dates::millis(&event.ts)
                .zip(crate::dates::millis(&previous.ts))
                .map(|(end, start)| end - start);
            let invalid = duration.is_none();
            rows.push(Session {
                in_at: previous.ts.clone(),
                out_at: Some(event.ts.clone()),
                ms: if invalid {
                    0
                } else {
                    duration.unwrap_or(0).max(0)
                },
                open: false,
                invalid,
            });
        }
    }
    if let Some(previous) = open {
        if previous.boot_id.as_deref() != Some(boot_id) {
            rows.push(abandoned(previous));
        } else {
            rows.push(Session {
                in_at: previous.ts.clone(),
                out_at: None,
                ms: 0,
                open: true,
                invalid: false,
            });
        }
    }
    rows
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReportRow {
    pub user_id: i64,
    pub name: String,
    pub student_id: String,
    pub section: String,
    pub status: String,
    pub active: bool,
    pub hours: f64,
    pub sessions: usize,
    pub open: bool,
    pub any: bool,
    pub uncounted: Vec<Session>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct SectionHours {
    pub section: String,
    pub hours: f64,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct StafferHours {
    pub name: String,
    pub section: String,
    pub hours: f64,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Boards {
    pub month: String,
    pub hidden: bool,
    pub sections: Vec<SectionHours>,
    pub staffers: Vec<StafferHours>,
}

pub fn leaderboards(report: &[ReportRow], month: String, hidden: bool) -> Boards {
    if hidden {
        return Boards {
            month,
            hidden,
            ..Boards::default()
        };
    }
    let mut sections: Vec<_> = SECTIONS
        .iter()
        .map(|s| SectionHours {
            section: (*s).into(),
            hours: (report
                .iter()
                .filter(|r| r.section == *s)
                .fold(0.0, |sum, r| sum + r.hours)
                * 100.0)
                .round()
                / 100.0,
        })
        .collect();
    sections.sort_by(|a, b| b.hours.total_cmp(&a.hours));
    let mut staffers: Vec<_> = report
        .iter()
        .filter(|r| r.active && r.hours > 0.0 && r.status != "EB" && r.status != "EAL")
        .map(|r| StafferHours {
            name: r.name.clone(),
            section: r.section.clone(),
            hours: r.hours,
        })
        .collect();
    staffers.sort_by(|a, b| {
        b.hours
            .total_cmp(&a.hours)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    staffers.truncate(10);
    Boards {
        month,
        hidden,
        sections,
        staffers,
    }
}

fn csv_cell(value: &str) -> String {
    let value = if value.starts_with(['=', '+', '-', '@', '\t', '\r']) {
        format!("'{value}")
    } else {
        value.into()
    };
    if value.contains([',', '"', '\r', '\n']) {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value
    }
}

pub fn hours_csv(report: &[ReportRow]) -> String {
    let mut lines =
        vec!["Name,Student ID,Hours,Sessions,Still in,Uncounted sessions,Deactivated".into()];
    for row in report {
        lines.push(
            [
                row.name.clone(),
                row.student_id.clone(),
                format!("{:.2}", row.hours),
                row.sessions.to_string(),
                if row.open { "yes" } else { "" }.into(),
                if row.uncounted.is_empty() {
                    String::new()
                } else {
                    row.uncounted.len().to_string()
                },
                if row.active { "" } else { "yes" }.into(),
            ]
            .iter()
            .map(|v| csv_cell(v))
            .collect::<Vec<_>>()
            .join(","),
        );
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    fn event(id: i64, kind: &str, time: &str, boot: &str) -> Event {
        Event {
            id,
            user_id: 1,
            kind: kind.into(),
            ts: time.into(),
            boot_id: Some(boot.into()),
            request_id: None,
        }
    }
    #[test]
    fn empty_section_totals_keep_the_original_order_and_positive_zero() {
        let board = leaderboards(&[], "November 2026".into(), false);
        assert_eq!(
            board
                .sections
                .iter()
                .map(|s| s.section.as_str())
                .collect::<Vec<_>>(),
            SECTIONS
        );
        assert!(board
            .sections
            .iter()
            .all(|s| s.hours == 0.0 && !s.hours.is_sign_negative()));
    }
    #[test]
    fn abandoned_sessions_earn_nothing_and_long_ones_count_in_full() {
        let rows = sessions(
            &[
                event(1, "in", "2026-01-05T01:00:00.000Z", "a"),
                event(2, "in", "2026-01-06T01:00:00.000Z", "b"),
                event(3, "out", "2026-01-06T13:11:00.000Z", "b"),
            ],
            "b",
        );
        assert_eq!(rows.len(), 2);
        assert!(rows[0].invalid && rows[0].ms == 0);
        assert!(!rows[1].invalid);
        assert_eq!(rows[1].ms, (12 * 60 + 11) * 60_000);
    }
    #[test]
    fn boot_identity_determines_whether_an_open_session_is_live() {
        let events = [event(1, "in", "2026-01-05T01:00:00.000Z", "a")];
        assert!(!sessions(&events, "a")[0].invalid);
        assert!(sessions(&events, "b")[0].invalid);
    }
    #[test]
    fn form_validation_preserves_leading_zeroes_and_normalizes_handles() {
        let p = Person {
            name: " Ana ".into(),
            student_id: "001".into(),
            section: "Web".into(),
            status: "Regular".into(),
            telegram: " @@ana ".into(),
        }
        .validated()
        .unwrap();
        assert_eq!(p.student_id, "001");
        assert_eq!(p.telegram, "@ana");
        assert!(valid_card("000123"));
        assert!(!valid_card("123x"));
        assert!(!valid_card(&"1".repeat(65)));
    }
    #[test]
    fn csv_neutralizes_formulas_and_quotes_multiline_names() {
        assert_eq!(csv_cell("=1+1"), "'=1+1");
        assert_eq!(csv_cell("A,\"B\""), "\"A,\"\"B\"\"\"");
    }
}
