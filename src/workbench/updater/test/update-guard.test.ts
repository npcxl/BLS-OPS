import { describe, expect, it } from "vitest";
import { collectRestartBlockers, hasBlockingActivity } from "../update-guard";
import { countTickets, useActivityStore } from "@/stores/activity-store";

const emptyActivity = () => countTickets({});

describe("collectRestartBlockers", () => {
  it("reports nothing when the app is idle", () => {
    const blockers = collectRestartBlockers({
      connectedSessions: 0,
      connectingSessions: 0,
      activity: emptyActivity(),
    });
    expect(blockers).toEqual([]);
    expect(hasBlockingActivity(blockers)).toBe(false);
  });

  it("blocks on live SSH sessions", () => {
    const blockers = collectRestartBlockers({
      connectedSessions: 2,
      connectingSessions: 0,
      activity: emptyActivity(),
    });
    expect(blockers).toEqual([{ key: "{{count}} active SSH sessions", count: 2 }]);
    expect(hasBlockingActivity(blockers)).toBe(true);
  });

  it("blocks on unsaved remote files", () => {
    useActivityStore.setState({ tickets: { a: { id: "a", kind: "editor" } } });
    const blockers = collectRestartBlockers({
      connectedSessions: 0,
      connectingSessions: 0,
      activity: countTickets(useActivityStore.getState().tickets),
    });
    expect(blockers).toEqual([{ key: "{{count}} files have unsaved changes", count: 1 }]);
    useActivityStore.setState({ tickets: {} });
  });

  it("lists every kind of work, sessions first", () => {
    useActivityStore.setState({
      tickets: {
        t1: { id: "t1", kind: "transfer" },
        t2: { id: "t2", kind: "command" },
        t3: { id: "t3", kind: "long_task" },
      },
    });
    const blockers = collectRestartBlockers({
      connectedSessions: 1,
      connectingSessions: 1,
      activity: countTickets(useActivityStore.getState().tickets),
    });

    expect(blockers.map((blocker) => blocker.key)).toEqual([
      "{{count}} active SSH sessions",
      "{{count}} SSH connections still being established",
      "{{count}} commands are still running",
      "{{count}} file transfers in progress",
      "{{count}} long-running tasks",
    ]);
    useActivityStore.setState({ tickets: {} });
  });

  it("aggregates several tickets of the same kind", () => {
    useActivityStore.setState({
      tickets: { a: { id: "a", kind: "transfer" }, b: { id: "b", kind: "transfer" } },
    });
    const activity = countTickets(useActivityStore.getState().tickets);
    expect(activity.transfer).toBe(2);
    useActivityStore.setState({ tickets: {} });
  });
});
