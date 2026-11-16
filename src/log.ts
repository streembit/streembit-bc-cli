/**
 * The wallet's logger: a user-facing CLI, so debug and info are silent unless STREEMBIT_DEBUG=1,
 * warnings and errors go to stderr. The command output itself is printed by the commands, not here.
 */

type Fields = Record<string, unknown> | undefined;

function line(level: string, message: string, fields: Fields): string {
    const suffix = fields && Object.keys(fields).length ? ` ${JSON.stringify(fields, (_key, value) => value instanceof Error ? value.message : value)}` : '';
    return `[${level}] ${message}${suffix}`;
}

function verbose(): boolean {
    return process.env.STREEMBIT_DEBUG === '1';
}

export const logger = {
    debug(message: string, fields?: Fields): void {
        if (verbose()) console.error(line('debug', message, fields));
    },
    info(message: string, fields?: Fields): void {
        if (verbose()) console.error(line('info', message, fields));
    },
    warn(message: string, fields?: Fields): void {
        console.error(line('warn', message, fields));
    },
    error(message: string, fields?: Fields): void {
        console.error(line('error', message, fields));
    }
};
