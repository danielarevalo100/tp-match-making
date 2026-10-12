export type AppConfig = {
  nodeEnv: "development" | "test" | "production";
  port: number;
  serviceName: string;
};

const validEnvironments = new Set<AppConfig["nodeEnv"]>([
  "development",
  "test",
  "production",
]);

export function loadConfig(environment = process.env): AppConfig {
  const port = Number(environment.PORT ?? "3000");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }

  const nodeEnv = environment.NODE_ENV ?? "development";
  if (!validEnvironments.has(nodeEnv as AppConfig["nodeEnv"])) {
    throw new Error("NODE_ENV must be development, test, or production.");
  }

  const serviceName = environment.SERVICE_NAME?.trim() || "template-service";

  return {
    nodeEnv: nodeEnv as AppConfig["nodeEnv"],
    port,
    serviceName,
  };
}
