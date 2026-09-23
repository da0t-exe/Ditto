const time = () => new Date().toISOString().slice(11, 19);

export const log = {
  info: (scope: string, ...args: unknown[]) => console.log(time(), `[${scope}]`, ...args),
  warn: (scope: string, ...args: unknown[]) => console.warn(time(), `[${scope}]`, ...args),
  error: (scope: string, ...args: unknown[]) => console.error(time(), `[${scope}]`, ...args),
};
