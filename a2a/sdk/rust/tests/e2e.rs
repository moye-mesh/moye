use moye_agent_sdk::Agent;

#[tokio::test]
async fn self_roundtrip() {
    let base = "http://localhost:3100";
    let mut a = Agent::new("t_a").base_url(base);
    a.generate_encryption_key().unwrap();
    a.register().await.unwrap();
    let mut b = Agent::new("t_b").base_url(base);
    b.generate_encryption_key().unwrap();
    b.register().await.unwrap();
    let mid = a.send_encrypted(&b.agent_id().unwrap(), "hello rust e2e").await.unwrap();
    let box_b = b.inbox_decrypted().await.unwrap();
    let dec = box_b.iter().find(|(m, _)| m.id == mid).and_then(|(_, d)| d.clone());
    assert_eq!(dec.as_deref(), Some("hello rust e2e"));
}
