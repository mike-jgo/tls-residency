use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine,
};
use ring::{
    rand::SystemRandom,
    signature::{RsaKeyPair, RSA_PKCS1_SHA256},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{path::PathBuf, time::Duration};

pub type Rows = Vec<Vec<Value>>;
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Range {
    pub range: String,
    pub values: Rows,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Tab {
    pub title: String,
    pub id: i64,
    pub views: Vec<String>,
    pub columns: usize,
}
#[derive(Debug, Clone)]
pub struct Error {
    pub message: String,
    pub offline: bool,
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.message.fmt(f)
    }
}
impl std::error::Error for Error {}
impl Error {
    pub fn local(message: impl ToString) -> Self {
        Self {
            message: message.to_string(),
            offline: false,
        }
    }
}
pub type Result<T> = std::result::Result<T, Error>;

pub fn quote(title: &str) -> String {
    format!("'{}'", title.replace('\'', "''"))
}
pub fn cell(row: &[Value], at: usize) -> String {
    match row.get(at) {
        Some(Value::String(s)) => s.trim().to_owned(),
        Some(Value::Null) | None => String::new(),
        Some(v) => v.to_string(),
    }
}
pub fn range(address: impl Into<String>, rows: Rows) -> Range {
    Range {
        range: address.into(),
        values: rows,
    }
}
pub fn strings(values: &[&str]) -> Vec<Value> {
    values.iter().map(|v| json!(v)).collect()
}
fn encode(s: &str) -> String {
    s.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

// The sync can run against a local stand-in without credentials or a network.
pub trait Sheets: Send {
    fn describe(&mut self) -> Result<Vec<Tab>>;
    fn read(&mut self, range: &str) -> Result<Rows>;
    fn write(&mut self, ranges: &[Range], formulas: bool) -> Result<()>;
    fn clear(&mut self, ranges: &[String]) -> Result<()>;
    fn batch(&mut self, requests: Vec<Value>) -> Result<()>;
    fn add_tabs(&mut self, titles: &[String], columns: usize) -> Result<()> {
        if titles.is_empty() {
            return Ok(());
        }
        self.batch(titles.iter().map(|title|json!({"addSheet":{"properties":{"title":title,"gridProperties":{"rowCount":10000,"columnCount":columns}}}})).collect())
    }
}

pub struct Google {
    spreadsheet_id: String,
    key_file: PathBuf,
    token: Option<(String, i64)>,
    agent: ureq::Agent,
    /// Where the Sheets API is. Google's, except in tests.
    api: String,
    /// Where the sign-in is sent. The key's (Google's) token URI, except in
    /// tests, which point it at a local stand-in.
    token_url: Option<String>,
    /// Seconds since the epoch: the real clock, except in tests.
    now: Box<dyn Fn() -> i64 + Send>,
}
impl Google {
    pub fn new(spreadsheet_id: String, key_file: PathBuf) -> Self {
        Self {
            spreadsheet_id,
            key_file,
            token: None,
            agent: ureq::AgentBuilder::new()
                .timeout(Duration::from_secs(15))
                .build(),
            api: "https://sheets.googleapis.com/v4/spreadsheets".into(),
            token_url: None,
            now: Box::new(|| chrono::Utc::now().timestamp()),
        }
    }
    /// A client talking to a local stand-in for Google, on a pinned clock.
    #[cfg(test)]
    pub fn local(spreadsheet_id: &str, key_file: PathBuf, base: &str, now: impl Fn() -> i64 + Send + 'static) -> Self {
        Self {
            api: format!("{base}/v4/spreadsheets"),
            token_url: Some(format!("{base}/token")),
            now: Box::new(now),
            ..Self::new(spreadsheet_id.into(), key_file)
        }
    }
    fn response(
        &mut self,
        response: std::result::Result<ureq::Response, ureq::Error>,
    ) -> Result<Value> {
        match response {
            Ok(r) => r.into_json().map_err(Error::local),
            Err(ureq::Error::Transport(e)) => Err(Error {
                message: format!("Could not reach Google ({e})."),
                offline: true,
            }),
            Err(ureq::Error::Status(status, r)) => {
                if status == 401 {
                    self.token = None;
                }
                let text = r.into_string().unwrap_or_default();
                let detail = serde_json::from_str::<Value>(&text)
                    .ok()
                    .and_then(|v| {
                        v.pointer("/error/message")
                            .or_else(|| v.get("error_description"))
                            .cloned()
                    })
                    .and_then(|v| v.as_str().map(str::to_owned))
                    .unwrap_or(text);
                Err(Error::local(format!(
                    "Google refused ({status}): {}",
                    detail.chars().take(300).collect::<String>()
                )))
            }
        }
    }
    fn access_token(&mut self) -> Result<String> {
        let now = (self.now)();
        if let Some((token, until)) = &self.token {
            if now < *until {
                return Ok(token.clone());
            }
        }
        #[derive(Deserialize)]
        struct Key {
            client_email: String,
            private_key: String,
            #[serde(default)]
            token_uri: String,
        }
        let key: Key = serde_json::from_slice(
            &std::fs::read(&self.key_file)
                .map_err(|e| Error::local(format!("Cannot read the service-account key: {e}")))?,
        )
        .map_err(Error::local)?;
        let token_uri = if key.token_uri.is_empty() {
            "https://oauth2.googleapis.com/token"
        } else {
            &key.token_uri
        };
        if ![
            "https://oauth2.googleapis.com/token",
            "https://accounts.google.com/o/oauth2/token",
        ]
        .contains(&token_uri)
        {
            return Err(Error::local("Use Google's service-account token URI."));
        }
        let pem = key
            .private_key
            .lines()
            .filter(|s| !s.starts_with("---"))
            .collect::<String>();
        let der = STANDARD.decode(pem).map_err(Error::local)?;
        let pair = RsaKeyPair::from_pkcs8(&der).map_err(|_| {
            Error::local("The service-account private key is not a valid PKCS#8 RSA key.")
        })?;
        let head = URL_SAFE_NO_PAD.encode(br#"{"alg":"RS256","typ":"JWT"}"#);
        let body=URL_SAFE_NO_PAD.encode(serde_json::to_vec(&json!({"iss":key.client_email,"scope":"https://www.googleapis.com/auth/spreadsheets","aud":token_uri,"iat":now,"exp":now+3600})).map_err(Error::local)?);
        let unsigned = format!("{head}.{body}");
        let mut signature = vec![0; pair.public().modulus_len()];
        pair.sign(
            &RSA_PKCS1_SHA256,
            &SystemRandom::new(),
            unsigned.as_bytes(),
            &mut signature,
        )
        .map_err(|_| Error::local("Could not sign the service-account login."))?;
        let assertion = format!("{unsigned}.{}", URL_SAFE_NO_PAD.encode(signature));
        let result = self.agent.post(self.token_url.as_deref().unwrap_or(token_uri)).send_form(&[
            ("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer"),
            ("assertion", &assertion),
        ]);
        let reply = self.response(result)?;
        let token = reply
            .get("access_token")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| Error::local("Google returned no access token."))?
            .to_owned();
        self.token = Some((
            token.clone(),
            now + reply
                .get("expires_in")
                .and_then(Value::as_i64)
                .unwrap_or(3600)
                - 60,
        ));
        Ok(token)
    }
    fn call(&mut self, method: &str, path: &str, body: Option<Value>) -> Result<Value> {
        let token = self.access_token()?;
        let request = self
            .agent
            .request(
                method,
                &format!("{}/{}{path}", self.api, encode(&self.spreadsheet_id)),
            )
            .set("Authorization", &format!("Bearer {token}"));
        let response = match body {
            Some(body) => request.send_json(body),
            None => request.call(),
        };
        self.response(response)
    }
}
impl Sheets for Google {
    fn describe(&mut self) -> Result<Vec<Tab>> {
        let body=self.call("GET","?fields=sheets(properties(sheetId,title,gridProperties(columnCount)),filterViews(title))",None)?;
        let tabs = body
            .get("sheets")
            .and_then(Value::as_array)
            .ok_or_else(|| Error::local("Google returned no sheet list."))?;
        tabs.iter()
            .map(|s| {
                Ok(Tab {
                    title: s
                        .pointer("/properties/title")
                        .and_then(Value::as_str)
                        .ok_or_else(|| Error::local("A sheet has no title."))?
                        .into(),
                    id: s
                        .pointer("/properties/sheetId")
                        .and_then(Value::as_i64)
                        .ok_or_else(|| Error::local("A sheet has no ID."))?,
                    columns: s
                        .pointer("/properties/gridProperties/columnCount")
                        .and_then(Value::as_u64)
                        .unwrap_or(0) as usize,
                    views: s
                        .get("filterViews")
                        .and_then(Value::as_array)
                        .map(|v| {
                            v.iter()
                                .filter_map(|v| {
                                    v.get("title").and_then(Value::as_str).map(str::to_owned)
                                })
                                .collect()
                        })
                        .unwrap_or_default(),
                })
            })
            .collect()
    }
    fn read(&mut self, range: &str) -> Result<Rows> {
        let body = self.call("GET", &format!("/values/{}", encode(range)), None)?;
        serde_json::from_value(body.get("values").cloned().unwrap_or(json!([])))
            .map_err(Error::local)
    }
    fn write(&mut self, ranges: &[Range], formulas: bool) -> Result<()> {
        if ranges.is_empty() {
            return Ok(());
        }
        self.call(
            "POST",
            "/values:batchUpdate",
            Some(json!({"valueInputOption":if formulas{"USER_ENTERED"}else{"RAW"},"data":ranges})),
        )?;
        Ok(())
    }
    fn clear(&mut self, ranges: &[String]) -> Result<()> {
        if !ranges.is_empty() {
            self.call("POST", "/values:batchClear", Some(json!({"ranges":ranges})))?;
        }
        Ok(())
    }
    fn batch(&mut self, requests: Vec<Value>) -> Result<()> {
        if !requests.is_empty() {
            self.call("POST", ":batchUpdate", Some(json!({"requests":requests})))?;
        }
        Ok(())
    }
}
