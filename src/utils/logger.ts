import winston from 'winston';
import path from 'path';

export const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level, message, ...rest }) => {
          const extra = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : '';
          return `${timestamp} [${level}] ${message}${extra}`;
        })
      ),
    }),
    new winston.transports.File({
      filename: path.resolve(__dirname, '..', '..', 'data', 'bot.log'),
      maxsize: 10 * 1024 * 1024,
      maxFiles: 3,
    }),
  ],
});
