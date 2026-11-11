// The web app's roster tests (web/test/roster.test.js), ported: how a device
// follows the Staffers tab (`pull`) and where a save from People goes
// (`place`). Messages are compared case-insensitively on the phrase that
// matters, since the wording differs slightly between the apps.

use crate::{
    model::{Person, User},
    roster::{place, pull, row, Plan, HEADER},
    sheets::{self, Range, Rows},
};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicI64, Ordering};

const ANA: [&str; 7] = ["Ana Cruz", "111", "Sports", "Probie", "@ana", "", "9001"];
const BEN: [&str; 7] = ["Ben Dy", "222", "Web", "Regular", "@ben", "", "9002"];
const CY: [&str; 7] = ["Cy Lim", "333", "Photo", "EB", "@cy", "", "9003"];

static IDS: AtomicI64 = AtomicI64::new(0);
/// A person on this device, from their row.
fn user(r: [&str; 7]) -> User {
    User {
        id: IDS.fetch_add(1, Ordering::Relaxed) + 1,
        person: Person {
            name: r[0].into(),
            student_id: r[1].into(),
            section: r[2].into(),
            status: r[3].into(),
            telegram: r[4].into(),
        },
        rfid: r[6].into(),
        active: r[5] != "yes",
        created_at: String::new(),
    }
}
fn edit(r: [&str; 7], changes: &[(usize, &'static str)]) -> [&'static str; 7] {
    let mut out: [&'static str; 7] = [""; 7];
    for (i, cell) in r.iter().enumerate() {
        out[i] = Box::leak(cell.to_string().into_boxed_str());
    }
    for (i, v) in changes {
        out[*i] = v;
    }
    out
}
fn rows(list: &[&[&str]]) -> Rows {
    list.iter().map(|r| sheets::strings(r)).collect()
}
fn header() -> Vec<&'static str> {
    HEADER.to_vec()
}
fn is_nothing(plan: &Plan) -> bool {
    plan.create.is_empty()
        && plan.update.is_empty()
        && plan.deactivate.is_empty()
        && plan.unlisted.is_empty()
        && plan.writes.is_empty()
        && plan.unlinked.is_empty()
}
fn has(text: &str, phrase: &str) -> bool {
    text.to_lowercase().contains(&phrase.to_lowercase())
}
fn written(r: [&str; 7]) -> Rows {
    vec![sheets::strings(&r)]
}

// ---- pull: this device follows the tab -----------------------------------

#[test]
fn nothing_to_do_when_the_tab_and_this_device_agree() {
    let plan = pull(&[user(ANA), user(BEN)], &rows(&[&header(), &ANA, &BEN]), false);
    assert!(is_nothing(&plan) && plan.warnings.is_empty());
}

#[test]
fn a_row_changed_in_the_tab_changes_the_person_here() {
    let ana = user(ANA);
    let plan = pull(&[ana.clone()], &rows(&[&header(), &edit(ANA, &[(0, "Ana Reyes"), (3, "Regular"), (5, "Yes")])]), false);
    assert_eq!(plan.update.len(), 1);
    let (id, p, card, active) = &plan.update[0];
    assert_eq!((*id, card.as_str(), *active), (ana.id, "9001", false));
    assert_eq!(
        (p.name.as_str(), p.student_id.as_str(), p.section.as_str(), p.status.as_str(), p.telegram.as_str()),
        ("Ana Reyes", "111", "Sports", "Regular", "@ana")
    );
    assert!(plan.writes.is_empty());
}

#[test]
fn a_person_is_still_found_when_their_id_number_or_their_card_is_corrected_in_the_tab() {
    let ana = user(ANA);
    assert_eq!(pull(&[ana.clone()], &rows(&[&header(), &edit(ANA, &[(1, "119")])]), false).update[0].0, ana.id);
    let recarded = pull(&[ana.clone()], &rows(&[&header(), &edit(ANA, &[(6, "9555")])]), false);
    assert_eq!(recarded.update[0].0, ana.id);
    assert_eq!(recarded.update[0].2, "9555");
    assert!(recarded.create.is_empty());
}

#[test]
fn two_cards_swapped_in_the_tab_are_swapped_here_nobody_is_created() {
    let plan = pull(&[user(ANA), user(BEN)], &rows(&[&header(), &edit(ANA, &[(6, "9002")]), &edit(BEN, &[(6, "9001")])]), false);
    assert_eq!(plan.update.iter().map(|u| u.2.as_str()).collect::<Vec<_>>(), ["9002", "9001"]);
    assert!(plan.create.is_empty());
    assert!(plan.warnings.is_empty());
}

#[test]
fn a_row_with_a_card_for_someone_not_here_creates_them_a_second_device_fills_itself() {
    let plan = pull(&[], &rows(&[&header(), &ANA, &edit(BEN, &[(5, "yes")])]), false);
    let made: Vec<_> = plan.create.iter().map(|(p, card, active)| (p.name.as_str(), card.as_str(), *active)).collect();
    assert_eq!(made, [("Ana Cruz", "9001", true), ("Ben Dy", "9002", false)]);
    assert!(plan.writes.is_empty());
}

#[test]
fn what_was_typed_in_the_tab_is_tidied_before_it_is_compared() {
    let typed: Vec<Value> = vec![json!("  Ana Cruz "), json!(111), json!("Sports"), json!("Probie"), json!("ana"), json!(""), json!(9001)];
    let plan = pull(&[user(ANA)], &vec![sheets::strings(&HEADER), typed], false);
    assert!(is_nothing(&plan) && plan.warnings.is_empty(), "{:?}", plan.warnings);
}

#[test]
fn a_row_deleted_from_the_tab_deactivates_the_person_and_only_that() {
    let ana = user(ANA);
    let plan = pull(&[ana.clone(), user(BEN)], &rows(&[&header(), &BEN]), false);
    assert_eq!(plan.deactivate, [ana.id]);
    assert_eq!(plan.unlisted, [ana.id]);
    assert!(plan.writes.is_empty(), "the row is not put back");
    let off = user(edit(ANA, &[(5, "yes")]));
    let again = pull(&[off.clone()], &rows(&[&header()]), false);
    assert!(again.deactivate.is_empty(), "already deactivated");
    assert_eq!(again.unlisted, [off.id], "but still someone the tab does not list");
}

#[test]
fn from_a_restored_backup_people_the_tab_does_not_list_are_added_to_it_below_everything() {
    // From before the directory fields.
    let old = ["Old Timer", "333", "", "", "", "", "9003"];
    let (ana, timer) = (user(ANA), user(old));
    let plan = pull(&[ana, timer, user(BEN)], &rows(&[&[], &BEN, &[], &["stray note"]]), true);
    assert_eq!(
        plan.writes,
        [
            Range { range: "'Staffers'!A1:G1".into(), values: vec![sheets::strings(&HEADER)] },
            Range { range: "'Staffers'!A5:G5".into(), values: written(ANA) },
            Range { range: "'Staffers'!A6:G6".into(), values: written(old) },
        ]
    );
    assert!(plan.deactivate.is_empty());
    assert!(plan.unlisted.is_empty());
}

#[test]
fn someone_added_that_way_is_recognised_next_time_not_added_twice() {
    assert!(pull(&[user(ANA)], &rows(&[&header(), &ANA]), true).writes.is_empty());
}

#[test]
fn a_bad_row_is_skipped_with_a_warning_and_its_person_stays_as_they_are() {
    let cases: [(&[(usize, &'static str)], &str); 6] = [
        (&[(2, "Gossip")], "section"),
        (&[(4, "two words")], "telegram"),
        (&[(5, "maybe")], "deactivated"),
        (&[(6, "abc")], "card number must be all digits"),
        (&[(1, "")], "no id number"),
        (&[(6, "")], "no card number"),
    ];
    for (changes, why) in cases {
        let plan = pull(&[user(ANA), user(BEN)], &rows(&[&header(), &BEN, &edit(ANA, changes)]), false);
        assert!(is_nothing(&plan), "{changes:?}");
        let warning = plan.warnings.iter().find(|w| w.starts_with("Row 3 (Ana Cruz)")).unwrap_or_else(|| panic!("{changes:?}: {:?}", plan.warnings));
        assert!(has(warning, why), "{warning}");
    }
}

#[test]
fn an_id_number_or_a_card_on_two_rows_is_used_for_neither() {
    for column in [1, 6] {
        let plan = pull(&[user(ANA), user(BEN)], &rows(&[&header(), &ANA, &edit(BEN, &[(column, ANA[column])])]), false);
        assert!(is_nothing(&plan));
        assert_eq!(plan.warnings.len(), 2);
        assert!(has(&plan.warnings[0], "more than one row"));
    }
}

#[test]
fn a_card_still_held_here_by_someone_the_tab_does_not_list_is_not_handed_on() {
    let gone = user(edit(ANA, &[(5, "yes")])); // row deleted long ago; card 9001 stays theirs
    let plan = pull(&[gone.clone()], &rows(&[&header(), &edit(BEN, &[(6, "9001"), (1, "444")])]), false);
    // By card, this row is Ana: the tab says she is now Ben Dy with ID 444.
    assert_eq!(plan.update[0].0, gone.id);

    let both = pull(&[gone, user(BEN)], &rows(&[&header(), &edit(BEN, &[(6, "9001")])]), false);
    assert!(both.update.is_empty());
    assert!(has(&both.warnings[0], "card number 9001 belongs to Ana Cruz"), "{:?}", both.warnings);
    assert!(both.deactivate.is_empty(), "and Ben is not taken for deleted");
}

/// Ana is given Ben's card and Ben is given Cy's, but Cy is not in the tab, so
/// Ben keeps his, so Ana can't have it. Moving Ana anyway would put one card on
/// two people, which the database refuses, failing every sync after it.
#[test]
fn a_card_is_not_handed_on_when_its_holder_in_turn_cannot_move_off_it() {
    let users = [user(ANA), user(BEN), user(CY)];
    let plan = pull(&users, &rows(&[&header(), &edit(ANA, &[(6, "9002")]), &edit(BEN, &[(6, "9003")])]), false);
    assert!(plan.update.is_empty());
    assert!(plan.create.is_empty());
    assert!(plan.deactivate.is_empty(), "nobody a skipped row is about is taken for deleted");
    assert_eq!(plan.warnings.len(), 2, "{:?}", plan.warnings);
    assert!(plan.warnings.iter().any(|w| w.starts_with("Row 3 (Ben Dy)") && has(w, "card number 9003 belongs to Cy Lim")), "{:?}", plan.warnings);
    assert!(plan.warnings.iter().any(|w| w.starts_with("Row 2 (Ana Cruz)") && has(w, "card number 9002 belongs to Ben Dy")), "{:?}", plan.warnings);

    // The rest of the tab still goes through: a chain that ends on a free card moves.
    let rest = pull(&users, &rows(&[&header(), &edit(ANA, &[(6, "9002")]), &edit(BEN, &[(6, "9003")]), &edit(CY, &[(0, "Cy Lim Jr"), (6, "9004")])]), false);
    let mut cards: Vec<_> = rest.update.iter().map(|u| u.2.as_str()).collect();
    cards.sort();
    assert_eq!(cards, ["9002", "9003", "9004"]);
}

#[test]
fn a_row_with_no_card_for_someone_not_here_waits_for_one() {
    let plan = pull(&[], &rows(&[&header(), &edit(ANA, &[(6, "")])]), false);
    assert!(plan.create.is_empty());
    assert_eq!(plan.unlinked[0].row, 2);
    assert_eq!(plan.unlinked[0].person.name, "Ana Cruz");
}

// ---- place: a save from the People page ----------------------------------

fn ranges(writes: &[Range]) -> Vec<&str> {
    writes.iter().map(|w| w.range.as_str()).collect()
}

#[test]
fn someone_new_goes_on_the_first_row_past_everything() {
    let writes = place(&rows(&[&header(), &BEN, &[], &["stray note"]]), &user(ANA), None).unwrap();
    assert_eq!(writes, [Range { range: "'Staffers'!A5:G5".into(), values: written(ANA) }]);
    assert_eq!(ranges(&place(&vec![], &user(ANA), None).unwrap()), ["'Staffers'!A1:G1", "'Staffers'!A2:G2"]);
}

#[test]
fn someone_new_takes_up_the_row_that_was_waiting_for_their_card() {
    let writes = place(&rows(&[&header(), &BEN, &edit(ANA, &[(6, "")])]), &user(ANA), None).unwrap();
    assert_eq!(writes, [Range { range: "'Staffers'!A3:G3".into(), values: written(ANA) }]);
}

#[test]
fn an_id_number_or_card_the_tab_already_has_is_refused() {
    let tab = rows(&[&header(), &BEN, &ANA]);
    let e = place(&tab, &user(edit(ANA, &[(6, "9999")])), None).unwrap_err().to_string();
    assert!(has(&e, "ID number 111 already belongs to Ana Cruz (row 3"), "{e}");
    let e = place(&tab, &user(edit(ANA, &[(1, "999")])), None).unwrap_err().to_string();
    assert!(has(&e, "card number already belongs to Ana Cruz"), "{e}");
    // ...also when editing someone into another person's ID number.
    let ana = user(ANA);
    let e = place(&tab, &User { person: Person { student_id: "222".into(), ..ana.person.clone() }, ..ana.clone() }, Some(&ana))
        .unwrap_err()
        .to_string();
    assert!(has(&e, "222 already belongs to Ben Dy"), "{e}");
}

#[test]
fn an_edit_goes_to_the_persons_own_row_found_by_id_number_or_by_card() {
    let ana = user(ANA);
    let changed = User {
        person: Person { student_id: "119".into(), status: "Regular".into(), ..ana.person.clone() },
        active: false,
        ..ana.clone()
    };
    let writes = place(&rows(&[&header(), &BEN, &ANA]), &changed, Some(&ana)).unwrap();
    assert_eq!(writes, [Range { range: "'Staffers'!A3:G3".into(), values: vec![row(&changed)] }]);
    let no_id = user(edit(ANA, &[(1, "")]));
    let writes = place(&rows(&[&header(), &BEN, &edit(ANA, &[(1, "")])]), &user(ANA), Some(&no_id)).unwrap();
    assert_eq!(writes[0].range, "'Staffers'!A3:G3");
}

#[test]
fn an_edit_from_a_copy_that_is_behind_the_tab_is_refused_not_written_over_it() {
    // The tab says Regular now: typed there, or saved from another device.
    let ana = user(ANA);
    let newer = edit(ANA, &[(3, "Regular")]);
    let e = place(&rows(&[&header(), &BEN, &newer]), &User { active: false, ..ana.clone() }, Some(&ana)).unwrap_err().to_string();
    assert!(e.contains("Ana Cruz (row 3)"), "{e}");
    // A corrected card or ID number counts too: the row is still found by the other.
    assert!(place(&rows(&[&header(), &edit(ANA, &[(6, "9009")])]), &ana, Some(&ana)).is_err());
    assert!(place(&rows(&[&header(), &edit(ANA, &[(1, "119")])]), &ana, Some(&ana)).is_err());
    // A row that has only lost its card number gets it back.
    let writes = place(&rows(&[&header(), &edit(ANA, &[(6, "")])]), &ana, Some(&ana)).unwrap();
    assert_eq!(writes, [Range { range: "'Staffers'!A2:G2".into(), values: written(ANA) }]);
}

#[test]
fn reactivating_someone_whose_row_was_deleted_puts_the_row_back() {
    let ana = user(ANA);
    let writes = place(&rows(&[&header(), &BEN]), &ana, Some(&ana)).unwrap();
    assert_eq!(writes, [Range { range: "'Staffers'!A3:G3".into(), values: written(ANA) }]);
}

#[test]
fn row_of_is_the_row_pull_compares_against() {
    assert_eq!(row(&user(ANA)), sheets::strings(&ANA));
    let off = edit(BEN, &[(5, "yes")]);
    assert_eq!(row(&user(off)), sheets::strings(&off));
}
