import { assertEquals } from "std/assert";
import { startTestServer, stopTestServer, TestSSEClient } from "./setup.ts";
import { delay } from "../test-utils.ts";

Deno.test("E2E - Full session flow with DJ and judges", async () => {
  const server = await startTestServer();

  // breakpoint: pause here when running with inspector to inspect test startup

  try {
    // Seed test data
    //const sessionId = await seedTestData(server.url);
    const sessionId = 1;
    // Create clients
    const dj = new TestSSEClient("dj0", "dj", server.url);
    const judge1 = new TestSSEClient("judge2", "judge", server.url);
    const judge2 = new TestSSEClient("judge3", "judge", server.url);
    const scoreboard = new TestSSEClient("sb10", "sb", server.url);

    // Connect all clients
    await Promise.all([
      dj.connect(sessionId),
      judge1.connect(sessionId),
      judge2.connect(sessionId),
      scoreboard.connect(sessionId),
    ]);

    console.log("All clients connected");

    // Wait for client_status messages
    await Promise.all([
      dj.waitForMessage("client_status"),
      judge1.waitForMessage("client_status"),
      judge2.waitForMessage("client_status"),
      scoreboard.waitForMessage("client_status"),
    ]);

    console.log("Client status received");

    // Start the session
    const startResponse = await fetch(
      `${server.url}/sessions/${sessionId}/start`,
      { method: "POST" },
    );
    assertEquals(startResponse.ok, true);

    console.log("Session started");

    // Wait for competition_start
    const compStart = await dj.waitForMessage("competition_start");
    assertEquals(compStart.competition.id, 10);

    console.log("Competition started");

    // Wait for first performance_start
    const perfStart = await dj.waitForMessage("performance_start");
    assertEquals(perfStart.position, 0);

    console.log("Performance started for position 0");

    // DJ completes performance
    await dj.completePerformance(sessionId, 10, 0, true);

    console.log("Performance completed");

    // Wait for enable_scoring
    await Promise.all([
      judge1.waitForMessage("enable_scoring"),
      judge2.waitForMessage("enable_scoring"),
    ]);

    console.log("Scoring enabled");

    // Judges submit scores
    await Promise.all([
      judge1.submitScores(sessionId, 10, 100, [
        { criteria_id: 1, score: 8.5 },
        { criteria_id: 2, score: 9.0 },
      ]),
      judge2.submitScores(sessionId, 10, 100, [
        { criteria_id: 1, score: 7.5 },
        { criteria_id: 2, score: 8.0 },
      ]),
    ]);

    console.log("Scores submitted");

    // Scoreboard should receive score updates
    const score1 = await scoreboard.waitForMessage("score_update");
    const score2 = await scoreboard.waitForMessage("score_update");

    assertEquals(
      score1.judge_id === "judge2" || score1.judge_id === "judge3",
      true,
    );
    assertEquals(
      score2.judge_id === "judge2" || score2.judge_id === "judge3",
      true,
    );

    console.log("Score updates received");

    // Wait for second competitor
    const perfStart2 = await dj.waitForMessage("performance_start");
    assertEquals(perfStart2.position, 1);

    // Complete second performance
    await dj.completePerformance(sessionId, 10, 1, true);

    // Submit scores for second competitor
    await Promise.all([
      judge1.submitScores(sessionId, 10, 101, [
        { criteria_id: 1, score: 9.0 },
        { criteria_id: 2, score: 8.5 },
      ]),
      judge2.submitScores(sessionId, 10, 101, [
        { criteria_id: 1, score: 8.0 },
        { criteria_id: 2, score: 8.5 },
      ]),
    ]);

    console.log("Second competitor completed");

    // Disconnect all clients
    dj.disconnect();
    judge1.disconnect();
    judge2.disconnect();
    scoreboard.disconnect();

    console.log("E2E test completed successfully");
  } finally {
    await stopTestServer(server);
  }
});
Deno.test("E2E - Judge reconnection during scoring", async () => {
  const server = await startTestServer();

  try {
    const sessionId = 1;

    const dj = new TestSSEClient("dj0", "dj", server.url);
    const judge1 = new TestSSEClient("judge2", "judge", server.url);
    const judge2 = new TestSSEClient("judge3", "judge", server.url);

    // Connect clients
    await Promise.all([
      dj.connect(sessionId),
      judge1.connect(sessionId),
      judge2.connect(sessionId),
    ]);

    // Start session
    await fetch(`${server.url}/sessions/${sessionId}/start`, {
      method: "POST",
    });

    // Wait for performance and complete it
    await dj.waitForMessage("competition_start");
    await dj.waitForMessage("performance_start");
    await dj.completePerformance(sessionId, 10, 0, true);

    // Wait for scoring to be enabled
    await judge1.waitForMessage("enable_scoring");
    await judge2.waitForMessage("enable_scoring");

    // Judge 1 submits, judge 2 disconnects before submitting
    await judge1.submitScores(sessionId, 10, 100, [
      { criteria_id: 1, score: 8.5 },
      { criteria_id: 2, score: 9.0 },
    ]);

    // Disconnect judge 2
    judge2.disconnect();

    console.log("Judge 2 disconnected");

    // Wait a bit
    await delay(100);

    // Reconnect judge 2
    const judge2Reconnected = new TestSSEClient("judge3", "judge", server.url);
    await judge2Reconnected.connect(sessionId);

    console.log("Judge 2 reconnected");

    // Should receive enable_scoring again (recovery)
    const enableScoring = await judge2Reconnected.waitForMessage(
      "enable_scoring",
    );
    assertEquals(enableScoring.competition_id, 10);

    console.log("Judge 2 received recovery message");

    // Now submit scores
    await judge2Reconnected.submitScores(sessionId, 10, 100, [
      { criteria_id: 1, score: 7.5 },
      { criteria_id: 2, score: 8.0 },
    ]);

    console.log("Judge 2 submitted after reconnection");

    // Cleanup
    dj.disconnect();
    judge1.disconnect();
    judge2Reconnected.disconnect();
  } finally {
    await stopTestServer(server);
  }
});
Deno.test("E2E - DJ reconnection during performance", async () => {
  const server = await startTestServer();

  try {
    const sessionId = 1;

    const dj = new TestSSEClient("dj0", "dj", server.url);
    const judge1 = new TestSSEClient("judge2", "judge", server.url);
    const judge2 = new TestSSEClient("judge3", "judge", server.url);

    // Connect and start
    await Promise.all([
      dj.connect(sessionId),
      judge1.connect(sessionId),
      judge2.connect(sessionId),
    ]);

    await fetch(`${server.url}/sessions/${sessionId}/start`, {
      method: "POST",
    });

    await dj.waitForMessage("competition_start");
    await dj.waitForMessage("performance_start");

    // DJ disconnects during performance
    dj.disconnect();
    console.log("DJ disconnected during performance");

    await delay(100);

    // DJ reconnects
    const djReconnected = new TestSSEClient("dj0", "dj", server.url);
    await djReconnected.connect(sessionId);
    console.log("DJ reconnected");

    // Should receive performance_recovery
    const recovery = await djReconnected.waitForMessage("performance_recovery");
    assertEquals(recovery.competition_id, 10);
    assertEquals(recovery.position, 0);

    console.log("DJ received recovery message");

    // Complete performance
    await djReconnected.completePerformance(sessionId, 10, 0, true);

    // Cleanup
    djReconnected.disconnect();
    judge1.disconnect();
    judge2.disconnect();
  } finally {
    await stopTestServer(server);
  }
});
