use crate::{
    dates::Dates,
    roster,
    sheets::{self, Range, Tab},
};
use serde_json::{json, Value};

pub const HOURS_HEADER: [&str; 7] = [
    "Name",
    "Student ID",
    "Hours",
    "Sessions",
    "Still in",
    "Uncounted sessions",
    "Deactivated",
];
pub const TAPS_HEADER: [&str; 6] = ["Tap #", "Date", "Time", "Name", "Student ID", "Direction"];

pub fn dress(tab: &Tab) -> Vec<Value> {
    let logs = tab.title.ends_with(" Logs");
    if tab.title != "Totals" && Dates::month_of_title(&tab.title).is_none() {
        return vec![];
    }
    let header = if tab.title == "Totals" { 2 } else { 0 };
    let columns = if logs { 6 } else { 7 };
    let views = if logs {
        vec![("Search", None), ("Newest first", Some((0, "DESCENDING")))]
    } else {
        vec![
            ("Search", None),
            ("Most hours", Some((2, "DESCENDING"))),
            ("Least hours", Some((2, "ASCENDING"))),
        ]
    };
    let missing: Vec<_> = views
        .into_iter()
        .filter(|(title, _)| !tab.views.iter().any(|v| v == title))
        .collect();
    if missing.is_empty() {
        return vec![];
    }
    let mut requests = vec![
        json!({"updateSheetProperties":{"properties":{"sheetId":tab.id,"gridProperties":{"frozenRowCount":header+1}},"fields":"gridProperties.frozenRowCount"}}),
    ];
    for (title, sort) in missing {
        let sort = sort
            .map(|(column, direction)| vec![json!({"dimensionIndex":column,"sortOrder":direction})])
            .unwrap_or_default();
        requests.push(json!({"addFilterView":{"filter":{"title":title,"range":{"sheetId":tab.id,"startRowIndex":header,"startColumnIndex":0,"endColumnIndex":columns},"sortSpecs":sort}}}));
    }
    requests
}
fn box_for(id: i64, value: &Value) -> Value {
    match (
        value.get("rows").and_then(Value::as_array),
        value.get("columns").and_then(Value::as_array),
    ) {
        (Some(rows), Some(cols)) => {
            json!({"sheetId":id,"startRowIndex":rows[0],"endRowIndex":rows[1],"startColumnIndex":cols[0],"endColumnIndex":cols[1]})
        }
        _ => json!({"sheetId":id}),
    }
}
pub fn style(tab: &Tab) -> Vec<Value> {
    let kind = match tab.title.as_str() {
        "Search" => "search",
        "Staffers" => "staffers",
        "Totals" => "totals",
        title if Dates::month_of_title(title).is_some() => {
            if title.ends_with(" Logs") {
                "logs"
            } else {
                "month"
            }
        }
        _ => return vec![],
    };
    let templates: Value = serde_json::from_str(include_str!("../assets/sheet-style.json"))
        .expect("bundled sheet styles are valid JSON");
    let look = &templates[kind];
    let mut out = vec![];
    if let Some(frozen) = look.get("frozen") {
        out.push(json!({"updateSheetProperties":{"properties":{"sheetId":tab.id,"gridProperties":{"frozenRowCount":frozen}},"fields":"gridProperties.frozenRowCount"}}));
    }
    for m in look
        .get("merges")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        out.push(json!({"mergeCells":{"range":box_for(tab.id,m),"mergeType":"MERGE_ALL"}}));
    }
    for c in look
        .get("cells")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let format = &c["format"];
        let fields = format
            .as_object()
            .map(|o| o.keys().cloned().collect::<Vec<_>>().join(","))
            .unwrap_or_default();
        out.push(json!({"repeatCell":{"range":box_for(tab.id,c),"cell":{"userEnteredFormat":format},"fields":format!("userEnteredFormat({fields})")}}));
    }
    for (dimension, key, indexes) in [
        ("COLUMNS", "widths", "columns"),
        ("ROWS", "heights", "rows"),
    ] {
        for size in look
            .get(key)
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            out.push(json!({"updateDimensionProperties":{"range":{"sheetId":tab.id,"dimension":dimension,"startIndex":size[indexes][0],"endIndex":size[indexes][1]},"properties":{"pixelSize":size["pixels"]},"fields":"pixelSize"}}));
        }
    }
    out
}
pub fn staffers_shape(tab: &Tab) -> Vec<Value> {
    let mut out = vec![];
    if tab.columns < 7 {
        out.push(json!({"appendDimension":{"sheetId":tab.id,"dimension":"COLUMNS","length":7-tab.columns}}));
    }
    for (column, values) in [
        (2, &crate::model::SECTIONS[..]),
        (3, &crate::model::STATUSES[..]),
    ] {
        out.push(json!({"setDataValidation":{"range":{"sheetId":tab.id,"startRowIndex":1,"startColumnIndex":column,"endColumnIndex":column+1},
            "rule":{"condition":{"type":"ONE_OF_LIST","values":values.iter().map(|v|json!({"userEnteredValue":v})).collect::<Vec<_>>()},"showCustomUi":true,"strict":true}}}));
    }
    out
}
pub fn search(tabs: &[Tab]) -> Vec<Range> {
    let mut months: Vec<_> = tabs
        .iter()
        .filter(|t| Dates::month_of_title(&t.title).is_some())
        .collect();
    months.sort_by_key(|t| std::cmp::Reverse(Dates::month_of_title(&t.title)));
    let lookup = |parts: Vec<String>, filter: String| {
        format!("=ARRAYFORMULA(LET(q,$B$1,all,{{{}}},IF(q=\"\",\"Type a name or ID number in B1\",IFERROR({filter},\"No match\"))))",parts.join(";"))
    };
    let matches =
        |name, id| format!("ISNUMBER(SEARCH(q,INDEX(all,,{name})))+(INDEX(all,,{id})&\"\"=q&\"\")");
    let labelled = |label: &str, title: &str, from| {
        format!(
            "IF(LEN({}!A{from}:A),\"{}\",\"\"),{}!A{from}:G",
            sheets::quote(title),
            label.replace('"', "\"\""),
            sheets::quote(title)
        )
    };
    let mut hour_parts = vec![labelled("All time", "Totals", 4)];
    hour_parts.extend(
        months
            .iter()
            .filter(|t| !t.title.ends_with(" Logs"))
            .map(|t| labelled(&t.title, &t.title, 2)),
    );
    let hours = lookup(hour_parts, format!("FILTER(all,{})", matches(2, 3)));
    let details = lookup(
        vec!["'Staffers'!A2:F".into()],
        format!("FILTER(all,{})", matches(1, 2)),
    );
    let logs: Vec<_> = months
        .iter()
        .filter(|t| t.title.ends_with(" Logs"))
        .map(|t| format!("{}!A2:F", sheets::quote(&t.title)))
        .collect();
    let taps = if logs.is_empty() {
        "No taps yet".into()
    } else {
        lookup(logs, format!("SORT(FILTER(all,{}),1,FALSE)", matches(4, 5)))
    };
    let single =
        |at: &str, value: Value| sheets::range(format!("'Search'!{at}"), vec![vec![value]]);
    let mut hours_header = vec![json!("Month")];
    hours_header.extend(sheets::strings(&HOURS_HEADER));
    vec![
        single("A1:A1", json!("Name or ID number:")),
        single("E1:E1", json!("← type here, then press Enter")),
        single("A3:A3", json!("Hours")),
        sheets::range("'Search'!A4:H4", vec![hours_header]),
        single("A5:A5", json!(hours)),
        single("J3:J3", json!("Details")),
        sheets::range(
            "'Search'!J4:O4",
            vec![sheets::strings(&roster::HEADER[..6])],
        ),
        single("J5:J5", json!(details)),
        single("Q3:Q3", json!("Taps, newest first")),
        sheets::range("'Search'!Q4:V4", vec![sheets::strings(&TAPS_HEADER)]),
        single("Q5:Q5", json!(taps)),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    fn sample() -> Vec<Range> {
        search(&["October 2026 Logs", "November 2026", "October 2026", "November 2026 Logs"]
            .map(|title| Tab { title: title.into(), ..Default::default() }))
    }
    fn value<'a>(ranges: &'a [Range], address: &str) -> &'a str {
        ranges.iter().find(|r| r.range == format!("'Search'!{address}")).unwrap().values[0][0].as_str().unwrap()
    }
    fn balanced(formula: &str) {
        let mut stack = Vec::new();
        let mut quoted = false;
        for ch in formula.chars() {
            match ch {
                '"' => quoted = !quoted,
                '(' | '{' if !quoted => stack.push(ch),
                ')' if !quoted => assert_eq!(stack.pop(), Some('(')),
                '}' if !quoted => assert_eq!(stack.pop(), Some('{')),
                _ => {}
            }
        }
        assert!(!quoted && stack.is_empty(), "{formula}");
    }
    #[test]
    fn search_hours_stack_all_time_and_each_month_with_labels_and_exact_ids() {
        let ranges = sample();
        let hours = value(&ranges, "A5:A5");
        balanced(hours);
        for part in [
            "IF(LEN('Totals'!A4:A),\"All time\",\"\"),'Totals'!A4:G;",
            "IF(LEN('November 2026'!A2:A),\"November 2026\",\"\"),'November 2026'!A2:G;",
            "ISNUMBER(SEARCH(q,INDEX(all,,2)))+(INDEX(all,,3)&\"\"=q&\"\")",
        ] { assert!(hours.contains(part), "{hours}"); }
        assert!(hours.find("November 2026").unwrap() < hours.find("October 2026").unwrap());
    }
    #[test]
    fn search_taps_stack_every_log_and_sort_newest_first_or_show_no_taps() {
        let ranges = sample();
        let taps = value(&ranges, "Q5:Q5");
        balanced(taps);
        assert!(taps.contains("{'November 2026 Logs'!A2:F;'October 2026 Logs'!A2:F}"));
        assert!(taps.contains("SORT(FILTER(all,ISNUMBER(SEARCH(q,INDEX(all,,4)))+(INDEX(all,,5)&\"\"=q&\"\")),1,FALSE)"));
        assert_eq!(value(&search(&[]), "Q5:Q5"), "No taps yet");
    }
    #[test]
    fn search_details_exclude_cards_and_all_formulas_read_the_untouched_search_box() {
        let ranges = sample();
        assert!(ranges.iter().all(|r| !["B1", "C1", "D1"].iter().any(|cell| r.range.contains(cell))));
        for at in ["A5:A5", "J5:J5", "Q5:Q5"] {
            let formula = value(&ranges, at);
            balanced(formula);
            assert!(formula.contains("q,$B$1"));
        }
        assert!(value(&ranges, "J5:J5").contains("{'Staffers'!A2:F}"));
        let header = ranges.iter().find(|r| r.range == "'Search'!J4:O4").unwrap();
        assert_eq!(header.values[0], sheets::strings(&roster::HEADER[..6]));
    }
    #[test]
    fn search_headers_and_written_ranges_have_the_same_width() {
        for range in sample() {
            let cells = range.range.rsplit_once('!').unwrap().1;
            let (from, to) = cells.split_once(':').unwrap();
            let column = |cell: &str| cell.bytes().take_while(u8::is_ascii_alphabetic).fold(0, |n, b| n * 26 + usize::from(b - b'A' + 1));
            assert_eq!(range.values[0].len(), column(to) - column(from) + 1, "{}", range.range);
        }
    }
    #[test]
    fn sheet_search_keeps_the_input_cell_and_card_numbers_private() {
        let ranges = search(&[Tab {
            title: "November 2026 Logs".into(),
            id: 1,
            ..Tab::default()
        }]);
        assert!(ranges.iter().all(|r| !r.range.contains("B1")));
        assert!(ranges
            .iter()
            .find(|r| r.range == "'Search'!J5:J5")
            .unwrap()
            .values[0][0]
            .as_str()
            .unwrap()
            .contains("'Staffers'!A2:F"));
        assert!(ranges
            .iter()
            .find(|r| r.range == "'Search'!Q5:Q5")
            .unwrap()
            .values[0][0]
            .as_str()
            .unwrap()
            .contains("SORT(FILTER"));
    }
}
