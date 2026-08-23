// Minimal structured logger — no heavy observability stack for V1, just
// consistent, greppable lines with a level and timestamp.
function line(level, msg, meta) {
  const ts = new Date().toISOString();
  const metaStr = meta ? ' ' + JSON.stringify(meta) : '';
  console.log(`[${ts}] [${level}] ${msg}${metaStr}`);
}

export const logger = {
  info: (msg, meta) => line('INFO', msg, meta),
  warn: (msg, meta) => line('WARN', msg, meta),
  error: (msg, meta) => line('ERROR', msg, meta),
};
