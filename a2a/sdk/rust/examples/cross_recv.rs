use moye_agent_sdk::Agent;
use std::fs;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let base = "http://localhost:3100";
    // Rust registers as the receiver and generates a key
    let mut rust = Agent::new("rust_recv_x").base_url(base);
    rust.generate_encryption_key()?;
    let rid = rust.register().await?;
    fs::write("/tmp/rust_recv_id.txt", &rid)?;
    println!("RUST_RECV_ID={}", rid);

    // Poll the inbox, find any encrypted message and decrypt it
    let mut got = None;
    for _ in 0..50 {
        let box_r = rust.inbox_decrypted().await?;
        if let Some((m, d)) = box_r.iter().find(|(m, _)| m.encrypted) {
            got = Some((m.id.clone(), d.clone()));
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    }
    match got {
        Some((_mid, dec)) => {
            let pt = dec.clone().unwrap_or_default();
            println!("RUST_DECRYPTED={}", pt);
            println!("CROSS_PY_TO_RUST={}", if pt == "cross-language secret: in service of human health and freedom" { "OK" } else { "FAIL" });
        }
        None => println!("CROSS_PY_TO_RUST=FAIL(no encrypted msg)"),
    }
    Ok(())
}
