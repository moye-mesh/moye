use moye_agent_sdk::Agent;
use std::time::Duration;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let seeds = ["http://localhost:19999", "http://localhost:3926"];

    let picked = Agent::pick_reachable_base_url(&seeds, Duration::from_millis(1500)).await?;
    println!("picked (expect localhost:3926): {}", picked);

    let mut agent = Agent::new("rust-bootstrap-test");
    agent.bootstrap(&seeds, Duration::from_millis(1500)).await?;
    agent.generate_identity()?;
    let id = agent.register().await?;
    println!("registered via fallback base_url: {}", id);

    match Agent::pick_reachable_base_url(&["http://localhost:19999", "http://localhost:19998"], Duration::from_millis(800)).await {
        Err(e) => println!("correctly errored when all seeds dead: {}", e),
        Ok(_) => panic!("FAIL: should have errored"),
    }

    Ok(())
}
