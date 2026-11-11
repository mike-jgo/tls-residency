use crate::sheets::{Error, Range, Result, Rows, Sheets, Tab};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

#[derive(Default)]
pub struct State {
    pub describes: usize,
    pub reads: Vec<String>,
    pub tabs: Vec<Tab>,
    pub cells: HashMap<String, Rows>,
    pub writes: Vec<Range>,
    pub fail_next_write: bool,
    pub refuse_writes: bool,
    /// The next write never arrives (web fake: fail = 'before').
    pub lose_next_write: bool,
    /// The next write is refused, as Google refuses a sheet it can't edit.
    pub refuse_next_write: bool,
    /// Reads fail as if Google can't be reached.
    pub fail_reads: bool,
    /// Every batch call, as sent.
    pub requests: Vec<Vec<Value>>,
    /// Every range cleared.
    pub clears: Vec<String>,
    /// How many writes were formula writes (the Search tab).
    pub formula_writes: usize,
    /// Tab ids are never reused: a tab made again is a different tab.
    pub last_id: i64,
}
#[derive(Clone, Default)]
pub struct Fake(pub Arc<Mutex<State>>);
fn address(range: &str) -> (String, usize, usize, usize, Option<usize>) {
    let (title, cells) = range.rsplit_once('!').unwrap();
    let title = title.trim_matches('\'').replace("''", "'");
    let mut bounds = cells.split(':');
    let start = bounds.next().unwrap();
    let end = bounds.next().unwrap_or(start);
    let column = |s: &str| {
        s.bytes()
            .take_while(u8::is_ascii_alphabetic)
            .fold(0usize, |a, b| a * 26 + (b - b'A' + 1) as usize)
            - 1
    };
    let row = |s: &str| {
        s.chars()
            .skip_while(char::is_ascii_alphabetic)
            .collect::<String>()
            .parse::<usize>()
            .ok()
            .map(|n| n - 1)
    };
    (
        title,
        column(start),
        row(start).unwrap_or(0),
        column(end) + 1,
        row(end).map(|n| n + 1),
    )
}
fn blank(v: &Value) -> bool {
    v.is_null() || v.as_str() == Some("")
}
impl Fake {
    pub fn tab(&self, title: &str, rows: Rows) {
        let mut state = self.0.lock().unwrap();
        state.last_id += 1;
        let id = state.last_id;
        state.tabs.push(Tab {
            title: title.into(),
            id,
            columns: 24,
            views: vec![],
        });
        state.cells.insert(title.into(), rows);
    }
}
impl Fake {
    /// Someone deletes a tab by hand.
    pub fn delete_tab(&self, title: &str) {
        let mut state = self.0.lock().unwrap();
        state.tabs.retain(|t| t.title != title);
        state.cells.remove(title);
    }
    pub fn has(&self, title: &str) -> bool {
        self.0.lock().unwrap().tabs.iter().any(|t| t.title == title)
    }
    pub fn id_of(&self, title: &str) -> Option<i64> {
        self.0.lock().unwrap().tabs.iter().find(|t| t.title == title).map(|t| t.id)
    }
    /// A cell, by A1 address; blank is None, as Google leaves blanks out.
    pub fn cell(&self, title: &str, at: &str) -> Option<Value> {
        let (_, col, row, _, _) = address(&format!("'{title}'!{at}"));
        let state = self.0.lock().unwrap();
        state
            .cells
            .get(title)?
            .get(row)?
            .get(col)
            .filter(|v| !blank(v))
            .cloned()
    }
    pub fn set(&self, title: &str, at: &str, value: Value) {
        let (_, col, row, _, _) = address(&format!("'{title}'!{at}"));
        let mut state = self.0.lock().unwrap();
        let grid = state.cells.entry(title.into()).or_default();
        while grid.len() <= row {
            grid.push(vec![]);
        }
        while grid[row].len() <= col {
            grid[row].push(json!(""));
        }
        grid[row][col] = value;
    }
    /// A column from row 2 down, gaps as None, as far as the tab goes.
    pub fn column(&self, title: &str, letter: char) -> Vec<Option<Value>> {
        let col = (letter as u8 - b'A') as usize;
        let state = self.0.lock().unwrap();
        let grid = state.cells.get(title).cloned().unwrap_or_default();
        let last = grid
            .iter()
            .rposition(|r| r.get(col).is_some_and(|v| !blank(v)))
            .unwrap_or(0);
        (1..=last.max(0))
            .map(|r| grid[r].get(col).filter(|v| !blank(v)).cloned())
            .collect()
    }
    /// Batch requests of a kind, e.g. "addFilterView", for one tab.
    pub fn requests_for(&self, kind: &str, sheet_id: i64) -> Vec<Value> {
        self.0
            .lock()
            .unwrap()
            .requests
            .iter()
            .flatten()
            .filter_map(|r| r.get(kind))
            .filter(|r| r.to_string().contains(&format!("\"sheetId\":{sheet_id}")))
            .cloned()
            .collect()
    }
    /// How many batch calls carried requests of a kind for one tab.
    pub fn batches_with(&self, kind: &str, sheet_id: i64) -> usize {
        self.0
            .lock()
            .unwrap()
            .requests
            .iter()
            .filter(|batch| {
                batch.iter().any(|r| {
                    r.get(kind).is_some_and(|r| {
                        r.to_string().contains(&format!("\"sheetId\":{sheet_id}"))
                    })
                })
            })
            .count()
    }
}
impl Sheets for Fake {
    fn describe(&mut self) -> Result<Vec<Tab>> {
        let mut state = self.0.lock().unwrap();
        state.describes += 1;
        Ok(state.tabs.clone())
    }
    fn read(&mut self, range: &str) -> Result<Rows> {
        let (title, col, row, end_col, end_row) = address(range);
        let mut state = self.0.lock().unwrap();
        state.reads.push(range.into());
        if state.fail_reads {
            return Err(Error {
                message: "Could not reach Google (ENOTFOUND).".into(),
                offline: true,
            });
        }
        let mut out = state
            .cells
            .get(&title)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .skip(row)
            .take(end_row.unwrap_or(usize::MAX).saturating_sub(row))
            .map(|r| {
                let mut values = r
                    .into_iter()
                    .skip(col)
                    .take(end_col - col)
                    .collect::<Vec<_>>();
                while values.last().is_some_and(blank) {
                    values.pop();
                }
                values
            })
            .collect::<Rows>();
        while out.last().is_some_and(Vec::is_empty) {
            out.pop();
        }
        Ok(out)
    }
    fn write(&mut self, ranges: &[Range], formulas: bool) -> Result<()> {
        if ranges.is_empty() {
            return Ok(());
        }
        let mut state = self.0.lock().unwrap();
        if state.lose_next_write {
            state.lose_next_write = false;
            return Err(Error {
                message: "Could not reach Google (ETIMEDOUT).".into(),
                offline: true,
            });
        }
        if state.refuse_next_write {
            state.refuse_next_write = false;
            return Err(Error {
                message: "Google refused (403): no permission".into(),
                offline: false,
            });
        }
        if formulas {
            state.formula_writes += 1;
        }
        if state.refuse_writes {
            return Err(Error {
                message: "offline before write".into(),
                offline: true,
            });
        }
        for range in ranges {
            let (title, col, row, _, _) = address(&range.range);
            let grid = state.cells.entry(title).or_default();
            for (i, values) in range.values.iter().enumerate() {
                while grid.len() <= row + i {
                    grid.push(vec![]);
                }
                let cells = &mut grid[row + i];
                while cells.len() < col + values.len() {
                    cells.push(json!(""));
                }
                for (j, value) in values.iter().enumerate() {
                    cells[col + j] = value.clone();
                }
            }
            state.writes.push(range.clone());
        }
        if state.fail_next_write {
            state.fail_next_write = false;
            return Err(Error {
                message: "reply lost after write".into(),
                offline: true,
            });
        }
        Ok(())
    }
    fn clear(&mut self, ranges: &[String]) -> Result<()> {
        let mut state = self.0.lock().unwrap();
        state.clears.extend(ranges.iter().cloned());
        for range in ranges {
            let (title, col, row, end_col, end_row) = address(range);
            if let Some(grid) = state.cells.get_mut(&title) {
                for cells in grid
                    .iter_mut()
                    .skip(row)
                    .take(end_row.unwrap_or(usize::MAX).saturating_sub(row))
                {
                    for c in cells.iter_mut().skip(col).take(end_col - col) {
                        *c = json!("");
                    }
                }
            }
        }
        Ok(())
    }
    fn batch(&mut self, requests: Vec<Value>) -> Result<()> {
        let mut state = self.0.lock().unwrap();
        if !requests.is_empty() {
            state.requests.push(requests.clone());
        }
        for request in requests {
            if let Some(add) = request.get("addSheet") {
                let title = add["properties"]["title"].as_str().unwrap().to_owned();
                state.last_id += 1;
                let id = state.last_id;
                state.tabs.push(Tab {
                    title: title.clone(),
                    id,
                    columns: add["properties"]["gridProperties"]["columnCount"]
                        .as_u64()
                        .unwrap() as usize,
                    views: vec![],
                });
                state.cells.entry(title).or_default();
            }
            if let Some(add) = request.get("addFilterView") {
                let id = add["filter"]["range"]["sheetId"].as_i64().unwrap();
                let title = add["filter"]["title"].as_str().unwrap().to_string();
                state
                    .tabs
                    .iter_mut()
                    .find(|t| t.id == id)
                    .unwrap()
                    .views
                    .push(title);
            }
            if let Some(delete) = request.get("deleteDimension") {
                let id = delete["range"]["sheetId"].as_i64().unwrap();
                let start = delete["range"]["startIndex"].as_u64().unwrap() as usize;
                let end = delete["range"]["endIndex"].as_u64().unwrap() as usize;
                let title = state
                    .tabs
                    .iter()
                    .find(|t| t.id == id)
                    .unwrap()
                    .title
                    .clone();
                if let Some(grid) = state.cells.get_mut(&title) {
                    for row in grid {
                        let until = end.min(row.len());
                        if start < until {
                            row.drain(start..until);
                        }
                    }
                }
            }
        }
        Ok(())
    }
}
