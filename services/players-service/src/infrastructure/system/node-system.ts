import { randomBytes, randomUUID, scrypt } from "node:crypto";

import type { Clock, IdGenerator, PasswordHasher } from "../../application/ports/system.js";

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

export class ScryptPasswordHasher implements PasswordHasher {
  private readonly cost = 16_384;
  private readonly blockSize = 8;
  private readonly parallelization = 1;
  private readonly keyLength = 64;

  async hash(password: string): Promise<string> {
    const salt = randomBytes(16);
    const derivedKey = await new Promise<Buffer>((resolve, reject) => {
      scrypt(
        password,
        salt,
        this.keyLength,
        {
          N: this.cost,
          maxmem: 64 * 1024 * 1024,
          p: this.parallelization,
          r: this.blockSize,
        },
        (error, key) => {
          if (error) reject(error);
          else resolve(key);
        },
      );
    });

    return [
      "scrypt",
      this.cost,
      this.blockSize,
      this.parallelization,
      salt.toString("base64url"),
      derivedKey.toString("base64url"),
    ].join("$");
  }
}
