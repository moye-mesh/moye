use moye_agent_sdk::Agent;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let base = "http://localhost:3924";

    let mut issuer = Agent::new("rust-issuer").base_url(base);
    issuer.generate_identity()?;
    issuer.register().await?;

    let mut subject = Agent::new("rust-subject").base_url(base);
    subject.generate_identity()?;
    subject.register().await?;
    let subject_did = subject.did().unwrap().to_string();

    let claim = serde_json::json!({
        "type": "contribution-endorsement", "kind": "relay", "period": "2026-07", "metric": 11
    });
    let issue_result = issuer.issue_credential(&subject_did, claim, None).await?;
    println!("issue result: {}", issue_result);

    let creds = subject.credentials(None).await?;
    println!("credentials: {}", serde_json::to_string(&creds)?);
    assert_eq!(creds.len(), 1, "expected exactly one credential");
    assert_eq!(creds[0]["verified"], serde_json::json!(true), "expected verified=true");
    println!("OK: exactly one credential, verified=true");

    // No-DID agent should be rejected client-side
    let no_did = Agent::new("rust-no-did").base_url(base);
    match no_did.issue_credential(&subject_did, serde_json::json!({"type": "x"}), None).await {
        Err(e) => println!("correctly rejected issuing without a DID: {}", e),
        Ok(_) => panic!("FAIL: should have been rejected"),
    }

    Ok(())
}
