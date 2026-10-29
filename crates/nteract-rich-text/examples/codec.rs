//! Line-delimited JSON harness for native/WASM compatibility qualification.
use std::io::{self, BufRead, Write};

fn main() -> io::Result<()> {
    let stdin = io::stdin();
    let mut stdout = io::BufWriter::new(io::stdout().lock());
    for line in stdin.lock().lines() {
        let line = line?;
        writeln!(
            stdout,
            "{}",
            nteract_rich_text::process_json(line.as_bytes())
        )?;
        stdout.flush()?;
    }
    Ok(())
}
