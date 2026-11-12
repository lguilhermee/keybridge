//! Local JSONL adapter for the production refusal detector. No network access.
#[path = "../src/run/refusal_reply/detection.rs"]
mod detection;

use std::io::{self, BufRead, Write};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let stdout = io::stdout();
    let mut output = io::BufWriter::new(stdout.lock());
    for line in io::stdin().lock().lines() {
        let value: serde_json::Value = serde_json::from_str(&line?)?;
        let text = value["text"].as_str().ok_or("missing text")?;
        serde_json::to_writer(
            &mut output,
            &serde_json::json!({
                "id": value["id"],
                "refusal": detection::is_refusal(text),
                "prose": detection::assistant_prose(text),
            }),
        )?;
        writeln!(output)?;
        output.flush()?;
    }
    Ok(())
}
