/**
 * Imported first by the CLI so Node 22's "SQLite is an experimental feature"
 * warning does not land on every user's terminal. Library users keep Node's
 * default behaviour.
 */
const original = process.emitWarning.bind(process);
(process as { emitWarning: typeof process.emitWarning }).emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === "string" ? warning : warning.message;
  if (text.includes("SQLite is an experimental feature")) return;
  return (original as (...args: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;
export {};
