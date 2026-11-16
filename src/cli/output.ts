import chalk from 'chalk';

export const printLine = (message: string): void => {
    console.log(message);
};

/** A note beside the answer, on standard error, so that a command's standard output stays the bare value a script reads */
export const printNote = (message: string): void => {
    console.error(message);
};

/**
 * The exit code of an interrupted run, 128 plus the number of the interrupt signal, as shells report it. An
 * interrupt while a command runs or waits for an answer ends the CLI with it, so that a script never reads an
 * abandoned command as a success.
 */
export const EXIT_INTERRUPTED = 130;

let errorCount = 0;

export const printError = (message: string): void => {
    errorCount++;
    console.error(chalk.red(`Error: ${message}`));
};

/** Number of errors printed so far; a one-shot command ends with exit code 1 when it printed one */
export const printedErrors = (): number => errorCount;

export const toErrorMessage = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);
