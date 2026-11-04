const ENGINES = {
  mongo: (env) => ({
    command: "mongosh",
    args: [
      "--username",
      env.MONGO_ROOT_USERNAME,
      "--password",
      env.MONGO_ROOT_PASSWORD,
      "--authenticationDatabase",
      "admin",
      "mongodb://mongodb:27017/gaming",
    ],
  }),
  redis: () => ({ command: "redis-cli", args: ["-h", "redis"] }),
  cassandra: () => ({ command: "cqlsh", args: ["cassandra", "9042", "-k", "gaming"] }),
  neo4j: (env) => ({
    command: "cypher-shell",
    args: ["-a", "bolt://neo4j:7687"],
    env: { NEO4J_USERNAME: env.NEO4J_USERNAME, NEO4J_PASSWORD: env.NEO4J_PASSWORD },
  }),
};

export function buildEngineCommand(engine, env) {
  if (!Object.hasOwn(ENGINES, engine)) return null;
  const { command, args, env: engineEnv } = ENGINES[engine](env);
  return {
    command,
    args,
    env: { PATH: env.PATH, HOME: env.HOME, LANG: env.LANG, ...engineEnv },
  };
}
