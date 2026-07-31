use moye_agent_sdk::Agent;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let base = "http://localhost:3981";

    let mut agent = Agent::new("rust-resolve-did-test").base_url(base);
    agent.generate_identity()?;
    agent.register().await?;
    let did = agent.did().unwrap().to_string();
    println!("registered with did: {}", did);

    let r = Agent::resolve_did(&did, base).await?;
    println!("resolve_did (known DID): {}", r);
    assert_eq!(r["found"], serde_json::json!(true));
    assert_eq!(r["via"], serde_json::json!("local"));
    println!("OK: found via local fast path");

    let r2 = Agent::resolve_did("did:moye:nonexistent-fake-rust-test", base).await?;
    println!("resolve_did (unknown DID): {}", r2);
    assert_eq!(r2["found"], serde_json::json!(false));
    println!("OK: gracefully not found, no panic/hang");

    Ok(())
}
