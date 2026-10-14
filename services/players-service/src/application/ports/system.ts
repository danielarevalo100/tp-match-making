export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  generate(): string;
}

export interface PasswordHasher {
  hash(password: string): Promise<string>;
}
