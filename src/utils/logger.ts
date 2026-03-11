import winston from 'winston';

const JSON_FORMAT = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DDTHH:mm:ss.SSSZ' }),
  winston.format.errors({ stack: true }),
  winston.format.json(),
);

const CONSOLE_FORMAT = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.colorize(),
  winston.format.printf(({ timestamp, level, message, stack, ...meta }) => {
    const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    const base = `[${timestamp as string}] ${level}: ${message as string}${metaStr}`;
    return stack ? `${base}\n${stack as string}` : base;
  }),
);

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL ?? 'info',
  defaultMeta: { service: 'printpilot' },
  transports: [
    new winston.transports.Console({
      format: CONSOLE_FORMAT,
    }),
    new winston.transports.File({
      filename: 'state/logs/printpilot.log',
      format: JSON_FORMAT,
      maxsize: 5_242_880,
      maxFiles: 5,
    }),
    new winston.transports.File({
      filename: 'state/logs/error.log',
      format: JSON_FORMAT,
      level: 'error',
      maxsize: 5_242_880,
      maxFiles: 3,
    }),
  ],
});

export default logger;
