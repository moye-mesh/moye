use moye_agent_sdk::Agent;

// Verifies the Rust SDK's DID identity auth (previously unimplemented in the Rust SDK, which only supported Bearer tokens).
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let base = std::env::var("MOYE_ENDPOINT").unwrap_or_else(|_| "http://localhost:3100".into());
    let base = base.as_str();

    let mut a = Agent::new("rust_did_a").base_url(base);
    let did = a.generate_identity()?;
    println!("generated identity: {}", did);
    let aid = a.register().await?;
    println!("registered (with pubkey): id={} did={:?}", aid, a.did());
    assert_eq!(a.did(), Some(did.as_str()));

    let mut b = Agent::new("rust_did_b").base_url(base);
    b.generate_identity()?;
    let bid = b.register().await?;

    // Sends with a DID signature (instead of a Bearer token) -- the server should verify it via X-Moye-Did/X-Moye-Sig
    let mid = a.send(&bid, "hello via DID signature").await?;
    println!("sent via DID signature: {}", mid);

    let inbox = b.inbox().await?;
    let found = inbox.iter().find(|m| m.id == mid);
    println!(
        "RUST DID AUTH: {}",
        if found.is_some() { "✅" } else { "❌ message not found in inbox" }
    );

    // Creates a room + assigns a task + reports back using DID signatures, exercising the full path
    let room_id = a.create_room("rust-did-room", vec![bid.clone()]).await?;
    let task_ids = a.assign_task(&room_id, "rust did task", vec![bid.clone()]).await?;
    b.report(&room_id, &task_ids[0], "done via DID").await?;
    let room = a.room(&room_id).await?;
    let task = room.tasks.iter().find(|t| t.id == task_ids[0]);
    println!(
        "RUST DID ROOM/TASK/REPORT: {}",
        if task.map(|t| t.status == "done").unwrap_or(false) { "✅" } else { "❌" }
    );

    println!("RUST DID SDK ALL OK");
    Ok(())
}
