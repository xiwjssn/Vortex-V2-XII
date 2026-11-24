if (!process.env.NODE_ENV) process.env.NODE_ENV = process.env.SERVER_PORT ? 'production' : 'development';
const path = require('node:path');
const fs = require('node:fs/promises');
const { startDashboard } = require('./dashboard/server');
const { createBotRuntime } = require('./utils/botRuntime');
const { createLogger } = require('./utils/logger');
const { loadConfig } = require('./utils/config');
const { preparePersistentDataDirectory } = require('./utils/persistentData');

let appLogger = null;

async function prepareDataDirectory() {
  if (!process.env.DATA_DIR) return;
  await preparePersistentDataDirectory(path.join(__dirname, 'data'), process.env.DATA_DIR);
}

async function main() {
  appLogger = createLogger();
  await prepareDataDirectory();
  const config = loadConfig();
  // Remove only the retired secondary-account session directory from persistent storage.
  await fs.rm(path.join(config.dataDir, 'account-2'), { recursive: true, force: true });
  const runtime = createBotRuntime({ config, logger: appLogger });
  const server = await startDashboard({ config, logger: appLogger, runtime });
  await runtime.start().catch(err => appLogger.error('BOT_START_FAILED', { account: 1, error: err.message }));

  let shuttingDown = false;
  const shutdown = async signal => {
    if (shuttingDown) return;
    shuttingDown = true;
    appLogger.info('SHUTDOWN_REQUESTED', { signal });
    await runtime.stop().catch(err => appLogger.warn('BOT_STOP_FAILED', { account: 1, error: err.message }));
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

process.on('uncaughtException', error => {
  appLogger?.error('UNCAUGHT_EXCEPTION', { error: String(error?.stack || error).slice(0, 1200) });
  process.exit(1);
});
process.on('unhandledRejection', reason => {
  appLogger?.error('UNHANDLED_REJECTION', { error: String(reason?.stack || reason).slice(0, 1200) });
  process.exit(1);
});

main().catch(err => {
  appLogger?.error('FATAL_STARTUP_ERROR', { error: String(err?.stack || err).slice(0, 1200) });
  process.exit(1);
});
