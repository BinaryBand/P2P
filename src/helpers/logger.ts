import winston, { Logger } from "winston";

export { Logger };

const loggers = new Map<string, Logger>();

export function getLogger(name: string): Logger {
  let logger: Logger | undefined = loggers.get(name);

  if (!logger) {
    logger = winston.createLogger({
      level: "info",
      format: winston.format.json(),
      transports: [new winston.transports.File({ dirname: "storage/logs", filename: `${name}.log` })],
    });
    loggers.set(name, logger);
  }

  return logger;
}
