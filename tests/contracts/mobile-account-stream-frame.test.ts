import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { queryKeys, refetchAccountOnFrame } from "../../packages/shared/src/api/hooks.ts";

/**
 * The account stream sends {accounts, asOf} with raw display rows; the screens read the enriched
 * /v1/broker-auth/icici/account body. A frame must therefore never be written into the caches (that
 * blanked Portfolio and Orders for up to the two-minute safety poll right after a fill). It only
 * triggers one REST re-read.
 */
const hooks = readFileSync(resolve(__dirname, "../../packages/shared/src/api/hooks.ts"), "utf8");

const rows = [{ symbol: "NIFTY" }];

describe("account stream frames", () => {
  it("never write the streamed body into the account or positions caches", () => {
    const stream = hooks.slice(hooks.indexOf("const useAccountStream"), hooks.indexOf("const accountPoll"));
    expect(stream).toContain("refetchAccountOnFrame(queryClient)");
    expect(stream).not.toContain("setQueryData");
  });

  it("re-reads open positions when only the positions screen is mounted", async () => {
    const client = new QueryClient();
    const read = vi.fn(async () => rows);
    const observer = new QueryObserver(client, { queryKey: queryKeys.positions.open(), queryFn: read });
    const stop = observer.subscribe(() => {});
    await vi.waitFor(() => expect(client.getQueryData(queryKeys.positions.open())).toEqual(rows));
    await refetchAccountOnFrame(client);
    expect(read).toHaveBeenCalledTimes(2);
    expect(client.getQueryData(queryKeys.positions.open())).toEqual(rows);
    stop();
  });

  it("re-reads the account once (not both endpoints) when a screen holds the account query", async () => {
    const client = new QueryClient();
    const account = vi.fn(async () => {
      client.setQueryData(queryKeys.positions.open(), rows);
      return { sections: {} };
    });
    const positions = vi.fn(async () => rows);
    const a = new QueryObserver(client, { queryKey: queryKeys.brokerAccount.icici(), queryFn: account });
    const p = new QueryObserver(client, { queryKey: queryKeys.positions.open(), queryFn: positions });
    const stops = [a.subscribe(() => {}), p.subscribe(() => {})];
    await vi.waitFor(() => expect(account).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(positions).toHaveBeenCalledTimes(1));
    await refetchAccountOnFrame(client);
    expect(account).toHaveBeenCalledTimes(2);
    expect(positions).toHaveBeenCalledTimes(1);
    expect(client.getQueryData(queryKeys.positions.open())).toEqual(rows);
    stops.forEach((s) => s());
  });
});
