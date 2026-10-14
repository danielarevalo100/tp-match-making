import { randomUUID } from "node:crypto";

import type { Clock, IdGenerator } from "../../application/ports/system.js";

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export class UuidGenerator implements IdGenerator {
  generate(): string {
    return randomUUID();
  }
}
