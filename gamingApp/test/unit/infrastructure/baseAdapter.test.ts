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

  execute<T>(step: string, operation: () => Promise<T>): Promise<T> {
    return this.run(step, operation);
  }
}

describe("BaseAdapter", () => {
  const adapter = new TestAdapter();

  it("returns the operation result", async () => {
    assert.equal(await adapter.execute("test.ok", async () => 42), 42);
  });

  it("fails before running the operation when the step matches failAt", async () => {
    let executed = false;
    const execution = requestContext.run({ failAt: "test.step" }, () =>
      adapter.execute("test.step", async () => {
        executed = true;
      }),
    );

    await assert.rejects(execution, (error: unknown) => {
      assert.ok(error instanceof InjectedFailureError);
      assert.equal(error.step, "test.step");
      return true;
    });
    assert.equal(executed, false);
  });

  it("runs other steps when failAt targets a different step", async () => {
    const result = await requestContext.run({ failAt: "test.other" }, () =>
      adapter.execute("test.step", async () => "done"),
    );

    assert.equal(result, "done");
  });

  it("wraps driver errors in a StorageError", async () => {
    const cause = new DriverError("connection lost");

    await assert.rejects(
      adapter.execute("test.driver", async () => {
        throw cause;
      }),
      (error: unknown) => {
        assert.ok(error instanceof StorageError);
        assert.equal(error.engine, "redis");
        assert.equal(error.step, "test.driver");
        assert.equal(error.cause, cause);
        return true;
      },
    );
  });

  it("rethrows non-driver errors unchanged", async () => {
    const domainError = new Error("domain rule");

    await assert.rejects(
      adapter.execute("test.domain", async () => {
        throw domainError;
      }),
      (error: unknown) => error === domainError,
    );
  });
});
