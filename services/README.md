# Application services

Application services will live in this directory after the team confirms the implementation language, business boundaries, APIs, and persistence access patterns.

Each service added here should include:

- a clearly documented business responsibility;
- a `Dockerfile` and local run instructions;
- configuration through environment variables;
- dependency connection retries;
- tests and, for APIs, a health endpoint;
- only the database access it actually needs.

Avoid creating empty services solely to mirror a preliminary architecture diagram.

## Starting a new Node.js service

Copy [`template-service`](template-service/) and follow its README. The template is intentionally database-neutral so each new service adds only the clients and connection variables it needs.

## Implemented services

- [`players-service`](players-service/) — player registration, profile queries and account lifecycle management backed by MongoDB.
- [`matchmaking-service`](matchmaking-service/) — matchmaking queue entry (problem 1): validates against MongoDB and keeps the live queues in Redis.
