use moye_agent_sdk::Agent;
use std::fs;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let base = "http://localhost:3100";
    let mut rust = Agent::new("rust_send_node").base_url(base);
    rust.generate_encryption_key()?;
    let sid = rust.register().await?;
    println!("RUST_SEND_ID={}", sid);

    // Wait for the Node receiver to finish registering
    let node_id = loop {
        if let Ok(s) = fs::read_to_string("/tmp/node_recv_id.txt") {
            if !s.trim().is_empty() { break s.trim().to_string(); }
        }
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    };
    println!("NODE_RECV_ID={}", node_id);

    let mid = rust.send_encrypted(&node_id, "Rust-to-Node secret: in service of human health and freedom").await?;
    println!("RUST_SENT_MID={}", mid);
    Ok(())
}
