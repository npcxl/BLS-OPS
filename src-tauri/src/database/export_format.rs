//! Small, per-row serializers shared by all export drivers. Never buffer a dataset.
use super::adapter::SqlDialect;
use super::capability::Dialect;
use super::codec;
use super::model::{DbErrorInfo, DbValue, ExportFormat, ExportRequest};
use base64::{engine::general_purpose::STANDARD, Engine};

pub struct ExportEncoder {
    format: ExportFormat,
    columns: Vec<String>,
    dialect: SqlDialect,
    insert_prefix: String,
    rows: u64,
    bom: bool,
}

impl ExportEncoder {
    pub fn new(
        request: &ExportRequest,
        columns: Vec<String>,
        dialect: SqlDialect,
    ) -> Result<Self, DbErrorInfo> {
        let insert_prefix = if request.format == ExportFormat::Sql {
            let table = request
                .table
                .as_ref()
                .ok_or_else(|| DbErrorInfo::new("config", "SQL INSERT 导出仅支持表数据"))?;
            let names = columns
                .iter()
                .map(|c| dialect.quote(c))
                .collect::<Result<Vec<_>, _>>()?
                .join(", ");
            format!(
                "INSERT INTO {} ({names}) VALUES ",
                dialect.qualified(Some(&table.database), &table.table)?
            )
        } else {
            String::new()
        };
        // Object formats must not silently overwrite duplicate query-column names.
        let mut used = std::collections::HashSet::new();
        let columns = columns
            .into_iter()
            .map(|name| {
                let mut unique = name.clone();
                let mut index = 2;
                while !used.insert(unique.clone()) {
                    unique = format!("{name}_{index}");
                    index += 1;
                }
                unique
            })
            .collect();
        Ok(Self {
            format: request.format,
            columns,
            dialect,
            insert_prefix,
            rows: 0,
            bom: request.bom.unwrap_or(true)
                && matches!(request.format, ExportFormat::Csv | ExportFormat::Tsv),
        })
    }

    pub fn header(&self) -> String {
        let body = match self.format {
            ExportFormat::Csv | ExportFormat::Tsv => {
                let separator = if self.format == ExportFormat::Csv { ',' } else { '\t' };
                format!("{}\r\n", self.columns.iter().map(|c| delimited(c, separator)).collect::<Vec<_>>().join(&separator.to_string()))
            }
            ExportFormat::Json => "[\n".into(),
            ExportFormat::Html => format!("<!doctype html>\n<html><head><meta charset=\"utf-8\"><title>Export</title></head><body><table><thead><tr>{}</tr></thead><tbody>\n",
                self.columns.iter().map(|c| format!("<th>{}</th>", escape(c))).collect::<String>()),
            ExportFormat::Xml => "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<rows>\n".into(),
            _ => String::new(),
        };
        if self.bom {
            format!("\u{feff}{body}")
        } else {
            body
        }
    }

    pub fn row(&mut self, values: &[DbValue]) -> Result<String, DbErrorInfo> {
        if values.len() != self.columns.len()
            || values.iter().any(|v| {
                matches!(
                    v,
                    DbValue::Text {
                        truncated: true,
                        ..
                    } | DbValue::Json {
                        truncated: true,
                        ..
                    } | DbValue::Binary {
                        truncated: true,
                        ..
                    } | DbValue::Unsupported { .. }
                )
            })
        {
            return Err(DbErrorInfo::new(
                "query",
                "导出遇到不完整或不支持的字段，已停止，未发布目标文件",
            ));
        }
        let line = match self.format {
            ExportFormat::Csv | ExportFormat::Tsv => {
                let separator = if self.format == ExportFormat::Csv {
                    ','
                } else {
                    '\t'
                };
                format!(
                    "{}\r\n",
                    values
                        .iter()
                        .map(|v| if matches!(v, DbValue::Null) {
                            String::new()
                        } else {
                            delimited(&codec::export_cell(v), separator)
                        })
                        .collect::<Vec<_>>()
                        .join(&separator.to_string())
                )
            }
            ExportFormat::Json | ExportFormat::Jsonl => {
                let object: serde_json::Map<String, serde_json::Value> = self
                    .columns
                    .iter()
                    .zip(values)
                    .map(|(name, value)| {
                        let json = match value {
                            DbValue::Null => serde_json::Value::Null,
                            DbValue::Float { value } if value.is_finite() => {
                                serde_json::json!(value)
                            }
                            // Keep exact integers/decimals as strings (no JS rounding).
                            other => serde_json::Value::String(codec::export_cell(other)),
                        };
                        (name.clone(), json)
                    })
                    .collect();
                let prefix = if self.format == ExportFormat::Json && self.rows > 0 {
                    ",\n"
                } else {
                    ""
                };
                format!(
                    "{prefix}{}{}",
                    serde_json::Value::Object(object),
                    if self.format == ExportFormat::Jsonl {
                        "\n"
                    } else {
                        ""
                    }
                )
            }
            ExportFormat::Sql => {
                let cells = values
                    .iter()
                    .map(|value| self.sql_cell(value))
                    .collect::<Result<Vec<_>, _>>()?;
                format!("{}({});\n", self.insert_prefix, cells.join(", "))
            }
            ExportFormat::Html => format!(
                "<tr>{}</tr>\n",
                values
                    .iter()
                    .map(|v| match v {
                        DbValue::Null => "<td data-null=\"true\">NULL</td>".into(),
                        other => format!(
                            "<td style=\"white-space:pre-wrap\">{}</td>",
                            escape(&codec::export_cell(other))
                        ),
                    })
                    .collect::<String>()
            ),
            ExportFormat::Xml => {
                let fields = self
                    .columns
                    .iter()
                    .zip(values)
                    .map(|(name, value)| {
                        let name = escape(name);
                        if matches!(value, DbValue::Null) {
                            return format!("<field name=\"{name}\" null=\"true\"/>");
                        }
                        let raw = codec::export_cell(value);
                        // XML 1.0 cannot contain NUL/control characters. Encode those fields losslessly.
                        let (encoding, text) = if matches!(value, DbValue::Binary { .. }) {
                            (" encoding=\"base64\"", raw)
                        } else if raw.chars().any(|c| !xml_char(c)) {
                            (" encoding=\"utf8-base64\"", STANDARD.encode(raw.as_bytes()))
                        } else {
                            ("", raw)
                        };
                        format!("<field name=\"{name}\"{encoding}>{}</field>", escape(&text))
                    })
                    .collect::<String>();
                format!("<row>{fields}</row>\n")
            }
        };
        self.rows += 1;
        Ok(line)
    }

    fn sql_cell(&self, value: &DbValue) -> Result<String, DbErrorInfo> {
        Ok(match value {
            DbValue::Null => "NULL".into(),
            DbValue::Binary { base64, .. } => {
                let bytes = STANDARD
                    .decode(base64)
                    .map_err(|_| DbErrorInfo::new("query", "无法解码二进制字段"))?;
                let hex = bytes.iter().map(|b| format!("{b:02x}")).collect::<String>();
                match self.dialect.dialect() {
                    Dialect::Postgres => format!("decode('{hex}', 'hex')"),
                    _ => format!("X'{hex}'"),
                }
            }
            DbValue::Bit { bits, .. } if self.dialect.dialect() != Dialect::Sqlite => {
                format!("B'{bits}'")
            }
            other => self.dialect.string_literal(&codec::export_cell(other)),
        })
    }

    pub fn footer(&self) -> &'static str {
        match self.format {
            ExportFormat::Json => "\n]\n",
            ExportFormat::Html => "</tbody></table></body></html>\n",
            ExportFormat::Xml => "</rows>\n",
            _ => "",
        }
    }
}

fn delimited(value: &str, separator: char) -> String {
    if value.is_empty() || value.contains([separator, '"', '\r', '\n']) {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.into()
    }
}
fn xml_char(c: char) -> bool {
    matches!(c, '\t' | '\r' | '\n' | '\u{20}'..='\u{d7ff}' | '\u{e000}'..='\u{fffd}' | '\u{10000}'..='\u{10ffff}')
}
fn escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

#[cfg(test)]
mod tests {
    use super::*;
    fn encoder(format: &str, engine: &str) -> ExportEncoder {
        let request: ExportRequest = serde_json::from_value(serde_json::json!({
            "profile_id":"test", "sql":"", "target_path":"unused",
            "format":format, "bom":true, "table":{"database":"main", "table":"a\"b"}
        }))
        .unwrap();
        ExportEncoder::new(
            &request,
            vec!["id".into(), "value".into()],
            SqlDialect::of(engine).unwrap(),
        )
        .unwrap()
    }
    fn text(s: &str) -> DbValue {
        DbValue::Text {
            value: s.into(),
            bytes: s.len(),
            truncated: false,
        }
    }

    #[test]
    fn delimited_preserves_null_empty_quotes_and_tabs() {
        let mut csv = encoder("csv", "sqlite");
        assert_eq!(csv.row(&[DbValue::Null, text("")]).unwrap(), ",\"\"\r\n");
        assert_eq!(
            csv.row(&[text("a,b"), text("c\"d\ne")]).unwrap(),
            "\"a,b\",\"c\"\"d\ne\"\r\n"
        );
        let mut tsv = encoder("tsv", "sqlite");
        assert_eq!(
            tsv.row(&[text("a\tb"), text("c")]).unwrap(),
            "\"a\tb\"\tc\r\n"
        );
        assert!(csv.header().starts_with('\u{feff}'));
    }

    #[test]
    fn json_stream_is_valid_empty_or_multiple_rows_and_exact_numbers_survive() {
        let mut json = encoder("json", "sqlite");
        let mut output = json.header();
        output += &json
            .row(&[
                DbValue::Int {
                    value: "9007199254740993".into(),
                    unsigned: false,
                },
                DbValue::Null,
            ])
            .unwrap();
        output += &json.row(&[text("line\n\"quoted\""), text("")]).unwrap();
        output += json.footer();
        let parsed: serde_json::Value = serde_json::from_str(&output).unwrap();
        assert_eq!(parsed[0]["id"], "9007199254740993");
        assert!(parsed[0]["value"].is_null());
        assert_eq!(parsed[1]["value"], "");
        let empty = encoder("json", "sqlite");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&(empty.header() + empty.footer())).unwrap(),
            serde_json::json!([])
        );
        let mut lines = encoder("jsonl", "sqlite");
        let line = lines.row(&[text("a\nb"), DbValue::Null]).unwrap();
        assert_eq!(line.lines().count(), 1);
        assert!(serde_json::from_str::<serde_json::Value>(&line).is_ok());
    }

    #[test]
    fn sql_uses_dialect_and_binary_literals() {
        let values = [
            text("O'Reilly\\x"),
            DbValue::Binary {
                base64: "AP8=".into(),
                bytes: 2,
                truncated: false,
            },
        ];
        let pg = encoder("sql", "postgres").row(&values).unwrap();
        assert!(pg.starts_with("INSERT INTO \"main\".\"a\"\"b\""));
        assert!(pg.contains("'O''Reilly\\x'"));
        assert!(pg.contains("decode('00ff', 'hex')"));
        let mysql = encoder("sql", "mysql").row(&values).unwrap();
        assert!(mysql.contains("`main`.`a\"b`"));
        assert!(mysql.contains("X'00ff'"));
        let sqlite = encoder("sql", "sqlite").row(&values).unwrap();
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE \"a\"\"b\" (id TEXT, value BLOB);")
            .unwrap();
        conn.execute_batch(&sqlite).unwrap();
        let actual: Vec<u8> = conn
            .query_row("SELECT value FROM \"a\"\"b\"", [], |r| r.get(0))
            .unwrap();
        assert_eq!(actual, vec![0, 255]);
    }

    #[test]
    fn markup_escapes_text_and_xml_control_characters_are_lossless() {
        let html = encoder("html", "sqlite")
            .row(&[text("<script>bad</script>"), DbValue::Null])
            .unwrap();
        assert!(!html.contains("<script>"));
        assert!(html.contains("&lt;script&gt;"));
        let xml = encoder("xml", "sqlite")
            .row(&[text("a\0b"), DbValue::Null])
            .unwrap();
        assert!(xml.contains("encoding=\"utf8-base64\">YQBi</field>"));
        assert!(xml.contains("null=\"true\""));
    }

    #[test]
    fn truncated_data_never_publishes_a_preview_as_a_complete_export() {
        let truncated = DbValue::Text {
            value: "preview".into(),
            bytes: 100,
            truncated: true,
        };
        assert!(encoder("json", "sqlite")
            .row(&[text("1"), truncated])
            .is_err());
    }
}
