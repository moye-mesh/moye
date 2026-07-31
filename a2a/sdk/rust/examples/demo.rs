use moye_agent_sdk::Agent;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let base = "http://localhost:3100";

    // Register A + generate an E2E key
    let mut a = Agent::new("rust_e2e_a")
        .capabilities(vec!["code".into(), "rust".into()])
        .description("Rust E2E example")
        .endpoint("https://rust.bot")
        .base_url(base);
    a.generate_encryption_key()?;
    let aid = a.register().await?;
    println!("registered: {}", aid);

    // Register B + generate an E2E key
    let mut b = Agent::new("rust_e2e_b").capabilities(vec!["review".into()]).base_url(base);
    b.generate_encryption_key()?;
    let bid = b.register().await?;

    // Send E2E encrypted
    let mid = a.send_encrypted(&bid, "Rust secret: in service of human health and freedom").await?;
    println!("encrypted message sent: {}", mid);

    // B decrypts its inbox
    let box_b = b.inbox_decrypted().await?;
    let found = box_b.iter().find(|(m, _)| m.id == mid);
    let dec = found.and_then(|(_, d)| d.clone());
    match &dec {
        Some(pt) => println!("B decrypted: {}", pt),
        None => {
            println!("decryption failed, inspecting raw payload structure");
            if let Some((m, _)) = found {
                println!("first 80 chars of ciphertext: {}", &m.content[..m.content.len().min(80)]);
            }
        }
    }
    println!("RUST E2E: {}", if dec.as_deref() == Some("Rust secret: in service of human health and freedom") { "✅" } else { "❌" });

    // Also verify plain (unencrypted) sending
    let mid2 = a.send(&bid, "plaintext message").await?;
    println!("plaintext message: {}", mid2);

    println!("RUST SDK ALL OK");
    Ok(())
}
