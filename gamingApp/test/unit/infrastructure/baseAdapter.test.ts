import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BaseAdapter } from "../../../src/infrastructure/baseAdapter.js";
import { InjectedFailureError, StorageError } from "../../../src/shared/errors.js";
import { requestContext } from "../../../src/shared/requestContext.js";

class DriverError extends Error {}

class TestAdapter extends BaseAdapter {
  protected readonly engine = "redis";

  protected isDriverError(error: unknown): boolean {
    return error instanceof DriverError;
  }

  readOperation<T>(operation: () => Promise<T>): Promise<T> {
    return this.read(operation);
  }

  writeOperation<T>(operation: () => Promise<T>): Promise<T> {
    return this.write(operation);
  }
}

describe("BaseAdapter", () => {
  const adapter = new TestAdapter();

  it("returns the operation result", async () => {
    assert.equal(await adapter.readOperation(async () => 42), 42);
    assert.equal(await adapter.writeOperation(async () => 43), 43);
  });

  it("fails only the first write to the requested database, before running it", async () => {
    const executed: string[] = [];
    await requestContext.run({ failDb: "redis" }, async () => {
      await adapter.readOperation(async () => executed.push("read"));
      await assert.rejects(
        adapter.writeOperation(async () => executed.push("first write")),
        (error: unknown) => error instanceof InjectedFailureError && error.engine === "redis",
      );
      await adapter.writeOperation(async () => executed.push("second write"));
    });

    assert.deepEqual(executed, ["read", "second write"]);
  });

  it("does not fail writes to other databases", async () => {
    const result = await requestContext.run({ failDb: "mongo" }, () =>
      adapter.writeOperation(async () => "done"),
    );

    assert.equal(result, "done");
  });

  it("wraps driver errors in a StorageError", async () => {
    const cause = new DriverError("connection lost");

    await assert.rejects(
      adapter.readOperation(async () => {
        throw cause;
      }),
      (error: unknown) => {
        assert.ok(error instanceof StorageError);
        assert.equal(error.engine, "redis");
        assert.equal(error.cause, cause);
        return true;
      },
    );
  });

  it("rethrows non-driver errors unchanged", async () => {
    const domainError = new Error("domain rule");

    await assert.rejects(
      adapter.writeOperation(async () => {
        throw domainError;
      }),
      (error: unknown) => error === domainError,
    );
  });
});
