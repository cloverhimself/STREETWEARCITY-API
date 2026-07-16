import { app } from "./app";
import { env } from "./lib/env";
import { logger } from "./lib/logger";

app.listen(env.PORT, () => {
  logger.info(`streetwarecity-api listening on port ${env.PORT} (${env.NODE_ENV})`);
});
