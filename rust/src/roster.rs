use crate::{
    model::{valid_card, Person, User},
    sheets::{self, Range, Rows},
    store::Store,
    Result,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

pub const HEADER: [&str; 7] = [
    "Name",
    "ID number",
    "Section",
    "Status",
    "Telegram",
    "Deactivated",
    "Card number",
];
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Unlinked {
    pub row: usize,
    pub person: Person,
}
#[derive(Default)]
pub struct Plan {
    pub create: Vec<(Person, String, bool)>,
    pub update: Vec<(i64, Person, String, bool)>,
    pub deactivate: Vec<i64>,
    pub unlisted: Vec<i64>,
    pub writes: Vec<Range>,
    pub warnings: Vec<String>,
    pub unlinked: Vec<Unlinked>,
}
pub fn row(user: &User) -> Vec<Value> {
    let p = &user.person;
    vec![
        json!(p.name),
        json!(p.student_id),
        json!(p.section),
        json!(p.status),
        json!(p.telegram),
        json!(if user.active { "" } else { "yes" }),
        json!(user.rfid),
    ]
}
fn clean(row: &[Value]) -> Vec<Value> {
    (0..7)
        .map(|i| {
            let mut value = sheets::cell(row, i);
            if i == 4 {
                let handle = value.trim_start_matches('@');
                if !handle.is_empty()
                    && handle.len() <= 32
                    && handle
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'_')
                {
                    value = format!("@{handle}");
                }
            }
            if i == 5 && value.eq_ignore_ascii_case("yes") {
                value = "yes".into();
            }
            json!(value)
        })
        .collect()
}
fn person(row: &[Value]) -> Result<Person> {
    Person {
        name: sheets::cell(row, 0),
        student_id: sheets::cell(row, 1),
        section: sheets::cell(row, 2),
        status: sheets::cell(row, 3),
        telegram: sheets::cell(row, 4),
    }
    .validated()
}
fn scanned(values: &Rows) -> (Vec<(usize, Vec<Value>)>, Vec<Range>, usize) {
    let header = sheets::strings(&HEADER);
    // Compared cell by cell as typed: `clean` is for staffer rows, and would
    // turn the "Telegram" heading into a handle, so the header never matched
    // and was rewritten on every sync and save.
    let typed = values
        .first()
        .map(|r| (0..HEADER.len()).map(|i| json!(sheets::cell(r, i))).collect::<Vec<_>>());
    let writes = if typed == Some(header.clone()) {
        vec![]
    } else {
        vec![sheets::range("'Staffers'!A1:G1", vec![header])]
    };
    let rows = values
        .iter()
        .enumerate()
        .skip(1)
        .map(|(i, r)| (i + 1, clean(r)))
        .filter(|(_, r)| r.iter().any(|c| !c.as_str().unwrap_or_default().is_empty()))
        .collect();
    (rows, writes, values.len().max(1) + 1)
}
pub fn pull(users: &[User], values: &Rows, seed: bool) -> Plan {
    let (rows, writes, mut next) = scanned(values);
    let mut plan = Plan {
        writes,
        ..Plan::default()
    };
    let mut counts = [
        HashMap::<String, usize>::new(),
        HashMap::<String, usize>::new(),
    ];
    for (_, r) in &rows {
        for (i, col) in [1, 6].iter().enumerate() {
            let v = sheets::cell(r, *col);
            if !v.is_empty() {
                *counts[i].entry(v).or_default() += 1;
            }
        }
    }
    let mut skipped_ids = HashSet::new();
    let mut skipped_cards = HashSet::new();
    let mut taken = HashSet::new();
    let mut good: Vec<(usize, Vec<Value>, Person, Option<i64>)> = vec![];
    let mut cardless = vec![];
    let mut skip = |n: usize, r: &[Value], why: String, warnings: &mut Vec<String>| {
        warnings.push(format!("Row {n} ({}): {why}", sheets::cell(r, 0)));
        skipped_ids.insert(sheets::cell(r, 1));
        skipped_cards.insert(sheets::cell(r, 6));
    };
    for (n, r) in rows {
        let id = sheets::cell(&r, 1);
        let card = sheets::cell(&r, 6);
        let off = sheets::cell(&r, 5);
        let p = person(&r);
        let problem = if id.is_empty() {
            Some("No ID number.".into())
        } else if counts[0].get(&id).is_some_and(|n| *n > 1) {
            Some(format!("ID number {id} is on more than one row."))
        } else if counts[1].get(&card).is_some_and(|n| *n > 1) {
            Some(format!("Card number {card} is on more than one row."))
        } else if !off.is_empty() && off != "yes" {
            Some("Deactivated must be yes or empty.".into())
        } else if !card.is_empty() && !valid_card(&card) {
            Some("The card number must be all digits.".into())
        } else {
            p.as_ref().err().map(ToString::to_string)
        };
        if let Some(why) = problem {
            skip(n, &r, why, &mut plan.warnings);
            continue;
        }
        if card.is_empty() {
            cardless.push((n, r, p.unwrap()));
        } else {
            good.push((n, r, p.unwrap(), None));
        }
    }
    for by_id in [true, false] {
        for (_, r, _, matched) in &mut good {
            if matched.is_some() {
                continue;
            }
            if let Some(user) = users.iter().find(|u| {
                !taken.contains(&u.id)
                    && if by_id {
                        u.person.student_id == sheets::cell(r, 1)
                    } else {
                        u.rfid == sheets::cell(r, 6)
                    }
            }) {
                *matched = Some(user.id);
                taken.insert(user.id);
            }
        }
    }
    loop {
        let before = good.len();
        let moving: HashSet<_> = good.iter().filter_map(|r| r.3).collect();
        good.retain(|(n, r, _, _)| {
            if let Some(holder) = users
                .iter()
                .find(|u| u.rfid == sheets::cell(r, 6) && !moving.contains(&u.id))
            {
                skip(
                    *n,
                    r,
                    format!(
                        "Card number {} belongs to {} on this device.",
                        holder.rfid, holder.person.name
                    ),
                    &mut plan.warnings,
                );
                false
            } else {
                true
            }
        });
        if before == good.len() {
            break;
        }
    }
    drop(skip);
    for (_, r, p, matched) in good {
        let card = sheets::cell(&r, 6);
        let active = sheets::cell(&r, 5) != "yes";
        if let Some(id) = matched {
            if users
                .iter()
                .find(|u| u.id == id)
                .is_some_and(|u| row(u) != r)
            {
                plan.update.push((id, p, card, active));
            }
        } else {
            plan.create.push((p, card, active));
        }
    }
    for (n, r, p) in cardless {
        if let Some(user) = users
            .iter()
            .find(|u| !taken.contains(&u.id) && u.person.student_id == sheets::cell(&r, 1))
        {
            taken.insert(user.id);
            plan.warnings
                .push(format!("Row {n} ({}): no card number.", p.name));
        } else {
            plan.unlinked.push(Unlinked { row: n, person: p });
        }
    }
    for u in users {
        if taken.contains(&u.id)
            || skipped_ids.contains(&u.person.student_id)
            || skipped_cards.contains(&u.rfid)
        {
            continue;
        }
        if seed {
            plan.writes.push(sheets::range(
                format!("'Staffers'!A{next}:G{next}"),
                vec![row(u)],
            ));
            next += 1;
        } else {
            plan.unlisted.push(u.id);
            if u.active {
                plan.deactivate.push(u.id);
            }
        }
    }
    plan
}
impl Plan {
    pub fn changed(&self) -> bool {
        !self.create.is_empty() || !self.update.is_empty() || !self.deactivate.is_empty()
    }
    pub fn apply(&self, store: &Store) -> Result<()> {
        store.transaction(|s| {
            for (id, _, _, _) in &self.update {
                s.set_card(*id, &format!("moving:{id}"))?;
            }
            for (id, p, card, active) in &self.update {
                s.update(*id, p)?;
                s.set_card(*id, card)?;
                s.set_active(*id, *active)?;
            }
            for (p, card, active) in &self.create {
                s.create(p, card, *active)?;
            }
            for id in &self.deactivate {
                s.set_active(*id, false)?;
            }
            Ok(())
        })
    }
}
pub fn place(values: &Rows, wanted: &User, own: Option<&User>) -> Result<Vec<Range>> {
    let (rows, mut writes, next) = scanned(values);
    let mine = if let Some(own) = own {
        rows.iter()
            .find(|(_, r)| {
                !own.person.student_id.is_empty() && sheets::cell(r, 1) == own.person.student_id
            })
            .or_else(|| rows.iter().find(|(_, r)| sheets::cell(r, 6) == own.rfid))
    } else {
        rows.iter().find(|(_, r)| {
            sheets::cell(r, 1) == wanted.person.student_id && sheets::cell(r, 6).is_empty()
        })
    };
    if let (Some(own), Some((n, theirs))) = (own, mine) {
        let mut theirs = theirs.clone();
        if sheets::cell(&theirs, 6).is_empty() {
            theirs[6] = json!(own.rfid);
        }
        if theirs != row(own) {
            return Err(format!("The sheet's details for {} (row {n}) have changed. Sync, check them, then make the change again.",own.person.name).into());
        }
    }
    for (n, r) in &rows {
        if mine.is_some_and(|(number, _)| number == n) {
            continue;
        }
        if sheets::cell(r, 1) == wanted.person.student_id {
            return Err(format!(
                "ID number {} already belongs to {} (row {n} of the sheet).",
                wanted.person.student_id,
                sheets::cell(r, 0)
            )
            .into());
        }
        if sheets::cell(r, 6) == wanted.rfid {
            return Err(format!(
                "That card number already belongs to {} (row {n} of the sheet).",
                sheets::cell(r, 0)
            )
            .into());
        }
    }
    let n = mine.map_or(next, |(n, _)| *n);
    writes.push(sheets::range(
        format!("'Staffers'!A{n}:G{n}"),
        vec![row(wanted)],
    ));
    Ok(writes)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn user(id: i64, name: &str, card: &str) -> User {
        User {
            id,
            person: Person {
                name: name.into(),
                student_id: id.to_string(),
                section: "Web".into(),
                status: "Regular".into(),
                telegram: String::new(),
            },
            rfid: card.into(),
            active: true,
            created_at: String::new(),
        }
    }
    #[test]
    fn card_swaps_are_atomic_and_deleted_rows_deactivate() {
        let store = Store::memory().unwrap();
        let a = user(1, "Ana", "111");
        let b = user(2, "Bea", "222");
        store.create(&a.person, &a.rfid, true).unwrap();
        store.create(&b.person, &b.rfid, true).unwrap();
        let mut ar = row(&a);
        ar[6] = json!("222");
        let mut br = row(&b);
        br[6] = json!("111");
        let plan = pull(
            &[a.clone(), b.clone()],
            &vec![sheets::strings(&HEADER), ar, br],
            false,
        );
        plan.apply(&store).unwrap();
        assert_eq!(store.user(1).unwrap().unwrap().rfid, "222");
        let plan = pull(
            &store.users().unwrap(),
            &vec![sheets::strings(&HEADER)],
            false,
        );
        plan.apply(&store).unwrap();
        assert!(store.users().unwrap().iter().all(|u| !u.active));
    }
    #[test]
    fn stale_sheet_edits_are_not_overwritten() {
        let own = user(1, "Ana", "111");
        let mut changed = row(&own);
        changed[0] = json!("Changed in sheet");
        assert!(
            place(&vec![sheets::strings(&HEADER), changed], &own, Some(&own))
                .unwrap_err()
                .to_string()
                .contains("have changed")
        );
    }
    #[test]
    fn duplicate_rows_do_not_deactivate_the_person_they_name() {
        let own = user(1, "Ana", "111");
        let data = vec![sheets::strings(&HEADER), row(&own), row(&own)];
        let plan = pull(&[own], &data, false);
        assert!(plan.deactivate.is_empty());
        assert_eq!(plan.warnings.len(), 2);
    }
}
